/**
 * Computer Use-only tools that create, continue, list, and stop first-class
 * standard Sessions for one stretch of file search or file production.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/code-agent
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SessionCreateRequest, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { watchCodeAgentCompletion } from './code-agent-completion.ts'
import { sharedCodeAgentRegistry } from './code-agent-registry.ts'
import { attachUnattendedCodeAgent } from './code-agent-unattended.ts'
import {
  collectProjectContext,
  findProjectRoot,
  MAX_HANDOFF_BYTES_PER_FILE,
  MAX_HANDOFF_BYTES_TOTAL,
  MAX_HANDOFF_FILES,
  resolveEvidenceRunner,
  type ProjectContextReport,
} from './project-context.ts'
import { selectModelKeepDefault, type SelectModelKeepDefaultHost } from './select-model.ts'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-tools'

type WorkspaceId = NonNullable<SessionCreateRequest['workspaceId']>

interface OrbCodeAgentModel {
  currentSelection(): {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  } | undefined
}

interface Delegation {
  task: string
  cwd: string
  readonly watches: AbortController[]
}

/**
 * Read the live Session working directory from the official service.
 * The Session header is immutable and only records the creation directory.
 * @param ctx - plugin context that may provide `workingDirectory`.
 * @param session - live Session object.
 * @returns the committed absolute directory, or undefined when unavailable.
 */
export function currentWorkingDirectory(ctx: Context, session: unknown): string | undefined {
  try {
    const service = ctx.get('workingDirectory') as {
      get?: (session: unknown) => unknown
      current?: () => unknown
    } | undefined
    const value = service?.get !== undefined ? service.get(session) : service?.current?.()
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Reconstruct the effective directory from a complete durable event sequence.
 * The header is only the starting point; a later `working-directory/change`
 * wins. Missing events mean the caller has no provenance, not that the header
 * is current.
 * @param events - complete Session event sequence, or undefined when unavailable.
 * @param headerCwd - Session creation directory.
 * @returns the effective directory, or undefined without event provenance.
 */
export function directoryFromEvents(
  events: readonly { readonly type?: unknown; readonly data?: unknown }[] | undefined,
  headerCwd: string | undefined,
): string | undefined {
  if (events === undefined) return undefined
  let cwd = headerCwd
  for (const event of events) {
    if (event.type !== 'working-directory/change') continue
    const data = event.data as { cwd?: unknown } | undefined
    if (typeof data?.cwd === 'string' && data.cwd.trim() !== '') cwd = data.cwd
  }
  return cwd
}

function sessionEvents(session: unknown): readonly { type?: unknown; data?: unknown }[] | undefined {
  const snapshot = (session as { snapshotEvents?: () => readonly { type?: unknown; data?: unknown }[] } | undefined)
    ?.snapshotEvents
  if (typeof snapshot !== 'function') return undefined
  try {
    return snapshot.call(session)
  } catch {
    return undefined
  }
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Cordis plugin name. */
export const name = 'tool-code-agent'

/** Services required at apply time. Missing Session Remote keeps the plugin pending. */
export const inject = ['tools', 'sessionController', 'agentDefaultModel']

/** Model-visible tool that creates or continues a background Code session. */
export const TOOL_NAME = 'code_agent'

/** Model-visible tool that lists this Computer Use caller's Code sessions. */
export const STATUS_TOOL_NAME = 'code_agent_status'

/** Model-visible tool that stops one of this Computer Use caller's Code sessions. */
export const STOP_TOOL_NAME = 'code_agent_stop'

/** Model-visible tool that names the project and reports the rules actually loaded. */
export const PROJECT_CONTEXT_TOOL_NAME = 'project_context'

const PROJECT_CONTEXT_DESCRIPTION = 'Name the project directory this task belongs to and show which AGENTS.md/CLAUDE.md files the official instruction loader actually retained. '
  + 'Call this before a project task when the user named a repository, said "this project", or the work modifies existing code. '
  + 'Pass the returned project_dir to code_agent as cwd so the background session starts at the same project scope. '
  + 'It checks the current workingDirectory service against the immutable Session header cwd, resolves the loader baseline identity at the directory where that baseline was produced, and compares it with the target project. '
  + 'It reports paths, sizes, SHA-1 digests, omission/truncation notices, content deduplication, and whether a file changed after loading; it does not inject instruction bodies again. '
  + 'A directory argument alone never proves that this session loaded that directory. If the loader evidence belongs to another project, or a new applicable file was never loaded, the state is unconfirmed or partial. '
  + `It can read at most ${String(MAX_HANDOFF_FILES)} handoff documents that the user named explicitly, ${String(MAX_HANDOFF_BYTES_PER_FILE)} bytes each and ${String(MAX_HANDOFF_BYTES_TOTAL)} bytes total. `
  + 'It never scans docs/ or history directories recursively. Call it again after a project switch or after a named rules file changes.'

const PROJECT_CONTEXT_PARAMETERS = {
  project_dir: {
    type: 'string' as const,
    description:
      'Project directory for this task, absolute or relative to the Computer Use session cwd. '
      + 'Omit to use the Computer Use session cwd. This is resolved from the task, not from a shell Set-Location or cd.',
  },
  handoff: {
    type: 'array' as const,
    items: { type: 'string' as const },
    description:
      'Specific handoff files the user named, absolute or relative to project_dir. '
      + `At most ${String(MAX_HANDOFF_FILES)} files; each is read once and truncated at the byte budget. No directory is expanded.`,
  },
}

/** Tool output shape: only paths, scalar metadata, and bounded handoff text. */
interface ProjectContextToolOutput {
  readonly session_cwd: string
  readonly header_cwd?: string | undefined
  readonly baseline_cwd?: string | undefined
  readonly cwd_source: 'service' | 'unknown'
  readonly project_dir: string
  readonly project_root: string
  readonly root_marker: string
  readonly instruction_state: 'loaded' | 'partial' | 'pending' | 'unconfirmed' | 'none'
  readonly instruction_loader: 'agent-instructions' | 'not-observed'
  readonly project_scope_confirmed: boolean
  readonly baseline_identity?: string | undefined
  readonly baseline_project_root?: string | undefined
  readonly latest_loader_cwd?: string | undefined
  readonly latest_loader_project_root?: string | undefined
  readonly budget_notice?: string | undefined
  readonly instructions: Array<{
    readonly display_path: string
    readonly absolute_path: string
    readonly scope: string
    readonly bytes: number
    readonly sha1?: string | undefined
    readonly loader_sha1?: string | undefined
    readonly loaded: boolean
    readonly digest?: string | undefined
    readonly truncated: boolean
    readonly omitted: boolean
    readonly stale: boolean
    readonly deduplicated: boolean
    readonly duplicate_of?: string | undefined
    readonly within_session_scope: boolean
  }>
  readonly handoff: Array<{
    readonly path: string
    readonly bytes: number
    readonly sha256: string
    readonly truncated: boolean
    readonly content: string
  }>
  readonly evidence_runner?: string | undefined
  readonly warnings: string[]
}

const PROJECT_CONTEXT_OUTPUT = {
  schema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      session_cwd: { type: 'string' as const, required: true },
      header_cwd: { type: 'string' as const },
      baseline_cwd: { type: 'string' as const },
      cwd_source: {
        type: 'string' as const,
        required: true,
        enum: ['service', 'unknown'],
      },
      project_dir: { type: 'string' as const, required: true },
      project_root: { type: 'string' as const, required: true },
      root_marker: { type: 'string' as const, required: true },
      instruction_state: {
        type: 'string' as const,
        required: true,
        enum: ['loaded', 'partial', 'pending', 'unconfirmed', 'none'],
      },
      instruction_loader: {
        type: 'string' as const,
        required: true,
        enum: ['agent-instructions', 'not-observed'],
      },
      project_scope_confirmed: { type: 'boolean' as const, required: true },
      baseline_identity: { type: 'string' as const },
      baseline_project_root: { type: 'string' as const },
      latest_loader_cwd: { type: 'string' as const },
      latest_loader_project_root: { type: 'string' as const },
      budget_notice: { type: 'string' as const },
      instructions: {
        type: 'array' as const,
        required: true,
        items: {
          type: 'object' as const,
          additionalProperties: false,
          properties: {
            display_path: { type: 'string' as const, required: true },
            absolute_path: { type: 'string' as const, required: true },
            scope: { type: 'string' as const, required: true },
            bytes: { type: 'integer' as const, required: true },
            sha1: { type: 'string' as const },
            loader_sha1: { type: 'string' as const },
            loaded: { type: 'boolean' as const, required: true },
            digest: { type: 'string' as const },
            truncated: { type: 'boolean' as const, required: true },
            omitted: { type: 'boolean' as const, required: true },
            stale: { type: 'boolean' as const, required: true },
            deduplicated: { type: 'boolean' as const, required: true },
            duplicate_of: { type: 'string' as const },
            within_session_scope: { type: 'boolean' as const, required: true },
          },
        },
      },
      handoff: {
        type: 'array' as const,
        required: true,
        items: {
          type: 'object' as const,
          additionalProperties: false,
          properties: {
            path: { type: 'string' as const, required: true },
            bytes: { type: 'integer' as const, required: true },
            sha256: { type: 'string' as const, required: true },
            truncated: { type: 'boolean' as const, required: true },
            content: { type: 'string' as const, required: true },
          },
        },
      },
      evidence_runner: { type: 'string' as const },
      warnings: { type: 'array' as const, required: true, items: { type: 'string' as const } },
    },
  },
  render: (_args: unknown, value: ProjectContextToolOutput) => [{
    type: 'text' as const,
    text: renderProjectContext({
      ...value,
      baseline_identity: value.baseline_identity,
      baseline_project_root: value.baseline_project_root,
      latest_loader_cwd: value.latest_loader_cwd,
      latest_loader_project_root: value.latest_loader_project_root,
      budget_notice: value.budget_notice,
      evidence_runner: value.evidence_runner,
      instructions: value.instructions.map(instruction => ({
        absolutePath: instruction.absolute_path,
        displayPath: instruction.display_path,
        scope: instruction.scope,
        bytes: instruction.bytes,
        sha1: instruction.sha1,
        loaderSha1: instruction.loader_sha1,
        trimmedSha1: undefined,
        exists: true,
        sourceTooLarge: false,
        loaded: instruction.loaded,
        digest: instruction.digest,
        truncated: instruction.truncated,
        omitted: instruction.omitted,
        stale: instruction.stale,
        deduplicated: instruction.deduplicated,
        duplicateOf: instruction.duplicate_of,
        withinSessionScope: instruction.within_session_scope,
      })),
      handoff: value.handoff,
    }),
  }],
} as const

/**
 * Durable events of an Agent's session, tolerant of test fakes and disposed sessions.
 * @param agent - calling Agent.
 * @returns newest-last events, or an empty list when the log is unavailable.
 */
export function durableSessionEvents(agent: Agent): readonly unknown[] {
  try {
    const session = agent.session as unknown as {
      snapshotEvents?: () => readonly unknown[]
      surface?: { readonly nodes?: readonly number[] }
      eventAt?: (seq: number) => unknown
    }
    if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
    const nodes = session.surface?.nodes
    if (nodes !== undefined && typeof session.eventAt === 'function') {
      return nodes.map(seq => session.eventAt?.(seq)).filter(event => event !== undefined)
    }
  } catch {
    // A test fake or a disposed session has no readable event log.
  }
  return []
}

function renderProjectContext(report: ProjectContextReport): string {
  const loaded = report.instructions.filter(instruction => instruction.loaded)
  const lines = [
    `Project: ${report.project_dir}`,
    `Project root: ${report.project_root} (marker: ${report.root_marker})`,
    `Current cwd: ${report.session_cwd}`,
    ...(report.header_cwd === undefined ? [] : [`Session header cwd: ${report.header_cwd}`]),
    ...(report.baseline_cwd === undefined ? [] : [`Loader baseline cwd: ${report.baseline_cwd}`]),
    ...(report.latest_loader_cwd === undefined ? [] : [`Latest loader cwd: ${report.latest_loader_cwd}`]),
    ...(report.latest_loader_project_root === undefined ? [] : [`Latest loader project root: ${report.latest_loader_project_root}`]),
    `Cwd source: ${report.cwd_source}`,
    `Instruction loader: ${report.instruction_loader}; state: ${report.instruction_state}; project scope confirmed: ${String(report.project_scope_confirmed)}`,
  ]
  if (report.baseline_project_root !== undefined) {
    lines.push(`Loader baseline project root: ${report.baseline_project_root}`)
  }
  if (report.baseline_identity !== undefined) lines.push(`Baseline identity: ${report.baseline_identity}`)
  if (report.budget_notice !== undefined) lines.push(`Budget notice: ${report.budget_notice}`)
  lines.push(loaded.length === 0 ? 'Loaded instructions: none observed' : 'Loaded instructions:')
  for (const instruction of loaded) {
    lines.push(
      `- ${instruction.displayPath} (scope=${instruction.scope}, ${String(instruction.bytes)} bytes, `
      + `sha1=${instruction.sha1 ?? 'unknown'}, loader_sha1=${instruction.loaderSha1 ?? 'unknown'}, digest=${instruction.digest ?? 'unknown'}`
      + `${instruction.truncated ? ', TRUNCATED' : ''}${instruction.stale ? ', STALE' : ''})`,
    )
  }
  const deduplicated = report.instructions.filter(instruction => instruction.deduplicated)
  if (deduplicated.length > 0) {
    lines.push('Deduplicated within the same candidate group:')
    for (const instruction of deduplicated) {
      lines.push(`- ${instruction.displayPath} (covered by ${instruction.duplicateOf ?? 'an earlier file'})`)
    }
  }
  const missing = report.instructions.filter(instruction => (
    !instruction.loaded && !instruction.deduplicated
  ))
  if (missing.length > 0) {
    lines.push('Not retained by the loader:')
    for (const instruction of missing.slice(0, 16)) {
      const reason = instruction.omitted
        ? ' (omitted by budget)'
        : instruction.truncated
          ? ' (truncated)'
          : !instruction.withinSessionScope
            ? (report.project_scope_confirmed ? ' (outside this session scope)' : ' (unconfirmed)')
            : ''
      lines.push(`- ${instruction.displayPath}${reason}`)
    }
    if (missing.length > 16) lines.push(`- … ${String(missing.length - 16)} more`)
  }
  if (report.handoff.length > 0) {
    lines.push('Handoff documents:')
    for (const document of report.handoff) {
      lines.push(
        `--- ${document.path} (${String(document.bytes)} bytes, sha256=${document.sha256}`
        + `${document.truncated ? ', TRUNCATED' : ''}) ---`,
        document.content,
      )
    }
  }
  if (report.evidence_runner !== undefined) {
    lines.push(`Evidence runner: ${report.evidence_runner}`)
  } else {
    lines.push('Evidence runner: not found; use the path documented in the project AGENTS.md.')
  }
  if (report.warnings.length > 0) {
    lines.push('Warnings:')
    for (const warning of report.warnings) lines.push(`- ${warning}`)
  }
  return lines.join('\n')
}

const DESCRIPTION = 'Delegate one stretch of file search or file production to a standard-mode Code agent that appears in the desktop sidebar like a user-created session. '
  + 'Do the stretch in this chat when it is visible GUI or when one search or one command will answer or feed the next click. A second search that you expect will hit the point stays here. '
  + 'Do not call this tool for visible GUI work such as opening WeChat or clicking a button in Pages — use the GUI tools instead. '
  + 'Do not call this tool for a short lookup such as today\'s weather or current headlines — use web_search or web_fetch in this chat. '
  + 'Call this tool when you are still digging through files, searches, or commands, or when the user asked for a file, document, spreadsheet, or site. The last step being a click does not keep the investigation here. '
  + 'Omit session_id to create a new blank standard session: write a Word document, make a gobang game, write an HTML research report, or any task that is not a follow-up to a previous code_agent result. '
  + 'Pass session_id with the id returned by an earlier code_agent result when continuing the same artifact, for example making that Word document\'s font green, or another stretch of the same investigation. '
  + 'Do not pass a previous id when the new work is unrelated. '
  + 'session_id must be a session this Computer Use agent started. '
  + 'task is the stretch to enqueue. The call returns after the standard session accepts the message; it does not wait for that session to finish. '
  + 'Tell the user the background Code agent is running. Continue with a GUI action in this turn only when it does not need this result; otherwise end the turn. Do not call wait, long_wait, or bash sleep to poll that session. '
  + 'A plugin notice arrives later when that session is idle and this session is idle; then decide again: do remaining GUI, or call code_agent with that session_id for another stretch, and tell the user the short conclusion. Do not recite a long report. '
  + 'Pass cwd when the user named a path or said this folder and <frontmost_folder> is present. '
  + 'Omit cwd for a standalone artifact; when this Computer Use chat is inside a git project, the tool reuses that project directory so the background session inherits the same AGENTS.md chain. '
  + 'Pass project_context.project_dir when the task names a different project. '
  + 'session_id cannot target this Computer Use session, a subagent child, or a non-standard session.'

/**
 * Role text appended to every queued `code_agent` task.
 * The completion notice keeps the model task only.
 */
export const BACKGROUND_ROLE = 'You are the background worker for a Computer Use session. You do not see the screen and you do not talk to the user. '
  + 'If this task asks for a file, document, spreadsheet, or site, produce it, reply with its path, and stop. '
  + 'Otherwise search or run commands only until you can answer, including a second search when the first missed the point. '
  + 'Reply in a few sentences with the paths or results that matter, then stop. Do not write a report or create extra files.'

const RUNNING_RESULT = 'Tell the user the background Code agent is running. Continue with a GUI action in this turn only when it does not need this result; otherwise end the turn.'

/** Project scope prepended to a queued task so the worker knows which rules apply. */
export interface QueuedProjectScope {
  readonly projectDir: string
  readonly projectRoot: string
}

/**
 * User message queued on the standard session.
 * @param task - trimmed model task. The completion notice quotes this text, not the role.
 * @param scope - optional project directory/root. The instruction prose is still
 *   injected once by the official loader; this only names the scope and the rule.
 * @returns the task plus {@link BACKGROUND_ROLE}.
 */
export function queuedTaskText(task: string, scope?: QueuedProjectScope): string {
  if (scope === undefined) return `${task}\n\n${BACKGROUND_ROLE}`
  const root = scope.projectRoot === scope.projectDir
    ? ''
    : `\nProject root: ${scope.projectRoot}`
  return `Project scope: ${scope.projectDir}${root}\n`
    + 'The standard session loads the applicable AGENTS.md/CLAUDE.md chain from this project before this task. Follow those files; do not restate them. '
    + 'Save command evidence and distinguish command exit, test pass, deployment, and production verification as the project rules require.\n\n'
    + `${task}\n\n${BACKGROUND_ROLE}`
}

const STATUS_DESCRIPTION = 'List background Code agent sessions this Computer Use agent started. '
  + 'Returns the count plus each task name, working directory, and running or idle status. '
  + 'Does not include sessions from other Computer Use chats or the main window. '
  + 'Stopped and finished sessions stay listed as idle so they can be continued.'

const STOP_DESCRIPTION = 'Stop a background Code agent this Computer Use agent started. '
  + 'Cancels the current turn and drops queued follow-ups. The session stays idle so a later code_agent call with the same session_id can continue. '
  + 'Does not delete files. session_id is required and must be a session this Computer Use agent started.'

interface HeaderFacts {
  readonly id: SessionId
  readonly origin?: 'subagent'
  readonly agentPreset?: string
  readonly cwd?: string
  readonly parentSession?: SessionId
}

function requireAgent(exec: { agent?: { id: SessionId; session: { header: HeaderFacts } } }): {
  id: SessionId
  session: { header: HeaderFacts }
} {
  if (exec.agent === undefined) {
    throw new Error('code_agent requires a calling Computer Use session')
  }
  return exec.agent
}

/**
 * Directory name derived from the user task.
 * @param task - non-empty trimmed task text.
 * @returns a filesystem-safe slug, or `task` when nothing remains.
 */
export function slugFromTask(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug === '' ? 'task' : slug
}

/**
 * Unique child directory under `parent`.
 * @param parent - Computer Use session cwd.
 * @param slug - {@link slugFromTask} result.
 * @returns `join(parent, slug)` or a numeric suffix when that path exists.
 */
export function uniqueDirectory(parent: string, slug: string): string {
  const base = join(parent, slug)
  if (!existsSync(base)) return base
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`
    if (!existsSync(candidate)) return candidate
  }
  return `${base}-${randomUUID().slice(0, 8)}`
}

/**
 * Resolve a Workspace id when `directory` is already registered.
 * @param ctx - Host context; `workspaceRegistry` is optional.
 * @param directory - session cwd or explicit `code_agent` cwd.
 * @returns the branded Workspace id, or undefined when none matches.
 */
async function workspaceIdForDirectory(
  ctx: Context,
  directory: string | undefined,
): Promise<WorkspaceId | undefined> {
  if (directory === undefined || directory === '') return undefined
  const registry = ctx.get('workspaceRegistry') as
    | { resolveByPath(path: string): Promise<{ id: string } | undefined> }
    | undefined
  if (registry === undefined || typeof registry.resolveByPath !== 'function') return undefined
  try {
    const id = (await registry.resolveByPath(directory))?.id
    return id === undefined ? undefined : brandString<WorkspaceId>(id)
  } catch {
    // Missing or relative directories cannot join a Workspace record.
    return undefined
  }
}

/**
 * Prefer `workspaceId` so the new session appears under that sidebar folder.
 * @param ctx - Host context; `workspaceRegistry` is optional.
 * @param directory - session cwd or explicit `code_agent` cwd.
 * @returns create fields that `session.create` accepts together.
 */
async function locationForCreate(
  ctx: Context,
  directory: string | undefined,
): Promise<Pick<SessionCreateRequest, 'workspaceId'> | Pick<SessionCreateRequest, 'cwd'> | Record<string, never>> {
  const workspaceId = await workspaceIdForDirectory(ctx, directory)
  if (workspaceId !== undefined) return { workspaceId }
  if (directory === undefined) return {}
  return { cwd: directory }
}

function ownedBySubagent(
  ctx: Context,
  header: HeaderFacts,
): boolean {
  const parentId = header.parentSession
  if (parentId === undefined) return false
  const agents = ctx.get('agents')
  if (agents === undefined) return false
  const live = agents.get(header.id)
  const parent = agents.get(parentId)
  return live !== undefined && parent !== undefined && agents.isOwnedBy(live.id, parent)
}

function callerDelegations(
  byCaller: Map<SessionId, Map<SessionId, Delegation>>,
  callerId: SessionId,
): Map<SessionId, Delegation> {
  const existing = byCaller.get(callerId)
  if (existing !== undefined) return existing
  const created = new Map<SessionId, Delegation>()
  byCaller.set(callerId, created)
  return created
}

function rememberCaller(
  liveCaller: Agent,
  callerId: SessionId,
  byCaller: Map<SessionId, Map<SessionId, Delegation>>,
  remembered: WeakSet<Agent>,
  registry: { dropCaller(callerId: SessionId): void },
): void {
  if (remembered.has(liveCaller)) return
  remembered.add(liveCaller)
  try {
    liveCaller.ctx.effect(() => {
      return () => {
        byCaller.delete(callerId)
        registry.dropCaller(callerId)
        remembered.delete(liveCaller)
      }
    })
  } catch {
    remembered.delete(liveCaller)
    byCaller.delete(callerId)
  }
}

function recordDelegation(
  delegations: Map<SessionId, Delegation>,
  sessionId: SessionId,
  task: string,
  cwd: string,
  watch: AbortController | undefined,
): void {
  const existing = delegations.get(sessionId)
  if (existing === undefined) {
    delegations.set(sessionId, {
      task,
      cwd,
      watches: watch === undefined ? [] : [watch],
    })
    return
  }
  // Continuing a session ends the previous stretch's watch: its whenIdle() would otherwise
  // resolve in the gap before this task starts and report the old stretch as this one.
  for (const previous of existing.watches.splice(0)) previous.abort()
  existing.task = task
  existing.cwd = cwd
  if (watch !== undefined) existing.watches.push(watch)
}

/**
 * Register `code_agent`, `code_agent_status`, and `code_agent_stop` on the
 * calling Computer Use tool layer.
 * @param ctx - registration scope; `inject` must already be satisfied.
 */
export function apply(ctx: Context): void {
  const byCaller = new Map<SessionId, Map<SessionId, Delegation>>()
  const rememberedCallers = new WeakSet<Agent>()
  const unattended = new WeakSet<Agent>()
  // Provided app-level (code-agent-registry's apply): a provide from inside
  // this preset fails the official mount audit ("Preset services require
  // isolate realms: codeAgentRegistry").
  const registry = sharedCodeAgentRegistry()

  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      task: {
        type: 'string',
        required: true,
        description: 'User message to enqueue on a standard session. Required.',
      },
      session_id: {
        type: 'string',
        description:
          'Existing standard session this Computer Use agent started. Omit to create a blank session. '
          + 'Required when following up on the same artifact; forbidden when starting unrelated work.',
      },
      cwd: {
        type: 'string',
        description:
          'Workspace directory for a newly created session. Pass project_context.project_dir, a named path, or <frontmost_folder>. '
          + 'Omit for a standalone artifact; inside a git project the caller\'s project directory is reused. '
          + 'When continuing an existing session, omit it or pass the session\'s actual current directory; a different value is rejected and never changes the live session.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
          created: { type: 'boolean', required: true },
          session_id: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.created
          ? `Started a new standard session ${value.session_id}. ${RUNNING_RESULT} Pass this session_id to continue the same artifact.`
          : `Queued on standard session ${value.session_id}. ${RUNNING_RESULT}`,
      }],
    },
    isConcurrencySafe: () => true,
    presentCall: args => ({
      card: 'generic',
      title: 'Code agent',
      kind: 'execute',
      rawInput: {
        task: args.task,
        ...(args.session_id === undefined ? {} : { session_id: args.session_id }),
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      },
    }),
    async execute(args, exec) {
      const caller = requireAgent(exec)
      const task = args.task.trim()
      if (task === '') throw new Error('code_agent task must include non-whitespace text')
      if (args.session_id !== undefined && args.session_id.trim() === '') {
        throw new Error('code_agent session_id must be omitted or a non-empty id')
      }
      const delegations = callerDelegations(byCaller, caller.id)
      const agents = ctx.get('agents')
      const liveCaller = agents?.get(caller.id)
      let sessionId: SessionId
      let created = false
      let cwd: string
      let projectScope: QueuedProjectScope | undefined
      if (args.session_id === undefined) {
        const callerCwd = (liveCaller === undefined ? undefined : currentWorkingDirectory(ctx, liveCaller.session))
          ?? caller.session.header.cwd
        const callerProject = callerCwd === undefined ? undefined : findProjectRoot(callerCwd)
        // A code task that stays inside a git project reuses that directory instead of
        // minting a child the loader would have to climb out of. Non-project workspaces
        // keep the old "new subdirectory per task" behavior for standalone artifacts.
        const projectDirectory = callerProject?.marker === '.git' ? callerCwd : undefined
        const directory = args.cwd !== undefined
          ? args.cwd
          : projectDirectory
            ?? (callerCwd === undefined ? undefined : uniqueDirectory(callerCwd, slugFromTask(task)))
        const minted = args.cwd === undefined && projectDirectory === undefined && directory !== undefined
        const location = minted
          ? { cwd: directory }
          : await locationForCreate(ctx, directory)
        const createdSession = await ctx.sessionController.create({
          agentPreset: 'standard',
          ...location,
        })
        sessionId = createdSession.sessionId
        created = true
        cwd = directory ?? caller.session.header.cwd ?? ''
        const root = directory === undefined ? undefined : findProjectRoot(directory)
        if (directory !== undefined && root?.marker === '.git') {
          projectScope = { projectDir: directory, projectRoot: root.root }
        }
        const pref = (ctx.get('orbCodeAgentModel') as OrbCodeAgentModel | undefined)?.currentSelection()
        if (pref !== undefined) {
          await selectModelKeepDefault({
            sessionController: ctx.sessionController,
            agentDefaultModel: ctx.get('agentDefaultModel') as SelectModelKeepDefaultHost['agentDefaultModel'],
          }, {
            sessionId,
            provider: pref.provider,
            model: pref.model,
            ...(pref.reasoningEffort === undefined ? {} : { reasoningEffort: pref.reasoningEffort }),
          })
        }
      } else {
        sessionId = brandString<SessionId>(args.session_id)
        if (sessionId === caller.id) {
          throw new Error('code_agent cannot target this Computer Use session')
        }
        const known = delegations.get(sessionId)
        if (known === undefined) {
          throw new Error(
            `code_agent can continue only a session this Computer Use agent started, not "${sessionId}"`,
          )
        }
        const inspected = await ctx.sessionController.inspect(sessionId)
        const header = inspected.meta
        if (header.origin === 'subagent' || ownedBySubagent(ctx, header)) {
          throw new Error(`code_agent cannot continue subagent session "${sessionId}"`)
        }
        if (header.agentPreset !== 'standard') {
          throw new Error(`code_agent can continue only a standard session, not "${header.agentPreset ?? 'unknown'}"`)
        }
        const liveCode = agents?.get(sessionId)
        const liveCwd = liveCode === undefined
          ? undefined
          : currentWorkingDirectory(ctx, liveCode.session)
            ?? directoryFromEvents(sessionEvents(liveCode.session), header.cwd)
        const coldCwd = directoryFromEvents(inspected.events, header.cwd)
        const actualCwd = liveCwd ?? coldCwd
        if (actualCwd === undefined) {
          throw new Error(`code_agent cannot determine the current directory of session "${sessionId}"; refusing to queue without a verified working directory`)
        }
        if (args.cwd !== undefined && !samePath(args.cwd, actualCwd)) {
          throw new Error(`code_agent cwd "${args.cwd}" does not match the current directory "${actualCwd}" of session "${sessionId}"; the session was not changed`)
        }
        cwd = actualCwd
        const root = findProjectRoot(cwd)
        if (root.marker === '.git') projectScope = { projectDir: cwd, projectRoot: root.root }
      }
      const requestId = brandString<SessionRequestId>(`code-agent-${randomUUID()}`)
      await ctx.sessionController.prompt({
        requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: queuedTaskText(task, projectScope) }],
      }, exec.signal)
      const code = agents?.get(sessionId)
      if (liveCaller !== undefined) {
        rememberCaller(liveCaller, caller.id, byCaller, rememberedCallers, registry)
      }
      if (code !== undefined) attachUnattendedCodeAgent(code, unattended)
      let watch: AbortController | undefined
      if (agents !== undefined && liveCaller !== undefined && code !== undefined) {
        watch = watchCodeAgentCompletion({
          caller: liveCaller,
          code,
          agents,
          task,
          sessionId,
          requestId,
        })
      }
      recordDelegation(delegations, sessionId, task, cwd, watch)
      registry.record({
        sessionId,
        callerId: caller.id,
        task,
        cwd,
        requestId,
        ...(watch === undefined ? {} : { watch }),
        ...(code === undefined ? {} : { agent: code }),
      })
      return { accepted: true, created, session_id: sessionId }
    },
  }))

  ctx.tools.register(defineTool({
    name: PROJECT_CONTEXT_TOOL_NAME,
    description: PROJECT_CONTEXT_DESCRIPTION,
    parameters: PROJECT_CONTEXT_PARAMETERS,
    output: PROJECT_CONTEXT_OUTPUT,
    isConcurrencySafe: () => true,
    presentCall: args => ({
      card: 'generic',
      title: 'Project context',
      kind: 'read',
      rawInput: {
        ...(args.project_dir === undefined ? {} : { project_dir: args.project_dir }),
        ...(args.handoff === undefined ? {} : { handoff: args.handoff }),
      },
    }),
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const live = exec.agent
      if (live === undefined) throw new Error('project_context requires a calling Computer Use session')
      const headerCwd = agent.session.header.cwd
      const serviceCwd = currentWorkingDirectory(ctx, live.session)
      const sessionCwd = serviceCwd ?? headerCwd
      const report = await collectProjectContext({
        sessionCwd,
        headerCwd,
        cwdSource: serviceCwd === undefined ? 'unknown' : 'service',
        projectDir: args.project_dir,
        handoff: args.handoff,
        evidenceRunner: resolveEvidenceRunner(import.meta.url),
      }, durableSessionEvents(live))
      return {
        session_cwd: report.session_cwd,
        ...(report.header_cwd === undefined ? {} : { header_cwd: report.header_cwd }),
        ...(report.baseline_cwd === undefined ? {} : { baseline_cwd: report.baseline_cwd }),
        cwd_source: report.cwd_source,
        project_dir: report.project_dir,
        project_root: report.project_root,
        root_marker: report.root_marker,
        instruction_state: report.instruction_state,
        instruction_loader: report.instruction_loader,
        project_scope_confirmed: report.project_scope_confirmed,
        ...(report.baseline_identity === undefined ? {} : { baseline_identity: report.baseline_identity }),
        ...(report.baseline_project_root === undefined ? {} : { baseline_project_root: report.baseline_project_root }),
        ...(report.latest_loader_cwd === undefined ? {} : { latest_loader_cwd: report.latest_loader_cwd }),
        ...(report.latest_loader_project_root === undefined ? {} : { latest_loader_project_root: report.latest_loader_project_root }),
        ...(report.budget_notice === undefined ? {} : { budget_notice: report.budget_notice }),
        instructions: report.instructions.map(instruction => ({
          display_path: instruction.displayPath,
          absolute_path: instruction.absolutePath,
          scope: instruction.scope,
          bytes: instruction.bytes,
          ...(instruction.sha1 === undefined ? {} : { sha1: instruction.sha1 }),
          ...(instruction.loaderSha1 === undefined ? {} : { loader_sha1: instruction.loaderSha1 }),
          loaded: instruction.loaded,
          ...(instruction.digest === undefined ? {} : { digest: instruction.digest }),
          truncated: instruction.truncated,
          omitted: instruction.omitted,
          stale: instruction.stale,
          deduplicated: instruction.deduplicated,
          ...(instruction.duplicateOf === undefined ? {} : { duplicate_of: instruction.duplicateOf }),
          within_session_scope: instruction.withinSessionScope,
        })),
        handoff: [...report.handoff],
        ...(report.evidence_runner === undefined ? {} : { evidence_runner: report.evidence_runner }),
        warnings: [...report.warnings],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: STATUS_TOOL_NAME,
    description: STATUS_DESCRIPTION,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          tasks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                session_id: { type: 'string', required: true },
                task: { type: 'string', required: true },
                cwd: { type: 'string', required: true },
                status: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.count === 0
          ? 'No background Code agent sessions from this Computer Use chat.'
          : value.tasks.map(entry => (
            `${entry.session_id}: ${entry.status} — ${entry.task} (${entry.cwd})`
          )).join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({
      card: 'generic',
      title: 'Code agent status',
      kind: 'read',
    }),
    async execute(_args, exec) {
      const caller = requireAgent(exec)
      const agents = ctx.get('agents')
      const tasks = [...(byCaller.get(caller.id) ?? [])].map(([sessionId, entry]) => ({
        session_id: sessionId,
        task: entry.task,
        cwd: entry.cwd,
        status: agents?.get(sessionId)?.status === 'running' ? 'running' : 'idle',
      }))
      return { count: tasks.length, tasks }
    },
  }))

  ctx.tools.register(defineTool({
    name: STOP_TOOL_NAME,
    description: STOP_DESCRIPTION,
    parameters: {
      session_id: {
        type: 'string',
        required: true,
        description: 'Background Code agent session this Computer Use agent started. Required.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
          session_id: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Stopped background Code agent session ${value.session_id}. `
          + 'The session is idle. Pass this session_id to code_agent to continue the same artifact.',
      }],
    },
    isConcurrencySafe: () => true,
    presentCall: args => ({
      card: 'generic',
      title: 'Stop Code agent',
      kind: 'execute',
      rawInput: { session_id: args.session_id },
    }),
    async execute(args, exec) {
      const caller = requireAgent(exec)
      const sessionIdText = args.session_id.trim()
      if (sessionIdText === '') {
        throw new Error('code_agent_stop session_id must be a non-empty id')
      }
      const sessionId = brandString<SessionId>(sessionIdText)
      const known = byCaller.get(caller.id)?.get(sessionId)
      if (known === undefined) {
        throw new Error(
          `code_agent_stop can stop only a session this Computer Use agent started, not "${sessionId}"`,
        )
      }
      for (const watch of known.watches.splice(0)) watch.abort()
      registry.markStopped(sessionId)
      ctx.get('agents')?.get(sessionId)?.cancel({ kind: 'user' })
      return { accepted: true, session_id: sessionId }
    },
  }))
}
