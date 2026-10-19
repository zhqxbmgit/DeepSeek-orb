/**
 * Panel size presets and the persisted geometry record.
 *
 * The single-finger layout needs the same panel back after every restart, and a size the
 * user picked with big left-click buttons. Everything here is pure: the helper's main
 * process owns the file, this module owns the values and their validation.
 */

import type { Rect } from './geometry.ts'

export interface PanelSize {
  readonly width: number
  readonly height: number
}

/** Positions are DIP, like every window bound the helper sets. */
export interface BallOrigin {
  readonly x: number
  readonly y: number
}

export interface StoredGeometry {
  readonly ball: BallOrigin | null
  readonly panel: PanelSize | null
}

/**
 * Four sizes, all small enough for a 1366-wide laptop at 125% and large enough for a
 * 4K desktop. The buttons inside the panel keep their own pixel sizes, so a larger panel
 * buys reading room rather than stretching the controls.
 */
export const PANEL_SIZE_PRESETS: readonly PanelSize[] = [
  { width: 340, height: 480 },
  { width: 400, height: 560 },
  { width: 480, height: 660 },
  { width: 560, height: 760 },
]

/** The size a fresh profile starts at: big controls, still a quarter of a 1080p screen. */
export const DEFAULT_PANEL_PRESET = 1

/** Smallest panel the layout still fits: below this the tool rows and composer collide. */
export const MIN_PANEL_SIZE: PanelSize = { width: 300, height: 420 }

/** Keep the panel off the very display edge, where a taskbar or a rounded corner clips it. */
export const PANEL_WORK_MARGIN = 16

const MIN_SAVED_PANEL = 200
const MAX_SAVED_PANEL = 4000
const MAX_SAVED_COORDINATE = 1_000_000

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function integerIn(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? Math.round(value)
    : undefined
}

/**
 * Shrink a size until it fits the work area the ball currently sits on. A panel that
 * would cover the whole screen is worse than a cramped one, so the floor still wins
 * when a display is genuinely tiny.
 * @param size - the preferred size.
 * @param workArea - display work area in DIP.
 * @returns the size the window can actually use.
 */
export function fitPanelSize(size: PanelSize, workArea: Rect): PanelSize {
  const maxWidth = Math.max(MIN_PANEL_SIZE.width, workArea.width - 2 * PANEL_WORK_MARGIN)
  const maxHeight = Math.max(MIN_PANEL_SIZE.height, workArea.height - 2 * PANEL_WORK_MARGIN)
  return {
    width: clamp(Math.round(size.width), MIN_PANEL_SIZE.width, maxWidth),
    height: clamp(Math.round(size.height), MIN_PANEL_SIZE.height, maxHeight),
  }
}

function presetFits(size: PanelSize, workArea: Rect): boolean {
  return size.width <= workArea.width - 2 * PANEL_WORK_MARGIN
    && size.height <= workArea.height - 2 * PANEL_WORK_MARGIN
}

/**
 * The size a profile without a saved panel starts at: the standard preset when it fits,
 * otherwise the largest preset that does, otherwise the smallest preset fitted down.
 */
export function defaultPanelSize(workArea: Rect): PanelSize {
  const preferred = PANEL_SIZE_PRESETS[DEFAULT_PANEL_PRESET]
  if (preferred && presetFits(preferred, workArea)) return { ...preferred }
  for (let index = PANEL_SIZE_PRESETS.length - 1; index >= 0; index -= 1) {
    const candidate = PANEL_SIZE_PRESETS[index]
    if (candidate && presetFits(candidate, workArea)) return { ...candidate }
  }
  return fitPanelSize(PANEL_SIZE_PRESETS[0] ?? MIN_PANEL_SIZE, workArea)
}

/** Every preset after fitting, deduplicated: a small display collapses several into one. */
function usableSizes(workArea: Rect): PanelSize[] {
  const sizes: PanelSize[] = []
  for (const preset of PANEL_SIZE_PRESETS) {
    const fitted = fitPanelSize(preset, workArea)
    if (sizes.some((size) => size.width === fitted.width && size.height === fitted.height)) continue
    sizes.push(fitted)
  }
  return sizes
}

export interface PanelSizeStep {
  readonly size: PanelSize
  /** False when the panel is already at the end of the range in that direction. */
  readonly changed: boolean
}

/**
 * One press of the smaller/larger button. The comparison uses width so a display that
 * clamps every preset to the same height still steps through distinct sizes.
 * @param current - the size on screen now.
 * @param workArea - display work area in DIP.
 * @param direction - which button was pressed.
 * @returns the next size and whether it differs.
 */
export function stepPanelSize(current: PanelSize, workArea: Rect, direction: 'smaller' | 'larger'): PanelSizeStep {
  const sizes = usableSizes(workArea)
  const here = fitPanelSize(current, workArea)
  if (direction === 'larger') {
    const next = sizes.find((size) => size.width > here.width + 4)
    if (next) return { size: next, changed: true }
    return { size: here, changed: false }
  }
  const smaller = [...sizes].reverse().find((size) => size.width < here.width - 4)
  if (smaller) return { size: smaller, changed: true }
  return { size: here, changed: false }
}

/**
 * Read the geometry file. Anything malformed is dropped field by field, so a damaged
 * file costs the saved position, never the ball.
 * @param text - raw file contents.
 * @returns the fields that were usable.
 */
export function parseGeometryStore(text: string): StoredGeometry {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ball: null, panel: null }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ball: null, panel: null }
  const record = parsed as {
    version?: unknown
    ball?: { x?: unknown; y?: unknown }
    panel?: { width?: unknown; height?: unknown }
  }
  if (record.version !== undefined && record.version !== 1) return { ball: null, panel: null }
  const x = integerIn(record.ball?.x, -MAX_SAVED_COORDINATE, MAX_SAVED_COORDINATE)
  const y = integerIn(record.ball?.y, -MAX_SAVED_COORDINATE, MAX_SAVED_COORDINATE)
  const width = integerIn(record.panel?.width, MIN_SAVED_PANEL, MAX_SAVED_PANEL)
  const height = integerIn(record.panel?.height, MIN_SAVED_PANEL, MAX_SAVED_PANEL)
  return {
    ball: x === undefined || y === undefined ? null : { x, y },
    panel: width === undefined || height === undefined ? null : { width, height },
  }
}

/** The exact shape {@link parseGeometryStore} reads back. */
export function serializeGeometryStore(ball: BallOrigin, panel: PanelSize): string {
  return `${JSON.stringify({
    version: 1,
    ball: { x: Math.round(ball.x), y: Math.round(ball.y) },
    panel: { width: Math.round(panel.width), height: Math.round(panel.height) },
  }, null, 2)}\n`
}
