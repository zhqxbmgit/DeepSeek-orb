/**
 * Read-only project scope discovery for the Computer Use toolbar.
 *
 * The official `@deepseek-ai/dsh-agent-instructions` plugin remains the only
 * component that injects instruction prose. This module only discovers the
 * candidate chain, reads the loader's durable change records, and bounds any
 * handoff document the user names explicitly. It never walks `docs/` or any
 * other directory recursively.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/project-context
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Maximum source size the official loader reads before omitting a file. */
export const MAX_INSTRUCTION_SOURCE_BYTES = 1_048_576

/** Maximum instruction files reported in one response. */
export const MAX_INSTRUCTION_FILES = 64

/** Maximum handoff documents one call may name. */
export const MAX_HANDOFF_FILES = 4

/** Bytes of one handoff document returned to the model. */
export const MAX_HANDOFF_BYTES_PER_FILE = 16_384

/** Total handoff bytes returned to the model. */
export const MAX_HANDOFF_BYTES_TOTAL = 32_768

/** Maximum characters of an instruction-budget notice retained for display. */
export const MAX_BUDGET_NOTICE_CHARS = 2_000

const CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'] as const
const USER_GLOBAL = [
  { name: 'AGENTS.md', displayPath: '~/.dsh/AGENTS.md', path: (home: string) => join(home, '.dsh', 'AGENTS.md') },
  { name: 'AGENTS.md', displayPath: '~/.agents/AGENTS.md', path: (home: string) => join(home, '.agents', 'AGENTS.md') },
] as const

/** One directory between a project root and the session working directory. */
export interface ProjectRoot {
  readonly root: string
  readonly marker: string | undefined
}

/** Metadata for one instruction candidate, whether or not it exists. */
export interface InstructionCandidate {
  readonly absolutePath: string
  readonly displayPath: string
  readonly scope: string
  readonly bytes: number
  /** SHA-1 of the bytes on disk; evidence only, not the loader's content digest. */
  readonly sha1: string | undefined
  /** SHA-1 of the UTF-8 text after the loader's leading-BOM removal. */
  readonly loaderSha1: string | undefined
  readonly trimmedSha1: string | undefined
  readonly exists: boolean
  readonly sourceTooLarge: boolean
}

/** One file the official loader reported as retained for the session. */
export interface LoadedInstruction {
  readonly scope: string
  readonly path: string
  readonly digest: string | undefined
  readonly baseline: boolean
  /** Effective cwd at the loader message that produced this entry. */
  readonly cwd: string | undefined
  /**
   * Project root that `path` is relative to at the time of this loader
   * message. The official loader reports project-relative display paths and
   * its baseline identity records the root relative to the current cwd; the
   * two must not be conflated when the session runs in a subdirectory.
   * Undefined when the durable evidence cannot prove the root.
   */
  readonly projectRoot: string | undefined
}

/** What the durable session log says the official loader injected. */
export interface InstructionObservation {
  readonly observed: boolean
  readonly baselineIdentity: string | undefined
  readonly baselineIdentityValid: boolean
  readonly baselineProjectRootRelative: string | undefined
  readonly loaded: readonly LoadedInstruction[]
  readonly removed: readonly string[]
  readonly budgetNotice: string | undefined
  /** cwd of the latest baseline or incremental loader message. */
  readonly latestLoaderCwd: string | undefined
  /** Project root proved for that latest loader message. */
  readonly latestLoaderProjectRoot: string | undefined
}

/** One instruction candidate joined with the loader's actual state. */
export interface InstructionFileState extends InstructionCandidate {
  readonly loaded: boolean
  readonly digest: string | undefined
  readonly truncated: boolean
  readonly omitted: boolean
  readonly stale: boolean
  readonly deduplicated: boolean
  readonly duplicateOf: string | undefined
  readonly withinSessionScope: boolean
}

/** One explicit handoff document, bounded before it enters model context. */
export interface HandoffDocument {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  readonly truncated: boolean
  readonly content: string
}

/** Everything the `project_context` tool reports. */
export interface ProjectContextReport {
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
  readonly baseline_identity: string | undefined
  readonly baseline_project_root: string | undefined
  /** cwd of the latest loader baseline or incremental update. */
  readonly latest_loader_cwd: string | undefined
  /** Project root those latest loader paths are relative to. */
  readonly latest_loader_project_root: string | undefined
  readonly budget_notice: string | undefined
  readonly instructions: readonly InstructionFileState[]
  readonly handoff: readonly HandoffDocument[]
  readonly evidence_runner: string | undefined
  readonly warnings: readonly string[]
}

/** Input the tool passes to {@link collectProjectContext}. */
export interface ProjectContextInput {
  readonly sessionCwd: string | undefined
  readonly headerCwd?: string | undefined
  readonly cwdSource?: 'service' | 'unknown'
  readonly projectDir: string | undefined
  readonly handoff: readonly string[] | undefined
  readonly home?: string
  readonly evidenceRunner?: string | undefined
}

interface InstructionEvent {
  readonly type?: unknown
  readonly data?: unknown
}

/**
 * Find the nearest ancestor carrying `.git`, mirroring the official loader's
 * default `projectRootMarkers: ['.git']` behavior. A missing marker leaves the
 * selected directory as the project root.
 * @param start - directory the task was launched from.
 * @returns the root and the marker name that proved it.
 */
export function findProjectRoot(start: string): ProjectRoot {
  const from = resolve(start)
  let directory = from
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(join(directory, '.git'))) return { root: directory, marker: '.git' }
    const parent = resolve(directory, '..')
    if (parent === directory) break
    directory = parent
  }
  return { root: from, marker: undefined }
}

/** Whether `child` is `parent` or below it. */
export function isUnder(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function displayPath(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath)
  return rel === '' ? '.' : rel.replaceAll('\\', '/')
}

function scopeFor(root: string, directory: string): string {
  const rel = displayPath(root, directory)
  return rel === '.' ? '.' : rel
}

function ancestorChain(root: string, cwd: string): string[] {
  if (!isUnder(root, cwd)) return [root]
  const chain = [root]
  const rel = relative(root, cwd)
  if (rel === '') return chain
  let current = root
  for (const part of rel.split(/[\\/]/u)) {
    if (part === '' || part === '.') continue
    current = join(current, part)
    chain.push(current)
  }
  return chain
}

function hashFile(path: string, algorithm: 'sha1' | 'sha256'): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash(algorithm)
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', rejectHash)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

/**
 * Reproduce the official loader's UTF-8 text semantics: decode the bytes, strip
 * one leading U+FEFF, and preserve every other character including line endings.
 * This is deliberately narrower than trimming or newline normalization.
 * @param bytes - raw instruction file bytes.
 * @returns text the official loader content digest covers.
 */
export function loaderInstructionText(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString('utf8')
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
}

function sha1Text(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

function candidateState(
  absolutePath: string,
  requestedDisplay: string,
  scope: string,
  size: number,
  sha1: string | undefined,
  loaderSha1: string | undefined,
  trimmedSha1: string | undefined,
  sourceTooLarge: boolean,
): InstructionCandidate {
  return {
    absolutePath,
    displayPath: requestedDisplay,
    scope,
    bytes: size,
    sha1,
    loaderSha1,
    trimmedSha1,
    exists: true,
    sourceTooLarge,
  }
}

/**
 * Discover the user-global and project instruction chain. This only stats and
 * hashes files; instruction prose is not returned and therefore is not injected
 * a second time.
 * @param projectRoot - root selected by {@link findProjectRoot}.
 * @param cwd - session/task working directory.
 * @param home - user home for the two user-global candidates.
 * @returns existing candidate files in official broad-to-specific order.
 */
export async function discoverInstructionCandidates(
  projectRoot: string,
  cwd: string,
  home = homedir(),
): Promise<InstructionCandidate[]> {
  const files: InstructionCandidate[] = []
  const seen = new Set<string>()

  for (const entry of USER_GLOBAL) {
    const absolutePath = entry.path(home)
    if (seen.has(absolutePath) || !existsSync(absolutePath)) continue
    seen.add(absolutePath)
    const info = statSync(absolutePath)
    if (!info.isFile()) continue
    const sourceTooLarge = info.size > MAX_INSTRUCTION_SOURCE_BYTES
    const content = sourceTooLarge ? undefined : await readFile(absolutePath)
    const loaderText = content === undefined ? undefined : loaderInstructionText(content)
    files.push(candidateState(
      absolutePath,
      entry.displayPath,
      'user-global',
      info.size,
      content === undefined ? undefined : createHash('sha1').update(content).digest('hex'),
      loaderText === undefined ? undefined : sha1Text(loaderText),
      loaderText === undefined ? undefined : sha1Text(loaderText.trim()),
      sourceTooLarge,
    ))
  }

  for (const directory of ancestorChain(projectRoot, cwd)) {
    for (const name of CANDIDATES) {
      const absolutePath = join(directory, name)
      if (seen.has(absolutePath) || !existsSync(absolutePath)) continue
      seen.add(absolutePath)
      const info = statSync(absolutePath)
      if (!info.isFile()) continue
      const sourceTooLarge = info.size > MAX_INSTRUCTION_SOURCE_BYTES
      const content = sourceTooLarge ? undefined : await readFile(absolutePath)
      const loaderText = content === undefined ? undefined : loaderInstructionText(content)
      files.push(candidateState(
        absolutePath,
        displayPath(projectRoot, absolutePath),
        scopeFor(projectRoot, directory),
        info.size,
        content === undefined ? undefined : createHash('sha1').update(content).digest('hex'),
        loaderText === undefined ? undefined : sha1Text(loaderText),
        loaderText === undefined ? undefined : sha1Text(loaderText.trim()),
        sourceTooLarge,
      ))
      if (files.length >= MAX_INSTRUCTION_FILES) return files
    }
  }
  return files
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function messageText(data: Record<string, unknown>): string {
  const content = data.content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      const record = asRecord(block)
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .join('\n')
}

function changesOf(source: Record<string, unknown>): Array<{
  action: 'set' | 'replace' | 'remove'
  scope: string
  path: string
  digest?: string
}> {
  if (!Array.isArray(source.changes)) return []
  const changes: Array<{ action: 'set' | 'replace' | 'remove'; scope: string; path: string; digest?: string }> = []
  for (const value of source.changes) {
    const change = asRecord(value)
    if (change === undefined) continue
    const action = change.action
    if (action !== 'set' && action !== 'replace' && action !== 'remove') continue
    if (typeof change.scope !== 'string' || typeof change.path !== 'string') continue
    const digest = typeof change.digest === 'string' ? change.digest : undefined
    changes.push({
      action,
      scope: change.scope,
      path: change.path,
      ...(digest === undefined ? {} : { digest }),
    })
  }
  return changes
}

function parseBaselineIdentity(raw: string | undefined): { projectRootRelative: string } | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  try {
    const parsed = asRecord(JSON.parse(raw))
    if (parsed === undefined || typeof parsed.projectRoot !== 'string') return undefined
    return { projectRootRelative: parsed.projectRoot }
  } catch {
    return undefined
  }
}

/**
 * Read the official loader's durable `agent-instructions` messages. A complete
 * baseline replaces the earlier retained state; incremental updates merge into
 * the latest baseline. The identity is kept so callers can prove which project
 * the loader actually read.
 * @param events - durable session events, newest last.
 * @returns retained changes, removals, identity, and the latest budget notice.
 */
export function instructionObservationFrom(
  events: readonly unknown[],
  headerCwd?: string | undefined,
): InstructionObservation {
  let retained = new Map<string, LoadedInstruction>()
  let removed = new Set<string>()
  let observed = false
  let baselineIdentity: string | undefined
  let baselineIdentityValid = false
  let baselineProjectRootRelative: string | undefined
  let budgetNotice: string | undefined
  let latestLoaderCwd: string | undefined
  let latestLoaderProjectRoot: string | undefined
  let currentCwd = headerCwd === undefined ? undefined : resolve(headerCwd)
  /**
   * Root of the baseline that is still in force. A loader change path is a
   * project-relative display path; it is never relative to the current cwd.
   */
  let currentProjectRoot: string | undefined

  for (const raw of events as readonly InstructionEvent[]) {
    const event = asRecord(raw)
    if (event?.type === 'working-directory/change') {
      const cwd = asRecord(event.data)?.cwd
      if (typeof cwd === 'string' && cwd.trim() !== '') {
        currentCwd = resolve(cwd)
        // The stored relative root was computed against the previous cwd, so it
        // cannot follow the switch. Until the loader emits a fresh identity, the
        // default `.git` marker is the only durable path evidence; without that
        // marker the new message stays unconfirmed.
        const marker = findProjectRoot(currentCwd)
        currentProjectRoot = marker.marker === '.git' ? marker.root : undefined
      }
      continue
    }
    if (event?.type !== 'user/message') continue
    const data = asRecord(event.data)
    const source = asRecord(data?.source)
    if (source?.kind !== 'agent-instructions') continue
    observed = true
    latestLoaderCwd = currentCwd
    const isBaseline = source.baseline === true
    if (isBaseline) {
      // The loader sends a complete baseline after resume, cwd change, or a
      // rebuilt instruction chain. Earlier retained paths are not evidence for
      // the new baseline and must not leak across a project switch.
      retained = new Map()
      removed = new Set()
      budgetNotice = undefined
      baselineIdentity = typeof source.baselineIdentity === 'string' ? source.baselineIdentity : undefined
      const parsedIdentity = parseBaselineIdentity(baselineIdentity)
      baselineIdentityValid = parsedIdentity !== undefined
      baselineProjectRootRelative = parsedIdentity?.projectRootRelative
      currentProjectRoot = currentCwd !== undefined && baselineProjectRootRelative !== undefined
        ? resolve(currentCwd, baselineProjectRootRelative)
        : undefined
    } else if (typeof source.baselineIdentity === 'string') {
      baselineIdentity = source.baselineIdentity
      const parsedIdentity = parseBaselineIdentity(baselineIdentity)
      if (parsedIdentity !== undefined) {
        baselineIdentityValid = true
        baselineProjectRootRelative = parsedIdentity.projectRootRelative
        currentProjectRoot = currentCwd === undefined
          ? undefined
          : resolve(currentCwd, baselineProjectRootRelative)
      }
    }
    // An incremental message normally carries no identity. It continues the
    // baseline root already in force; after a cwd change without a new identity
    // that root is undefined above, so its paths stay unconfirmed.
    latestLoaderProjectRoot = currentProjectRoot
    if (typeof data !== 'undefined') {
      const notice = /Workspace instruction budget [^\r\n]*/u.exec(messageText(data))
      if (notice !== null) budgetNotice = notice[0].slice(0, MAX_BUDGET_NOTICE_CHARS)
      else if (isBaseline) budgetNotice = undefined
    }
    for (const change of changesOf(source)) {
      if (change.action === 'remove') {
        retained.delete(change.scope)
        removed.add(change.path)
        continue
      }
      removed.delete(change.path)
      retained.set(change.scope, {
        scope: change.scope,
        path: change.path,
        digest: change.digest,
        baseline: isBaseline,
        cwd: currentCwd,
        projectRoot: currentProjectRoot,
      })
    }
  }

  return {
    observed,
    baselineIdentity,
    baselineIdentityValid,
    baselineProjectRootRelative,
    loaded: [...retained.values()].sort((left, right) => left.path.localeCompare(right.path)),
    removed: [...removed].sort(),
    budgetNotice,
    latestLoaderCwd,
    latestLoaderProjectRoot,
  }
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function baselineProjectRoot(
  observation: InstructionObservation,
  baselineCwd: string | undefined,
): string | undefined {
  if (baselineCwd === undefined || !observation.baselineIdentityValid || observation.baselineProjectRootRelative === undefined) return undefined
  return resolve(baselineCwd, observation.baselineProjectRootRelative)
}

/**
 * Reconstruct the working directory that was effective when the latest loader
 * baseline was written. A later `working-directory/change` must not retroactively
 * give an older baseline a new project identity.
 * @param events - durable session events, oldest first.
 * @param headerCwd - directory recorded at Session creation.
 * @returns the latest baseline's cwd and whether a change event supplied it.
 */
export function baselineCwdFromEvents(
  events: readonly unknown[],
  headerCwd: string | undefined,
): string | undefined {
  let current = headerCwd
  let baselineCwd: string | undefined
  for (const raw of events as readonly InstructionEvent[]) {
    const event = asRecord(raw)
    if (event?.type === 'working-directory/change') {
      const cwd = asRecord(event.data)?.cwd
      if (typeof cwd === 'string' && cwd.trim() !== '') current = resolve(cwd)
      continue
    }
    if (event?.type !== 'user/message') continue
    const sourceRecord = asRecord(asRecord(event.data)?.source)
    if (sourceRecord?.kind !== 'agent-instructions' || sourceRecord.baseline !== true) continue
    baselineCwd = current
  }
  return baselineCwd
}

function pathFromDisplay(display: string, projectRoot: string, home: string): string {
  if (display === '~/.dsh/AGENTS.md' || display === '$DSH_HOME/AGENTS.md') {
    return join(process.env.DSH_HOME ?? join(home, '.dsh'), 'AGENTS.md')
  }
  if (display === '~/.agents/AGENTS.md' || display === '$DSH_AGENTS_HOME/AGENTS.md') {
    return join(process.env.DSH_AGENTS_HOME ?? join(home, '.agents'), 'AGENTS.md')
  }
  if (isAbsolute(display)) return resolve(display)
  return resolve(projectRoot, display)
}

function loadedEntryFor(
  candidate: InstructionCandidate,
  observation: InstructionObservation,
  baselineRoot: string | undefined,
  home: string,
): LoadedInstruction | undefined {
  return observation.loaded.find((entry) => {
    // `path` is a project-relative display path. `cwd` only identifies the
    // directory that was current when the loader produced the evidence; using
    // it as the resolution base invents paths such as src/src/AGENTS.md.
    const projectRoot = entry.projectRoot ?? baselineRoot
    if (projectRoot === undefined) return false
    const loadedPath = pathFromDisplay(entry.path, projectRoot, home)
    return samePath(loadedPath, candidate.absolutePath)
  })
}

function candidateGroup(candidate: InstructionCandidate): string {
  if (candidate.displayPath.startsWith('~/')) return 'user-global'
  const group = dirname(candidate.absolutePath)
  return process.platform === 'win32' ? group.toLowerCase() : group
}

function isUserGlobalCandidate(candidate: InstructionCandidate): boolean {
  return candidate.displayPath.startsWith('~/')
}

function withinSessionScope(
  candidate: InstructionCandidate,
  baselineRoot: string | undefined,
  sessionCwd: string,
): boolean {
  if (isUserGlobalCandidate(candidate)) return baselineRoot !== undefined
  if (baselineRoot === undefined) return false
  const directory = dirname(candidate.absolutePath)
  return isUnder(baselineRoot, directory) && isUnder(directory, sessionCwd)
}

function noticeMentions(notice: string | undefined, path: string, kind: 'omitted' | 'truncated'): boolean {
  if (notice === undefined) return false
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const pattern = kind === 'omitted'
    ? new RegExp(`omitted [^;]*${escaped}`, 'u')
    : new RegExp(`truncated [^;]*${escaped} from \\d+ to \\d+ bytes`, 'u')
  return pattern.test(notice)
}

function clipWarning(warning: string): string {
  return warning.length <= 500 ? warning : `${warning.slice(0, 499)}…`
}

async function boundedHandoff(
  path: string,
  baseDir: string,
  maxBytes: number,
): Promise<HandoffDocument> {
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(baseDir, path)
  const info = await stat(absolutePath)
  if (!info.isFile()) throw new Error(`project_context handoff is not a file: ${absolutePath}`)
  const included = Math.min(info.size, maxBytes)
  const buffer = Buffer.alloc(included)
  const handle = await open(absolutePath, 'r')
  try {
    if (included > 0) await handle.read(buffer, 0, included, 0)
  } finally {
    await handle.close()
  }
  return {
    path: absolutePath,
    bytes: info.size,
    sha256: await hashFile(absolutePath, 'sha256'),
    truncated: info.size > included,
    content: buffer.toString('utf8'),
  }
}

/**
 * Assemble the report the model needs before a project task: actual working
 * directory, loader evidence, explicit handoffs, and the evidence runner path.
 * @param input - session scope and the user's explicit handoff list.
 * @param events - durable session events used to read loader state.
 * @returns a bounded, path-only report; instruction bodies are never repeated.
 */
export async function collectProjectContext(
  input: ProjectContextInput,
  events: readonly unknown[],
): Promise<ProjectContextReport> {
  if (input.sessionCwd === undefined || input.sessionCwd.trim() === '') {
    throw new Error('project_context cannot determine the session working directory')
  }
  const home = input.home ?? homedir()
  const sessionCwd = resolve(input.sessionCwd)
  const projectDir = input.projectDir === undefined
    ? sessionCwd
    : isAbsolute(input.projectDir.trim())
      ? resolve(input.projectDir)
      : resolve(sessionCwd, input.projectDir)
  let projectInfo: Awaited<ReturnType<typeof stat>>
  try {
    projectInfo = await stat(projectDir)
  } catch {
    throw new Error(`project_context project directory does not exist: ${projectDir}`)
  }
  if (!projectInfo.isDirectory()) {
    throw new Error(`project_context project path is not a directory: ${projectDir}`)
  }

  const project = findProjectRoot(projectDir)
  const candidates = await discoverInstructionCandidates(project.root, projectDir, home)
  const headerCwd = input.headerCwd === undefined || input.headerCwd.trim() === ''
    ? undefined
    : resolve(input.headerCwd)
  const observation = instructionObservationFrom(events, headerCwd)
  const cwdSource = input.cwdSource ?? 'unknown'
  const eventBaseline = baselineCwdFromEvents(events, headerCwd)
  const baselineCwd = eventBaseline
  const baselineRoot = baselineProjectRoot(observation, baselineCwd)
  const evidenceRoot = observation.latestLoaderProjectRoot ?? baselineRoot
  const projectScopeConfirmed = observation.observed
    && evidenceRoot !== undefined
    && samePath(evidenceRoot, project.root)
  const targetScopeCovered = observation.loaded.some((entry) => entry.cwd !== undefined && isUnder(projectDir, entry.cwd))
    || (baselineCwd === undefined ? false : isUnder(projectDir, baselineCwd))
  const warnings: string[] = []

  const baseInstructions: InstructionFileState[] = candidates.map((candidate) => {
    const loaded = loadedEntryFor(candidate, observation, baselineRoot, home)
    const loadedWithDigest = loaded !== undefined && loaded.digest !== undefined
    const truncated = noticeMentions(observation.budgetNotice, candidate.displayPath, 'truncated')
    const omitted = noticeMentions(observation.budgetNotice, candidate.displayPath, 'omitted')
    const stale = loadedWithDigest && candidate.loaderSha1 !== undefined && loaded.digest !== candidate.loaderSha1 && !truncated
    const scopeRoot = loaded?.projectRoot ?? baselineRoot
    const scopeCwd = loaded?.cwd ?? baselineCwd ?? sessionCwd
    return {
      ...candidate,
      loaded: loadedWithDigest,
      digest: loadedWithDigest ? loaded.digest : undefined,
      truncated,
      omitted,
      stale,
      deduplicated: false,
      duplicateOf: undefined,
      withinSessionScope: withinSessionScope(candidate, scopeRoot, scopeCwd),
    }
  })

  // Duplicate suppression is content-based within one candidate group. A file
  // with the same trimmed content as an already-retained file is represented by
  // that file, not missing. Only a non-truncated, non-stale record proves the
  // content identity used by the official loader.
  const coveredByGroup = new Map<string, Map<string, string>>()
  for (const instruction of baseInstructions) {
    if (!instruction.loaded || instruction.truncated || instruction.stale || instruction.trimmedSha1 === undefined) continue
    const group = candidateGroup(instruction)
    const covered = coveredByGroup.get(group) ?? new Map<string, string>()
    if (!covered.has(instruction.trimmedSha1)) covered.set(instruction.trimmedSha1, instruction.displayPath)
    coveredByGroup.set(group, covered)
  }
  const instructions: InstructionFileState[] = baseInstructions.map((instruction) => {
    if (instruction.loaded || instruction.trimmedSha1 === undefined) return instruction
    const covered = coveredByGroup.get(candidateGroup(instruction))?.get(instruction.trimmedSha1)
    return covered === undefined
      ? instruction
      : { ...instruction, deduplicated: true, duplicateOf: covered }
  })

  for (const loaded of observation.loaded) {
    const entryRoot = loaded.projectRoot ?? baselineRoot
    if (entryRoot === undefined) continue
    const entryCwd = loaded.cwd ?? entryRoot
    const absolutePath = pathFromDisplay(loaded.path, entryRoot, home)
    if (candidates.some(candidate => samePath(candidate.absolutePath, absolutePath))) continue
    const userGlobal = loaded.path.startsWith('~/')
    if (!userGlobal && !isUnder(project.root, absolutePath)) continue
    instructions.push({
      absolutePath,
      displayPath: loaded.path,
      scope: loaded.scope,
      bytes: 0,
      sha1: undefined,
      loaderSha1: undefined,
      trimmedSha1: undefined,
      exists: false,
      sourceTooLarge: false,
      loaded: loaded.digest !== undefined,
      digest: loaded.digest,
      truncated: noticeMentions(observation.budgetNotice, loaded.path, 'truncated'),
      omitted: false,
      stale: false,
      deduplicated: false,
      duplicateOf: undefined,
      withinSessionScope: userGlobal || withinSessionScope({
        absolutePath,
        displayPath: loaded.path,
        scope: loaded.scope,
        bytes: 0,
        sha1: undefined,
        loaderSha1: undefined,
        trimmedSha1: undefined,
        exists: false,
        sourceTooLarge: false,
      }, entryCwd, entryCwd),
    })
  }

  for (const instruction of instructions) {
    if (!instruction.exists) continue
    if (instruction.sourceTooLarge) warnings.push(`Instruction source exceeds 1 MiB and the loader omits it: ${instruction.absolutePath}`)
    if (instruction.truncated) warnings.push(`The loader truncated instruction content: ${instruction.displayPath}`)
    if (instruction.omitted) warnings.push(`The loader omitted instruction content for budget: ${instruction.displayPath}`)
    if (instruction.stale) warnings.push(`Instruction file changed after the loader read it; the next request should refresh it: ${instruction.displayPath}`)
    if (instruction.deduplicated && instruction.duplicateOf !== undefined) {
      warnings.push(`Instruction file duplicates ${instruction.duplicateOf} within its candidate group: ${instruction.displayPath}`)
    } else if (!instruction.loaded && observation.observed && projectScopeConfirmed) {
      if (!instruction.withinSessionScope) {
        warnings.push(`Instruction file is below the session cwd and was not in this session's loaded chain: ${instruction.displayPath}`)
      } else {
        warnings.push(`Instruction file exists but is not in the loader's retained chain: ${instruction.displayPath}`)
      }
    }
  }

  if (!project.marker) warnings.push(`No .git marker above ${projectDir}; the project root is the task directory itself.`)
  if (!observation.observed) warnings.push('The official instruction loader has not left a durable message yet; content may be claimed on the next request.')
  if (!observation.observed) warnings.push('If this request already contains a <system-reminder> with workspace instructions, those are the rules for this turn; this report is not evidence that they are absent.')
  if (cwdSource === 'unknown') warnings.push('The workingDirectory service is unavailable; the current directory and loader project scope are unconfirmed.')
  if (baselineCwd === undefined && observation.observed) {
    warnings.push('No working-directory provenance is available for the loader baseline; a relative baseline identity cannot prove an absolute project.')
  }
  if (headerCwd !== undefined && baselineCwd !== undefined && !samePath(headerCwd, sessionCwd)) {
    warnings.push(`Current working directory ${sessionCwd} differs from the Session header cwd ${headerCwd}; the loader scope is evaluated at ${observation.latestLoaderCwd ?? baselineCwd}.`)
  }
  if (observation.observed && !observation.baselineIdentityValid) {
    warnings.push('Loader evidence has no usable baseline identity; target-project loading is unconfirmed.')
  } else if (!projectScopeConfirmed && evidenceRoot !== undefined
    && !samePath(evidenceRoot, project.root)) {
    warnings.push(`Loader evidence belongs to ${evidenceRoot}, not target project ${project.root}; target rules are unconfirmed.`)
  } else if (baselineRoot !== undefined && samePath(baselineRoot, project.root) && !targetScopeCovered
    && instructions.some(instruction => instruction.exists && !instruction.withinSessionScope)) {
    warnings.push(`Target directory is below the loader's baseline cwd; its nested rules were not in this session's loaded chain: ${projectDir}`)
  }
  if (observation.observed && observation.loaded.length === 0 && projectScopeConfirmed) {
    warnings.push('The official loader found no applicable instruction files.')
  }

  const requested = input.handoff ?? []
  if (requested.length > MAX_HANDOFF_FILES) {
    throw new Error(`project_context accepts at most ${String(MAX_HANDOFF_FILES)} handoff files`)
  }
  const handoff: HandoffDocument[] = []
  let remaining = MAX_HANDOFF_BYTES_TOTAL
  for (const path of requested) {
    if (path.trim() === '') throw new Error('project_context handoff path must not be empty')
    const budget = Math.min(MAX_HANDOFF_BYTES_PER_FILE, remaining)
    if (budget <= 0) {
      warnings.push('Handoff byte budget exhausted; later documents were not read.')
      break
    }
    const document = await boundedHandoff(path, projectDir, budget)
    handoff.push(document)
    remaining -= Math.min(document.bytes, budget)
    if (document.truncated) warnings.push(`Handoff truncated at ${String(budget)} bytes: ${document.path}`)
  }

  const applicable = instructions.filter(instruction => (
    instruction.exists
    && !instruction.deduplicated
    && (isUserGlobalCandidate(instruction) || isUnder(project.root, instruction.absolutePath))
  ))
  const loadedApplicable = applicable.filter(instruction => instruction.loaded)
  const incomplete = applicable.some(instruction => (
    !instruction.loaded || instruction.omitted || instruction.truncated || instruction.stale
  ))
  const instructionState = !observation.observed
    ? 'pending'
    : !projectScopeConfirmed
      ? 'unconfirmed'
      : applicable.length === 0
        ? (instructions.some(instruction => instruction.loaded) ? 'loaded' : 'none')
        : loadedApplicable.length === 0
          ? 'pending'
          : incomplete ? 'partial' : 'loaded'

  return {
    session_cwd: sessionCwd,
    header_cwd: headerCwd,
    baseline_cwd: baselineCwd,
    cwd_source: cwdSource,
    project_dir: projectDir,
    project_root: project.root,
    root_marker: project.marker ?? 'none',
    instruction_state: instructionState,
    instruction_loader: observation.observed ? 'agent-instructions' : 'not-observed',
    project_scope_confirmed: projectScopeConfirmed,
    baseline_identity: observation.baselineIdentity,
    baseline_project_root: baselineRoot,
    latest_loader_cwd: observation.latestLoaderCwd,
    latest_loader_project_root: observation.latestLoaderProjectRoot,
    budget_notice: observation.budgetNotice,
    instructions: instructions.slice(0, MAX_INSTRUCTION_FILES),
    handoff,
    evidence_runner: input.evidenceRunner,
    warnings: [...new Set(warnings)].map(clipWarning),
  }
}

/**
 * Locate the shipped evidence runner in both the installed layout
 * (`<package>/runtime/...`) and the source checkout.
 * @param moduleUrl - `import.meta.url` of the caller.
 * @returns the absolute script path, or undefined when neither layout exists.
 */
export function resolveEvidenceRunner(moduleUrl: string): string | undefined {
  const override = process.env.DSH_ORB_EVIDENCE_RUNNER
  if (override !== undefined && override.trim() !== '' && existsSync(override)) return resolve(override)
  const candidates = [
    // Installed: <package>/dist/computer-use/code-agent.js -> <package>/runtime.
    new URL('../../runtime/run-with-evidence.ps1', moduleUrl),
    // Source: packages/computer-use/src/*.ts -> packages/bundle/runtime.
    new URL('../../bundle/runtime/run-with-evidence.ps1', moduleUrl),
  ]
  for (const candidate of candidates) {
    try {
      const path = fileURLToPath(candidate)
      if (existsSync(path)) return resolve(path)
    } catch {
      // Try the next layout.
    }
  }
  return undefined
}
