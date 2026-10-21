import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, PROJECT_CONTEXT_TOOL_NAME } from '../src/code-agent.ts'
import {
  collectProjectContext,
  discoverInstructionCandidates,
  findProjectRoot,
  instructionObservationFrom,
  MAX_HANDOFF_BYTES_PER_FILE,
  resolveEvidenceRunner,
} from '../src/project-context.ts'

const roots: string[] = []
const contexts: Context[] = []

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-orb-project-context-'))
  roots.push(root)
  return root
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

function event(text: string, source: Record<string, unknown>) {
  return {
    type: 'user/message',
    data: {
      source,
      content: [{ type: 'text', text }],
    },
  }
}

function identity(sessionCwd: string, projectRoot: string): string {
  return JSON.stringify({
    projectRoot: relative(sessionCwd, projectRoot),
    projectRootMarkers: ['.git'],
    maxBytes: 65536,
    maxSourceBytes: 1048576,
    instructionFileCandidates: ['AGENTS.md', 'CLAUDE.md'],
    localInstructionFileCandidates: ['AGENTS.local.md', 'CLAUDE.local.md'],
  })
}

async function collect(
  input: Parameters<typeof collectProjectContext>[0],
  events: readonly unknown[],
) {
  return collectProjectContext({
    ...input,
    headerCwd: input.headerCwd ?? input.sessionCwd,
    cwdSource: input.cwdSource ?? 'service',
  }, events)
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('project context discovery', () => {
  it('finds the nearest .git root from a nested directory', async () => {
    const root = await scratch()
    await mkdir(join(root, '.git'))
    const deep = join(root, 'packages', 'app', 'src')
    await mkdir(deep, { recursive: true })
    expect(findProjectRoot(deep)).toEqual({ root, marker: '.git' })
  })

  it('lists user-global and root-to-leaf instruction candidates in loader order', async () => {
    const home = await scratch()
    const root = await scratch()
    await mkdir(join(home, '.dsh'), { recursive: true })
    await mkdir(join(home, '.agents'), { recursive: true })
    await mkdir(join(root, '.git'))
    await mkdir(join(root, 'packages', 'app'), { recursive: true })
    await writeFile(join(home, '.dsh', 'AGENTS.md'), 'global-dsh\n')
    await writeFile(join(home, '.agents', 'AGENTS.md'), 'global-agents\n')
    await writeFile(join(root, 'AGENTS.md'), 'root rules\n')
    await writeFile(join(root, 'CLAUDE.md'), 'root claude\n')
    await writeFile(join(root, 'packages', 'AGENTS.md'), 'packages rules\n')
    await writeFile(join(root, 'packages', 'app', 'AGENTS.md'), 'app rules\n')
    await writeFile(join(root, 'packages', 'app', 'AGENTS.local.md'), 'app local\n')

    const files = await discoverInstructionCandidates(root, join(root, 'packages', 'app'), home)
    expect(files.map(file => file.displayPath)).toEqual([
      '~/.dsh/AGENTS.md',
      '~/.agents/AGENTS.md',
      'AGENTS.md',
      'CLAUDE.md',
      'packages/AGENTS.md',
      'packages/app/AGENTS.md',
      'packages/app/AGENTS.local.md',
    ])
    expect(files.find(file => file.displayPath === 'AGENTS.md')?.sha1).toBe(sha1('root rules\n'))
    expect(files.find(file => file.displayPath === 'packages/app/AGENTS.md')?.scope).toBe('packages/app')
  })

  it('reads the official loader changes, identity, budget notice, removals, and stale state', async () => {
    const root = await scratch()
    await mkdir(join(root, '.git'))
    const rootText = 'root rules\n'
    const nestedText = 'nested rules\n'
    await writeFile(join(root, 'AGENTS.md'), rootText)
    await writeFile(join(root, 'CLAUDE.md'), 'claude rules\n')
    const nested = join(root, 'src')
    await mkdir(nested)
    await writeFile(join(nested, 'AGENTS.md'), nestedText)

    const events = [
      event('The following workspace instructions may be relevant.', {
        kind: 'agent-instructions',
        form: 'instructions',
        baseline: true,
        baselineIdentity: identity(nested, root),
        changes: [
          { action: 'set', scope: '.', path: 'AGENTS.md', digest: sha1(rootText) },
          { action: 'set', scope: 'src', path: 'src/AGENTS.md', digest: sha1(nestedText) },
        ],
      }),
      event('Workspace instruction budget 65536 bytes: omitted CLAUDE.md; truncated src/AGENTS.md from 100 to 50 bytes', {
        kind: 'agent-instructions',
        form: 'instructions',
        changes: [
          { action: 'set', scope: 'src', path: 'src/AGENTS.md', digest: 'truncated-digest' },
        ],
      }),
    ]
    const observation = instructionObservationFrom(events)
    expect(observation.observed).toBe(true)
    expect(observation.baselineIdentity).toBe(identity(nested, root))
    expect(observation.loaded.map(entry => entry.path)).toEqual(['AGENTS.md', 'src/AGENTS.md'])
    expect(observation.budgetNotice).toContain('omitted CLAUDE.md')

    const report = await collect({
      sessionCwd: nested,
      projectDir: nested,
      handoff: undefined,
      home: join(root, 'home'),
    }, events)
    expect(report.project_root).toBe(root)
    expect(report.instruction_state).toBe('partial')
    const nestedState = report.instructions.find(file => file.displayPath === 'src/AGENTS.md')
    expect(nestedState).toMatchObject({ loaded: true, truncated: true, stale: false })
    expect(report.instructions.find(file => file.displayPath === 'CLAUDE.md')).toMatchObject({
      loaded: false,
      omitted: true,
    })
    expect(report.warnings.join('\n')).toContain('truncated instruction content')
  })

  it('resolves root and nested rules relative to the baseline project root when cwd is a subdirectory', async () => {
    const root = await scratch()
    await mkdir(join(root, '.git'))
    const nested = join(root, 'src')
    await mkdir(nested)
    const rootText = 'root rules for the whole project\n'
    const nestedText = 'nested rules for src only\n'
    await writeFile(join(root, 'AGENTS.md'), rootText)
    await writeFile(join(nested, 'AGENTS.md'), nestedText)
    const events = [event('Instructions from: AGENTS.md, src/AGENTS.md', {
      kind: 'agent-instructions',
      form: 'instructions',
      baseline: true,
      // The official loader reports the project root relative to the cwd at
      // baseline time; here cwd is project\src, so projectRoot is `..`.
      baselineIdentity: identity(nested, root),
      changes: [
        { action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1(rootText) },
        { action: 'set', scope: 'src\u0000AGENTS.md', path: 'src/AGENTS.md', digest: sha1(nestedText) },
      ],
    })]

    const report = await collect({
      sessionCwd: nested,
      projectDir: nested,
      handoff: undefined,
      home: join(root, 'home'),
    }, events)

    expect(report).toMatchObject({
      instruction_state: 'loaded',
      project_scope_confirmed: true,
      baseline_cwd: nested,
      latest_loader_cwd: nested,
      baseline_project_root: root,
      latest_loader_project_root: root,
      project_root: root,
      project_dir: nested,
    })
    const rootRule = report.instructions.find(file => file.displayPath === 'AGENTS.md')
    const nestedRule = report.instructions.find(file => file.displayPath === 'src/AGENTS.md')
    expect(rootRule).toMatchObject({
      absolutePath: join(root, 'AGENTS.md'),
      loaded: true,
      stale: false,
      digest: sha1(rootText),
      loaderSha1: sha1(rootText),
    })
    expect(nestedRule).toMatchObject({
      absolutePath: join(nested, 'AGENTS.md'),
      loaded: true,
      stale: false,
      digest: sha1(nestedText),
      loaderSha1: sha1(nestedText),
    })
    expect(report.instructions.filter(file => file.displayPath === 'src/AGENTS.md')).toHaveLength(1)
    expect(report.instructions.map(file => file.absolutePath)).not.toContain(join(nested, 'src', 'AGENTS.md'))
    expect(report.warnings.join('\n')).not.toMatch(/not in the loader|changed after the loader/u)
  })

  it('uses the current working directory service when a later loader baseline belongs to it', async () => {
    const a = await scratch()
    const b = await scratch()
    const content = 'same rules in both projects\n'
    for (const root of [a, b]) {
      await mkdir(join(root, '.git'))
      await writeFile(join(root, 'AGENTS.md'), content)
    }
    const events = [
      { type: 'working-directory/change', data: { cwd: b } },
      event('Instructions from: AGENTS.md\n' + content, {
        kind: 'agent-instructions',
        form: 'instructions',
        baseline: true,
        baselineIdentity: identity(b, b),
        changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1(content) }],
      }),
    ]
    const report = await collectProjectContext({
      sessionCwd: b,
      headerCwd: a,
      cwdSource: 'service',
      projectDir: b,
      handoff: undefined,
      home: join(a, 'home'),
    }, events)
    expect(report).toMatchObject({
      instruction_state: 'loaded',
      project_scope_confirmed: true,
      baseline_cwd: b,
      header_cwd: a,
      cwd_source: 'service',
    })
    expect(report.instructions[0]).toMatchObject({ loaded: true, withinSessionScope: true })
  })

  it('does not treat the current directory as baseline provenance without a change event', async () => {
    const a = await scratch()
    const b = await scratch()
    const content = 'same rules in both projects\n'
    for (const root of [a, b]) {
      await mkdir(join(root, '.git'))
      await writeFile(join(root, 'AGENTS.md'), content)
    }
    const events = [event('Instructions from: AGENTS.md\n' + content, {
      kind: 'agent-instructions',
      form: 'instructions',
      baseline: true,
      baselineIdentity: identity(b, b),
      changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1(content) }],
    })]
    const report = await collectProjectContext({
      sessionCwd: b,
      headerCwd: a,
      cwdSource: 'service',
      projectDir: b,
      handoff: undefined,
      home: join(a, 'home'),
    }, events)
    expect(report).toMatchObject({
      instruction_state: 'unconfirmed',
      project_scope_confirmed: false,
      baseline_cwd: a,
    })
    expect(report.instructions[0]?.loaded).toBe(false)
  })

  it('does not give an old baseline a new project identity from the current cwd', async () => {
    const a = await scratch()
    const b = await scratch()
    const content = 'same rules in both projects\n'
    for (const root of [a, b]) {
      await mkdir(join(root, '.git'))
      await writeFile(join(root, 'AGENTS.md'), content)
    }
    const events = [
      event('Instructions from: AGENTS.md\n' + content, {
        kind: 'agent-instructions',
        form: 'instructions',
        baseline: true,
        baselineIdentity: identity(a, a),
        changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1(content) }],
      }),
      {
        type: 'working-directory/change',
        data: { cwd: b },
      },
    ]
    const report = await collectProjectContext({
      sessionCwd: b,
      headerCwd: a,
      cwdSource: 'service',
      projectDir: b,
      handoff: undefined,
      home: join(a, 'home'),
    }, events)
    expect(report).toMatchObject({
      instruction_state: 'unconfirmed',
      project_scope_confirmed: false,
      baseline_cwd: a,
    })
    expect(report.instructions[0]?.loaded).toBe(false)
  })

  it('stays unconfirmed when no baseline working-directory provenance exists', async () => {
    const a = await scratch()
    const b = await scratch()
    const content = 'same rules in both projects\n'
    for (const root of [a, b]) {
      await mkdir(join(root, '.git'))
      await writeFile(join(root, 'AGENTS.md'), content)
    }
    const events = [event('Instructions from: AGENTS.md\n' + content, {
      kind: 'agent-instructions',
      form: 'instructions',
      baseline: true,
      baselineIdentity: JSON.stringify({ projectRoot: '' }),
      changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1(content) }],
    })]
    const report = await collectProjectContext({
      sessionCwd: b,
      projectDir: b,
      handoff: undefined,
      home: join(a, 'home'),
    }, events)
    expect(report).toMatchObject({ instruction_state: 'unconfirmed', project_scope_confirmed: false })
    expect(report.baseline_cwd).toBeUndefined()
    expect(report.instructions[0]?.loaded).toBe(false)
  })

  it('compares the loader text digest after a leading BOM, not the raw bytes', async () => {
    const root = await scratch()
    await mkdir(join(root, '.git'))
    const decoded = 'At the end of every final answer, append [BOM-A].\n\r\n'
    const bytes = Buffer.from('\uFEFF' + decoded)
    await writeFile(join(root, 'AGENTS.md'), bytes)
    const events = [event('instructions', {
      kind: 'agent-instructions',
      form: 'instructions',
      baseline: true,
      baselineIdentity: identity(root, root),
      changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1(decoded) }],
    })]
    const report = await collect({
      sessionCwd: root,
      projectDir: root,
      handoff: undefined,
      home: join(root, 'home'),
    }, events)
    expect(report.instruction_state).toBe('loaded')
    expect(report.instructions[0]).toMatchObject({
      loaded: true,
      stale: false,
      sha1: sha1(bytes.toString('utf8')),
      loaderSha1: sha1(decoded),
      digest: sha1(decoded),
    })
    expect(report.instructions[0]?.sha1).not.toBe(report.instructions[0]?.loaderSha1)
    expect(report.latest_loader_cwd).toBe(root)

    await writeFile(join(root, 'AGENTS.md'), Buffer.from('\uFEFF' + decoded + '\n'))
    const changed = await collect({
      sessionCwd: root,
      projectDir: root,
      handoff: undefined,
      home: join(root, 'home'),
    }, events)
    expect(changed.instructions[0]?.stale).toBe(true)
  })

  it('uses incremental replace cwd provenance instead of rebinding the baseline', async () => {
    const b = await scratch()
    const a = await scratch()
    for (const root of [a, b]) await mkdir(join(root, '.git'))
    const textB = 'B rules\n'
    const textA = 'A rules\n'
    await writeFile(join(b, 'AGENTS.md'), textB)
    await writeFile(join(a, 'AGENTS.md'), textA)
    const baselineB = event('B baseline', {
      kind: 'agent-instructions',
      baseline: true,
      baselineIdentity: identity(b, b),
      changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1(textB) }],
    })
    const change = { type: 'working-directory/change', data: { cwd: a } }
    const replaceA = event('A replace', {
      kind: 'agent-instructions',
      changes: [{ action: 'replace', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1(textA) }],
    })
    const before = await collectProjectContext({
      sessionCwd: a,
      headerCwd: b,
      cwdSource: 'service',
      projectDir: a,
      handoff: undefined,
      home: join(a, 'home'),
    }, [baselineB, change])
    expect(before).toMatchObject({ instruction_state: 'unconfirmed', project_scope_confirmed: false, baseline_cwd: b })
    expect(before.instructions[0]?.loaded).toBe(false)

    const after = await collectProjectContext({
      sessionCwd: a,
      headerCwd: b,
      cwdSource: 'service',
      projectDir: a,
      handoff: undefined,
      home: join(a, 'home'),
    }, [baselineB, change, replaceA])
    expect(after).toMatchObject({
      instruction_state: 'loaded',
      project_scope_confirmed: true,
      baseline_cwd: b,
      latest_loader_cwd: a,
    })
    expect(after.instructions[0]).toMatchObject({
      loaded: true,
      stale: false,
      digest: sha1(textA),
      loaderSha1: sha1(textA),
      withinSessionScope: true,
    })

    const sameContentB = await collectProjectContext({
      sessionCwd: b,
      headerCwd: b,
      cwdSource: 'service',
      projectDir: b,
      handoff: undefined,
      home: join(b, 'home'),
    }, [baselineB, change, replaceA])
    expect(sameContentB).toMatchObject({ instruction_state: 'unconfirmed', project_scope_confirmed: false })
    expect(sameContentB.instructions[0]?.loaded).toBe(false)

    // A/B contents identical must still follow the replace event's cwd, not text equality.
    const same = await scratch()
    await mkdir(join(same, '.git'))
    await writeFile(join(same, 'AGENTS.md'), textB)
    const replaceSame = event('A same-content replace', {
      kind: 'agent-instructions',
      changes: [{ action: 'replace', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1(textB) }],
    })
    const changeSame = { type: 'working-directory/change', data: { cwd: same } }
    const sameTarget = await collectProjectContext({
      sessionCwd: same,
      headerCwd: b,
      cwdSource: 'service',
      projectDir: same,
      handoff: undefined,
      home: join(same, 'home'),
    }, [baselineB, changeSame, replaceSame])
    expect(sameTarget).toMatchObject({ instruction_state: 'loaded', project_scope_confirmed: true, latest_loader_cwd: same })
    expect(sameTarget.instructions[0]?.loaded).toBe(true)
    expect(sameTarget.instructions[0]?.stale).toBe(false)
  })

  it('does not attribute a replace after a missing change event to the old baseline', async () => {
    const b = await scratch()
    const a = await scratch()
    for (const root of [a, b]) await mkdir(join(root, '.git'))
    const textB = 'same rules\n'
    await writeFile(join(a, 'AGENTS.md'), textB)
    await writeFile(join(b, 'AGENTS.md'), textB)
    const events = [
      event('B baseline', {
        kind: 'agent-instructions',
        baseline: true,
        baselineIdentity: identity(b, b),
        changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1(textB) }],
      }),
      event('ambiguous replace', {
        kind: 'agent-instructions',
        changes: [{ action: 'replace', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1(textB) }],
      }),
    ]
    const report = await collectProjectContext({
      sessionCwd: a,
      headerCwd: b,
      cwdSource: 'service',
      projectDir: a,
      handoff: undefined,
      home: join(a, 'home'),
    }, events)
    expect(report).toMatchObject({ instruction_state: 'unconfirmed', project_scope_confirmed: false })
    expect(report.instructions[0]?.loaded).toBe(false)
  })

  it('reports pending rather than claiming rules loaded when no durable loader message exists', async () => {
    const root = await scratch()
    await mkdir(join(root, '.git'))
    await writeFile(join(root, 'AGENTS.md'), 'rules\n')
    const report = await collect({
      sessionCwd: root,
      projectDir: root,
      handoff: undefined,
      home: join(root, 'home'),
    }, [])
    expect(report.instruction_state).toBe('pending')
    expect(report.instruction_loader).toBe('not-observed')
    expect(report.instructions).toHaveLength(1)
    expect(report.instructions[0]).toMatchObject({ loaded: false, stale: false })
  })
})

describe('project identity, scope, and completeness', () => {
  it('does not attribute project A loader evidence to project B with identical content', async () => {
    const a = await scratch()
    const b = await scratch()
    const content = 'Rule shared by two different projects.\n'
    for (const root of [a, b]) {
      await mkdir(join(root, '.git'))
      await writeFile(join(root, 'AGENTS.md'), content)
    }
    const events = [event('Instructions from: AGENTS.md\n' + content, {
      kind: 'agent-instructions',
      form: 'instructions',
      baseline: true,
      baselineIdentity: identity(a, a),
      changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1(content) }],
    })]

    const same = await collect({
      sessionCwd: a, projectDir: a, handoff: undefined, home: join(a, 'home'),
    }, events)
    expect(same).toMatchObject({ instruction_state: 'loaded', project_scope_confirmed: true })
    expect(same.instructions[0]).toMatchObject({ loaded: true, stale: false })

    const switched = await collect({
      sessionCwd: a, projectDir: b, handoff: undefined, home: join(a, 'home'),
    }, events)
    expect(switched).toMatchObject({ instruction_state: 'unconfirmed', project_scope_confirmed: false })
    expect(switched.instructions[0]).toMatchObject({ loaded: false, stale: false })
    expect(switched.warnings.join('\n')).toContain(`belongs to ${a}, not target project ${b}`)
  })

  it('reports partial when a newly applicable file was never loaded', async () => {
    const root = await scratch()
    await mkdir(join(root, '.git'))
    await writeFile(join(root, 'AGENTS.md'), 'loaded rules\n')
    await writeFile(join(root, 'CLAUDE.local.md'), 'new rule that was not loaded\n')
    const events = [event('Instructions from: AGENTS.md', {
      kind: 'agent-instructions',
      form: 'instructions',
      baseline: true,
      baselineIdentity: identity(root, root),
      changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1('loaded rules\n') }],
    })]
    const report = await collect({
      sessionCwd: root, projectDir: root, handoff: undefined, home: join(root, 'home'),
    }, events)
    expect(report.instruction_state).toBe('partial')
    expect(report.instructions.find(file => file.displayPath === 'CLAUDE.local.md')).toMatchObject({
      loaded: false,
      deduplicated: false,
    })
    expect(report.warnings.join('\n')).toContain('CLAUDE.local.md')
  })

  it('treats official trimmed-content deduplication as covered, not missing', async () => {
    const root = await scratch()
    await mkdir(join(root, '.git'))
    const content = 'identical trimmed rules\n'
    await writeFile(join(root, 'AGENTS.md'), `${content}\n`)
    await writeFile(join(root, 'CLAUDE.md'), content)
    const events = [event('Instructions from: AGENTS.md', {
      kind: 'agent-instructions',
      form: 'instructions',
      baseline: true,
      baselineIdentity: identity(root, root),
      changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1(`${content}\n`) }],
    })]
    const report = await collect({
      sessionCwd: root, projectDir: root, handoff: undefined, home: join(root, 'home'),
    }, events)
    expect(report.instruction_state).toBe('loaded')
    expect(report.instructions.find(file => file.displayPath === 'CLAUDE.md')).toMatchObject({
      loaded: false,
      deduplicated: true,
      duplicateOf: 'AGENTS.md',
    })
    expect(report.warnings.join('\n')).not.toContain('not in the loader')
  })

  it('uses the latest baseline across a project switch and does not retain old project changes', async () => {
    const a = await scratch()
    const b = await scratch()
    for (const root of [a, b]) await mkdir(join(root, '.git'))
    await writeFile(join(a, 'AGENTS.md'), 'A rules\n')
    await writeFile(join(b, 'AGENTS.md'), 'B rules\n')
    const events = [
      event('Instructions from: AGENTS.md', {
        kind: 'agent-instructions',
        form: 'instructions',
        baseline: true,
        baselineIdentity: identity(a, a),
        changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1('A rules\n') }],
      }),
      event('This complete workspace instruction baseline replaces all earlier baselines.', {
        kind: 'agent-instructions',
        form: 'instructions',
        baseline: true,
        baselineIdentity: identity(b, b),
        changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1('B rules\n') }],
      }),
    ]
    const reportB = await collect({
      sessionCwd: b, projectDir: b, handoff: undefined, home: join(b, 'home'),
    }, events)
    expect(reportB).toMatchObject({ instruction_state: 'loaded', project_scope_confirmed: true })
    expect(reportB.instructions).toHaveLength(1)

    const reportA = await collect({
      sessionCwd: b, projectDir: a, handoff: undefined, home: join(a, 'home'),
    }, events)
    expect(reportA.instruction_state).toBe('unconfirmed')
    expect(reportA.instructions.find(file => file.displayPath === 'AGENTS.md')?.loaded).toBe(false)
  })

  it('clears an old budget notice when a later baseline includes the full file', async () => {
    const root = await scratch()
    await mkdir(join(root, '.git'))
    const full = 'a complete rule that is long enough\n'
    await writeFile(join(root, 'AGENTS.md'), full)
    const events = [
      event('Workspace instruction budget 65536 bytes: truncated AGENTS.md from 100 to 50 bytes', {
        kind: 'agent-instructions',
        form: 'instructions',
        baseline: true,
        baselineIdentity: identity(root, root),
        changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1('a complete rule') }],
      }),
      event('This complete workspace instruction baseline replaces all earlier baselines.', {
        kind: 'agent-instructions',
        form: 'instructions',
        baseline: true,
        baselineIdentity: identity(root, root),
        changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1(full) }],
      }),
    ]
    const report = await collect({
      sessionCwd: root, projectDir: root, handoff: undefined, home: join(root, 'home'),
    }, events)
    expect(report.budget_notice).toBeUndefined()
    expect(report.instruction_state).toBe('loaded')
    expect(report.instructions[0]).toMatchObject({ loaded: true, truncated: false, omitted: false })
  })

  it('marks a target below the session cwd as partial when its nested rules were not loaded', async () => {
    const root = await scratch()
    await mkdir(join(root, '.git'))
    await writeFile(join(root, 'AGENTS.md'), 'root rules\n')
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'AGENTS.md'), 'nested rules\n')
    const events = [event('Instructions from: AGENTS.md', {
      kind: 'agent-instructions',
      form: 'instructions',
      baseline: true,
      baselineIdentity: identity(root, root),
      changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1('root rules\n') }],
    })]
    const report = await collect({
      sessionCwd: root, projectDir: join(root, 'nested'), handoff: undefined, home: join(root, 'home'),
    }, events)
    expect(report).toMatchObject({ instruction_state: 'partial', project_scope_confirmed: true })
    expect(report.instructions.find(file => file.displayPath === 'nested/AGENTS.md')).toMatchObject({
      loaded: false,
      withinSessionScope: false,
    })
    expect(report.warnings.join('\n')).toContain('below the session cwd')
  })

  it('accepts a replace update and drops a removed rule', async () => {
    const root = await scratch()
    await mkdir(join(root, '.git'))
    const oldText = 'old rules\n'
    const newText = 'replacement rules\n'
    const rulePath = join(root, 'AGENTS.md')
    await writeFile(rulePath, newText)
    const events = [
      event('Instructions from: AGENTS.md', {
        kind: 'agent-instructions',
        form: 'instructions',
        baseline: true,
        baselineIdentity: identity(root, root),
        changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1(oldText) }],
      }),
      event('Updated instructions from: AGENTS.md', {
        kind: 'agent-instructions',
        form: 'instructions',
        changes: [{ action: 'replace', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1(newText) }],
      }),
    ]
    const replaced = await collect({
      sessionCwd: root, projectDir: root, handoff: undefined, home: join(root, 'home'),
    }, events)
    expect(replaced.instruction_state).toBe('loaded')
    expect(replaced.instructions[0]).toMatchObject({ loaded: true, stale: false, digest: sha1(newText) })

    events.push(event('Instructions removed: AGENTS.md', {
      kind: 'agent-instructions',
      form: 'instructions',
      changes: [{ action: 'remove', scope: '.\u0000AGENTS.md', path: 'AGENTS.md' }],
    }))
    await rm(rulePath)
    const removed = await collect({
      sessionCwd: root, projectDir: root, handoff: undefined, home: join(root, 'home'),
    }, events)
    expect(removed.instructions).toHaveLength(0)
    expect(removed.instruction_state).toBe('none')
  })
})

describe('explicit handoff documents', () => {
  it('reads only the named file, bounds it, and never expands a directory', async () => {
    const root = await scratch()
    await mkdir(join(root, '.git'))
    const notes = join(root, 'handoff.md')
    const other = join(root, 'other.md')
    await writeFile(notes, 'a'.repeat(MAX_HANDOFF_BYTES_PER_FILE * 2))
    await writeFile(other, 'not requested')
    await mkdir(join(root, 'handoff'))
    const report = await collect({
      sessionCwd: root,
      projectDir: root,
      handoff: ['handoff.md'],
      home: join(root, 'home'),
    }, [])
    expect(report.handoff).toHaveLength(1)
    expect(report.handoff[0]).toMatchObject({
      path: notes,
      bytes: MAX_HANDOFF_BYTES_PER_FILE * 2,
      truncated: true,
    })
    expect(report.handoff[0]?.content.length).toBe(MAX_HANDOFF_BYTES_PER_FILE)
    expect(report.handoff.some(document => document.path === other)).toBe(false)

    await expect(collectProjectContext({
      sessionCwd: root,
      projectDir: root,
      handoff: ['handoff'],
      home: join(root, 'home'),
    }, [])).rejects.toThrow(/not a file/u)
  })

  it('rejects more than four explicit handoff files before reading any', async () => {
    const root = await scratch()
    await mkdir(join(root, '.git'))
    await expect(collectProjectContext({
      sessionCwd: root,
      projectDir: root,
      handoff: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'],
      home: join(root, 'home'),
    }, [])).rejects.toThrow(/at most 4/u)
  })
})

describe('project_context tool', () => {
  it('returns paths, loader evidence, and explicit handoff content without re-injecting the rules body', async () => {
    const root = await scratch()
    await mkdir(join(root, '.git'))
    const rules = 'root rules body that must not be repeated\n'
    await writeFile(join(root, 'AGENTS.md'), rules)
    await writeFile(join(root, 'handoff.md'), 'handoff body\n')
    const events = [
      event('The following workspace instructions may be relevant.', {
        kind: 'agent-instructions',
        form: 'instructions',
        baseline: true,
        baselineIdentity: identity(root, root),
        changes: [{ action: 'set', scope: '.', path: 'AGENTS.md', digest: sha1(rules) }],
      }),
    ]
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('sessionController', {
      async create() { throw new Error('not used') },
      async prompt() { throw new Error('not used') },
      async inspect() { throw new Error('not used') },
      async selectModel() { throw new Error('not used') },
    })
    ctx.provide('agentDefaultModel', { currentSelection: () => undefined })
    ctx.provide('workingDirectory', { get: () => root })
    apply(ctx)
    const agent = {
      id: 'caller' as SessionId,
      session: {
        header: { id: 'caller' as SessionId, agentPreset: 'computer-use', cwd: root },
        snapshotEvents: () => events,
        deriveMessages: () => [],
      },
    } as unknown as Agent
    const result = await ctx.tools.execute({
      callId: ToolCallId('project-context-1'),
      name: PROJECT_CONTEXT_TOOL_NAME,
      arguments: { handoff: ['handoff.md'] },
      signal: new AbortController().signal,
      agent,
    })
    expect(result.isError).toBe(false)
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(text).toContain(`Project: ${root}`)
    expect(text).toContain('sha1=')
    expect(text).toContain('handoff body')
    expect(text).not.toContain('root rules body that must not be repeated')

    await writeFile(join(root, 'CLAUDE.local.md'), 'new rule that was not loaded\n')
    const added = await ctx.tools.execute({
      callId: ToolCallId('project-context-2'),
      name: PROJECT_CONTEXT_TOOL_NAME,
      arguments: {},
      signal: new AbortController().signal,
      agent,
    })
    const addedText = added.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(addedText).toContain('state: partial')
    expect(addedText).toContain('CLAUDE.local.md')
  })

  it('reads the current workingDirectory service instead of the immutable header cwd', async () => {
    const a = await scratch()
    const b = await scratch()
    const content = 'B rules\n'
    for (const root of [a, b]) await mkdir(join(root, '.git'))
    await writeFile(join(b, 'AGENTS.md'), content)
    const events = [
      { type: 'working-directory/change', data: { cwd: b } },
      event('Instructions from: AGENTS.md\n' + content, {
        kind: 'agent-instructions',
        form: 'instructions',
        baseline: true,
        baselineIdentity: identity(b, b),
        changes: [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1(content) }],
      }),
    ]
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('sessionController', {
      async create() { throw new Error('not used') },
      async prompt() { throw new Error('not used') },
      async inspect() { throw new Error('not used') },
      async selectModel() { throw new Error('not used') },
    })
    ctx.provide('agentDefaultModel', { currentSelection: () => undefined })
    let reads = 0
    ctx.provide('workingDirectory', { get: () => { reads += 1; return b } })
    apply(ctx)
    const agent = {
      id: 'caller' as SessionId,
      session: {
        header: { id: 'caller' as SessionId, agentPreset: 'computer-use', cwd: a },
        snapshotEvents: () => events,
        deriveMessages: () => [],
      },
    } as unknown as Agent
    const result = await ctx.tools.execute({
      callId: ToolCallId('project-context-current-cwd'),
      name: PROJECT_CONTEXT_TOOL_NAME,
      arguments: { project_dir: b },
      signal: new AbortController().signal,
      agent,
    })
    expect(result.isError).toBe(false)
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(reads).toBe(1)
    expect(text).toContain(`Current cwd: ${b}`)
    expect(text).toContain(`Session header cwd: ${a}`)
    expect(text).toContain(`Loader baseline cwd: ${b}`)
    expect(text).toContain('state: loaded')
  })
})

describe('evidence runner locator', () => {
  it('finds the bundled runner from the source layout', () => {
    const fromSource = new URL('../src/project-context.ts', import.meta.url).href
    expect(resolveEvidenceRunner(fromSource)).toMatch(/packages[\\/]bundle[\\/]runtime[\\/]run-with-evidence\.ps1$/u)
  })
})
