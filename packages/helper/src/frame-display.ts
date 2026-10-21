/**
 * One authority for the observation ribbon's visible state.
 *
 * A show request crosses an asynchronous render boundary. A hide, a newer
 * show, or a display reflow can arrive while that render is pending, so every
 * attempt carries an epoch. Only the newest attempt may touch bounds, the
 * visible flag, the last region, or the error path.
 */

import type { EdgePadding, OverlayRect } from './overlay-geometry.ts'

/** The window operations the display needs; Electron's BrowserWindow fits this. */
export interface FrameWindow {
  isDestroyed(): boolean
  setBounds(bounds: OverlayRect): void
  executeJavaScript(code: string): Promise<unknown>
  showInactive(): void
  hide(): void
}

/** Placement returned by the existing geometry module. */
export interface FramePlacement {
  readonly bounds: OverlayRect
  readonly glow: EdgePadding
  readonly stroke: EdgePadding
}

export interface FrameDisplayDeps {
  /** Current window, if Electron has created it. */
  window(): FrameWindow | undefined
  /** True after the frame page has finished loading. */
  ready(): boolean
  /** Convert a physical screen rectangle to the window's DIP space. */
  toDip(region: OverlayRect): OverlayRect
  /** Work area for the display containing a point. */
  workArea(point: { readonly x: number; readonly y: number }): OverlayRect
  /** Existing observation-frame placement math. */
  placement(region: OverlayRect, workArea: OverlayRect): FramePlacement
  /** Existing CSS-variable script. */
  css(glow: EdgePadding, stroke: EdgePadding): string
  /** Report only a failure that still owns the current attempt. */
  onError?(error: unknown): void
}

export interface FrameDisplay {
  /**
   * Request a new target. Resolves true only when this exact attempt became
   * visible; a superseded attempt or a current failure resolves false.
   */
  show(region: OverlayRect): Promise<boolean>
  /** Invalidate every pending attempt and hide immediately. */
  hide(): void
  /** Re-apply the latest target after a display metric/geometry change. */
  reflow(): Promise<void>
  /** Last region that actually became visible, if any. */
  shownRegion(): OverlayRect | undefined
  /** Latest requested target, or undefined while hidden. */
  desiredRegion(): OverlayRect | undefined
}

function sameRect(left: OverlayRect, right: OverlayRect): boolean {
  return left.x === right.x && left.y === right.y
    && left.width === right.width && left.height === right.height
}

export function createFrameDisplay(deps: FrameDisplayDeps): FrameDisplay {
  let epoch = 0
  let desired: OverlayRect | undefined
  let shown: OverlayRect | undefined

  function windowNow(): FrameWindow | undefined {
    const window = deps.window()
    if (window === undefined || window.isDestroyed()) return undefined
    return window
  }

  function hide(): void {
    // Bump before touching the window: every in-flight render becomes stale
    // even if the native hide throws or the window is destroyed.
    epoch += 1
    desired = undefined
    shown = undefined
    const window = windowNow()
    if (window === undefined) return
    try {
      window.hide()
    } catch {
      // A window can disappear between the check and hide; the state is
      // already hidden for every later attempt.
    }
  }

  async function show(region: OverlayRect): Promise<boolean> {
    const window = windowNow()
    if (window === undefined || !deps.ready()) return false

    const attempt = ++epoch
    desired = region

    try {
      // Geometry is part of the same attempt. A platform failure here must
      // take the same hide/error path as setBounds or the render promise;
      // otherwise the old ribbon stays visible with a new desired region.
      const dip = deps.toDip(region)
      const work = deps.workArea({ x: dip.x + dip.width / 2, y: dip.y + dip.height / 2 })
      const placement = deps.placement(dip, work)
      window.setBounds(placement.bounds)
      await window.executeJavaScript(deps.css(placement.glow, placement.stroke))
    } catch (error) {
      if (attempt !== epoch || desired === undefined) return false
      hide()
      deps.onError?.(error)
      return false
    }

    if (attempt !== epoch || desired === undefined || !sameRect(desired, region)) {
      return false
    }
    try {
      window.showInactive()
    } catch (error) {
      if (attempt !== epoch || desired === undefined) return false
      hide()
      deps.onError?.(error)
      return false
    }
    shown = region
    return true
  }

  async function reflow(): Promise<void> {
    const region = desired
    if (region === undefined) return
    await show(region)
  }

  return {
    show,
    hide,
    reflow,
    shownRegion: () => shown,
    desiredRegion: () => desired,
  }
}
