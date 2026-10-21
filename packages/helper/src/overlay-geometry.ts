/** Observation-ribbon placement. No Electron import, so tests run the same math. */

export const OBSERVATION_FRAME_STROKE_PX = 8
export const OBSERVATION_FRAME_GLOW_PX = 28
export const OBSERVATION_FRAME_OUTSET = OBSERVATION_FRAME_STROKE_PX + OBSERVATION_FRAME_GLOW_PX

export interface OverlayRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface EdgePadding {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

export interface ObservationFramePlacement {
  readonly bounds: OverlayRect
  readonly glow: EdgePadding
  readonly stroke: EdgePadding
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function intersectRects(area: OverlayRect, clip: OverlayRect): OverlayRect {
  const x = Math.max(area.x, clip.x)
  const y = Math.max(area.y, clip.y)
  const right = Math.min(area.x + area.width, clip.x + clip.width)
  const bottom = Math.min(area.y + area.height, clip.y + clip.height)
  const width = right - x
  const height = bottom - y
  if (width >= 1 && height >= 1) return { x, y, width, height }
  return {
    x: clamp(area.x, clip.x, clip.x + clip.width - 1),
    y: clamp(area.y, clip.y, clip.y + clip.height - 1),
    width: 1,
    height: 1,
  }
}

function edgePadding(inset: number): { readonly glow: number; readonly stroke: number } {
  const leftover = Math.max(0, Math.round(inset))
  return {
    glow: Math.max(0, leftover - OBSERVATION_FRAME_STROKE_PX),
    stroke: OBSERVATION_FRAME_STROKE_PX,
  }
}

/** Body glow and frame stroke that keep the inner hole on the observation rectangle. */
export function observationFramePadding(
  region: OverlayRect,
  bounds: OverlayRect,
): { readonly glow: EdgePadding; readonly stroke: EdgePadding } {
  const left = edgePadding(region.x - bounds.x)
  const top = edgePadding(region.y - bounds.y)
  const right = edgePadding(bounds.x + bounds.width - (region.x + region.width))
  const bottom = edgePadding(bounds.y + bounds.height - (region.y + region.height))
  return {
    glow: { top: top.glow, right: right.glow, bottom: bottom.glow, left: left.glow },
    stroke: { top: top.stroke, right: right.stroke, bottom: bottom.stroke, left: left.stroke },
  }
}

/** Inflate the observation rectangle by the stroke and glow, then clip to the work area. */
export function observationFramePlacement(
  region: OverlayRect,
  workArea: OverlayRect,
): ObservationFramePlacement {
  const inflated = {
    x: Math.round(region.x - OBSERVATION_FRAME_OUTSET),
    y: Math.round(region.y - OBSERVATION_FRAME_OUTSET),
    width: Math.max(1, Math.round(region.width + OBSERVATION_FRAME_OUTSET * 2)),
    height: Math.max(1, Math.round(region.height + OBSERVATION_FRAME_OUTSET * 2)),
  }
  const bounds = intersectRects(inflated, workArea)
  const padding = observationFramePadding(region, bounds)
  return { bounds, glow: padding.glow, stroke: padding.stroke }
}

export function observationFrameCssScript(
  glow: EdgePadding,
  stroke: EdgePadding,
): string {
  const vars: ReadonlyArray<readonly [string, number]> = [
    ['--glow-top', glow.top],
    ['--glow-right', glow.right],
    ['--glow-bottom', glow.bottom],
    ['--glow-left', glow.left],
    ['--stroke-top', stroke.top],
    ['--stroke-right', stroke.right],
    ['--stroke-bottom', stroke.bottom],
    ['--stroke-left', stroke.left],
  ]
  const assignments = vars.map(([name, value]) =>
    `root.setProperty(${JSON.stringify(name)}, ${JSON.stringify(`${String(value)}px`)});`,
  ).join('')
  return `(() => { const root = document.documentElement.style; ${assignments} })()`
}
