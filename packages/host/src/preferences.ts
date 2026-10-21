/**
 * Profile files the main-window settings and the background Agent share.
 *
 * There is no floating-ball state here. The background model follows the main
 * window until the user picks one; the observation-ribbon preference and the
 * coordinate encoding are the only rendering/session choices this build owns.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const MODELS_FILE = 'orb-agent-models.json'
const MILLIFRACTION_FILE = 'millifraction-coordinates.json'
const OBSERVATION_FRAME_FILE = 'observation-frame.json'

export interface AgentModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Same provider, model, and effort. Used to skip writes that would change nothing. */
export function sameSelection(left: AgentModelSelection, right: AgentModelSelection): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

/**
 * The shipped DeepSeek pair. It is the fallback for a deployment whose catalog
 * or main-window default names nothing the background Agent can route.
 */
export const DEFAULT_MODEL: AgentModelSelection = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'max',
}

/** Explicit background choice only; absent follows the main-window default. */
interface StoredModels {
  readonly background?: AgentModelSelection
}

/** Active official profile directory. */
export function profileDirectory(ctx: { get(name: string): unknown }): string {
  const profile = ctx.get('profileContext')
  if (typeof profile === 'object' && profile !== null && 'dir' in profile) {
    const dir = (profile as { dir?: unknown }).dir
    if (typeof dir === 'string' && dir !== '') return dir
  }
  return process.cwd()
}

export function isAgentModelSelection(value: unknown): value is AgentModelSelection {
  return parseSelection(value) !== undefined
}

/** In-memory view of the profile files. Writes update the cache and the disk together. */
export class ProfileStore {
  private backgroundValue: AgentModelSelection | undefined
  /**
   * What an unpicked background track follows. Memory only: it is the main
   * window's default, refreshed by `model-defaults.ts`, and must not be
   * mistaken for a choice.
   */
  private modelFallbackValue: AgentModelSelection = DEFAULT_MODEL
  private millifractionValue: boolean
  private observationFrameValue: boolean

  constructor(readonly dir: string) {
    this.backgroundValue = readModels(dir).background
    this.millifractionValue = readMillifraction(dir)
    this.observationFrameValue = readObservationFrame(dir)
  }

  /** The background Agent's explicit choice, or the main-window fallback. */
  backgroundModel(): AgentModelSelection {
    return this.backgroundValue ?? this.modelFallbackValue
  }

  /**
   * Install what an unpicked background track follows.
   * @param selection - the resolved fallback; invalid values are ignored.
   * @returns whether it moved.
   */
  applyModelFallback(selection: AgentModelSelection): boolean {
    const next = parseSelection(selection)
    if (next === undefined || sameSelection(next, this.modelFallbackValue)) return false
    this.modelFallbackValue = next
    return true
  }

  setBackground(selection: AgentModelSelection): void {
    this.backgroundValue = selection
    this.writeModels()
  }

  millifractionEnabled(): boolean {
    return this.millifractionValue
  }

  setMillifractionEnabled(enabled: boolean): void {
    this.millifractionValue = enabled
    writeJson(join(this.dir, MILLIFRACTION_FILE), { enabled })
  }

  /** The coloured frame around the window Computer Use works on; on unless turned off. */
  observationFrameEnabled(): boolean {
    return this.observationFrameValue
  }

  setObservationFrameEnabled(enabled: boolean): void {
    this.observationFrameValue = enabled
    writeJson(join(this.dir, OBSERVATION_FRAME_FILE), { enabled })
  }

  /** Pixel on macOS, millifraction on Windows, unless the profile file says otherwise. */
  coordinateMode(): 'millifraction' | 'pixel' {
    return this.millifractionValue ? 'millifraction' : 'pixel'
  }

  /** Persist an explicit choice only; the fallback stays memory-only. */
  private writeModels(): void {
    writeJson(join(this.dir, MODELS_FILE), this.backgroundValue === undefined
      ? {}
      : { background: serializeSelection(this.backgroundValue) })
  }
}

export function defaultMillifraction(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

/** Explicit choices, keyed by track. A track with no entry is resolved on read. */
function readModels(dir: string): StoredModels {
  const value = record(readJson(join(dir, MODELS_FILE)))
  const background = parseSelection(value?.background)
  return background === undefined ? {} : { background }
}

function readMillifraction(dir: string): boolean {
  const enabled = record(readJson(join(dir, MILLIFRACTION_FILE)))?.enabled
  return typeof enabled === 'boolean' ? enabled : defaultMillifraction()
}

function readObservationFrame(dir: string): boolean {
  const enabled = record(readJson(join(dir, OBSERVATION_FRAME_FILE)))?.enabled
  return typeof enabled === 'boolean' ? enabled : true
}

function parseSelection(value: unknown): AgentModelSelection | undefined {
  const item = record(value)
  if (item === undefined) return undefined
  if (typeof item.provider !== 'string' || item.provider === '' || item.provider.length > 200) return undefined
  if (typeof item.model !== 'string' || item.model === '' || item.model.length > 200) return undefined
  if (item.reasoningEffort !== undefined && (typeof item.reasoningEffort !== 'string' || item.reasoningEffort === '' || item.reasoningEffort.length > 80)) {
    return undefined
  }
  return {
    provider: item.provider,
    model: item.model,
    ...typeof item.reasoningEffort === 'string' ? { reasoningEffort: item.reasoningEffort } : {},
  }
}

function serializeSelection(selection: AgentModelSelection): AgentModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function writeJson(file: string, value: unknown): void {
  const bytes = Buffer.from(`${JSON.stringify(value, undefined, 2)}\n`)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, bytes)
  renameSync(tmp, file)
}

/** The default frame-helper data root, used when no profile-specific folder is passed. */
export function defaultFrameDataDirectory(): string {
  return dshHomePath('dsh-orb', 'frame-helper')
}
