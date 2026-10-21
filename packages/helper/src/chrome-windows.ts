/**
 * Native window handles for the ribbon helper's own chrome.
 * Windows can report the frameless overlay as a foreground window even though it is
 * click-through. The host's observation walk reads `GetForegroundWindow`, so it must
 * know the frame handle to skip it. macOS needs no equivalent: the panel is
 * non-activating and never becomes foreground.
 */

/** The subset of `BrowserWindow` this module reads. */
export interface NativeHandleWindow {
  getNativeWindowHandle(): Buffer
}

/**
 * One native window id from an Electron handle buffer.
 * A Windows `HWND` is pointer sized. The host compares this value against the ids its own
 * `EnumWindows` walk produces, which are the same pointer values as JS numbers.
 * @param handle - buffer from `getNativeWindowHandle`.
 * @returns the id, or undefined when the buffer is too small or holds no usable id.
 */
export function windowIdFromHandle(handle: Buffer): number | undefined {
  const id = handle.length >= 8
    ? Number(handle.readBigUInt64LE(0))
    : handle.length >= 4 ? handle.readUInt32LE(0) : Number.NaN
  if (!Number.isSafeInteger(id) || id <= 0) return undefined
  return id
}

/**
 * Ids for the helper's chrome windows, for the host's capture exclusion list.
 * @param windows - observation-frame windows; any may be missing or destroyed.
 * @param platform - the helper's `process.platform`.
 * @returns unique ids, empty on every platform other than Windows.
 */
export function collectChromeWindowIds(
  windows: readonly (NativeHandleWindow | undefined)[],
  platform: string,
): number[] {
  if (platform !== 'win32') return []
  const ids: number[] = []
  for (const window of windows) {
    if (window === undefined) continue
    let id: number | undefined
    try {
      id = windowIdFromHandle(window.getNativeWindowHandle())
    } catch {
      // A window can be gone between the check and the call; it contributes no id.
      id = undefined
    }
    if (id !== undefined && !ids.includes(id)) ids.push(id)
  }
  return ids
}
