/**
 * Observation-ribbon helper.
 *
 * This is the only auxiliary process the plugin keeps: a frameless,
 * click-through Electron window that draws the coloured observation ribbon and
 * acknowledges overlay intervals. It has no chat, sessions, menu, avatar, or
 * clipboard code; the Host owns all product state.
 */

import { app, BrowserWindow, screen } from 'electron'
import { createConnection, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { collectChromeWindowIds } from './chrome-windows.ts'
import { createFrameDisplay, type FrameDisplay, type FrameWindow } from './frame-display.ts'
import {
  observationFrameCssScript,
  observationFramePlacement,
  type OverlayRect,
} from './overlay-geometry.ts'

const socketAddress = process.env.DSH_ORB_SOCKET ?? ''
const token = process.env.DSH_ORB_TOKEN ?? ''

/** Delay before acknowledging input begin, so Windows hit-testing commits click-through. */
const INPUT_APPLY_MS = 80
/** Reject a socket that never completes the authenticated handshake. */
const HANDSHAKE_TIMEOUT_MS = 3_000

process.title = 'dsh-orb-frame'

if (socketAddress === '' || token === '') {
  console.error('dsh-orb frame: socket environment is missing')
  process.exit(1)
}

let frame: BrowserWindow | undefined
let live: Socket | undefined
let quitting = false
let buffer = ''
let frameReady = false
let display: FrameDisplay | undefined

app.on('before-quit', () => {
  quitting = true
  live?.destroy()
})
app.on('window-all-closed', () => {
  app.quit()
})

void app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide()
  frame = openFrame()
  display = createFrameDisplay({
    window: frameWindow,
    ready: () => frameReady,
    toDip,
    workArea: workAreaOf,
    placement: observationFramePlacement,
    css: observationFrameCssScript,
    onError: (error) => {
      write({
        type: 'overlay-error',
        code: 'frame-render',
        message: error instanceof Error ? error.message : String(error),
      })
    },
  })
  frame.webContents.on('did-finish-load', () => {
    frameReady = true
    void publishChromeWindows()
  })
  const reflow = (): void => {
    void display?.reflow().catch(() => {
      // The display reports a current render failure through onError; a
      // superseded reflow is silent by design.
    })
  }
  screen.on('display-metrics-changed', reflow)
  screen.on('display-added', reflow)
  screen.on('display-removed', reflow)
  await frame.loadFile(fileURLToPath(new URL('../assets/observation-frame.html', import.meta.url)))
  connect()
})

function connect(): void {
  const colon = socketAddress.lastIndexOf(':')
  const host = socketAddress.slice(0, colon)
  const port = Number(socketAddress.slice(colon + 1))
  if (host === '' || !Number.isInteger(port) || port <= 0) {
    console.error('dsh-orb frame: invalid socket address')
    app.quit()
    return
  }
  const socket = createConnection({ host, port })
  live = socket
  socket.setEncoding('utf8')
  const handshake = setTimeout(() => {
    if (live === socket && buffer === '') socket.destroy()
  }, HANDSHAKE_TIMEOUT_MS)
  handshake.unref()
  socket.on('connect', () => {
    clearTimeout(handshake)
    socket.write(`${JSON.stringify({ type: 'hello', token, pid: process.pid })}\n`)
    void publishChromeWindows()
  })
  socket.on('data', (chunk: string) => {
    buffer += chunk
    if (buffer.length > 1_000_000) {
      socket.destroy()
      return
    }
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      if (part.trim() === '') continue
      let message: unknown
      try {
        message = JSON.parse(part)
      } catch {
        socket.destroy()
        return
      }
      handle(message)
    }
  })
  socket.on('error', () => {
    // The close handler owns the exit path.
  })
  socket.on('close', () => {
    if (live === socket) live = undefined
    if (!quitting) app.quit()
  })
}

/** Adapt the Electron window to the state machine without importing Electron into it. */
function frameWindow(): FrameWindow | undefined {
  const created = frame
  if (created === undefined) return undefined
  return {
    isDestroyed: () => created.isDestroyed(),
    setBounds: bounds => created.setBounds(bounds),
    executeJavaScript: code => created.webContents.executeJavaScript(code),
    showInactive: () => created.showInactive(),
    hide: () => created.hide(),
  }
}

function write(message: unknown): void {
  if (live === undefined || live.destroyed) return
  try {
    live.write(`${JSON.stringify(message)}\n`)
  } catch {
    live.destroy()
  }
}

function ack(id: unknown): void {
  if (typeof id === 'string') write({ type: 'overlay-ack', id })
}

function handle(message: unknown): void {
  if (typeof message !== 'object' || message === null) return
  const record = message as { type?: unknown; id?: unknown; active?: unknown; bounds?: unknown }
  if (record.type === 'overlay-capture') {
    // The frame is content-protected at rest, so a capture never sees it. The
    // interval still needs an ack so the host knows the capture may start.
    ack(record.id)
    return
  }
  if (record.type === 'overlay-input') {
    // The frame is click-through at all times. Hold the begin ack briefly so
    // posted HID events cannot land on the overlay before hit-testing settles.
    if (record.active === true) setTimeout(() => ack(record.id), INPUT_APPLY_MS)
    else ack(record.id)
    return
  }
  if (record.type === 'observation-frame') {
    const region = readRect(record.bounds)
    if (region === undefined) {
      display?.hide()
      ack(record.id)
      return
    }
    if (display === undefined) {
      ack(record.id)
      return
    }
    void display.show(region).then(() => ack(record.id), () => ack(record.id))
  }
}

function toDip(region: OverlayRect): OverlayRect {
  if (process.platform !== 'win32') return region
  const dip = screen.screenToDipRect(null, {
    x: Math.round(region.x),
    y: Math.round(region.y),
    width: Math.round(region.width),
    height: Math.round(region.height),
  })
  return { x: dip.x, y: dip.y, width: dip.width, height: dip.height }
}

function workAreaOf(point: { readonly x: number; readonly y: number }): OverlayRect {
  const area = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }).workArea
  return { x: area.x, y: area.y, width: area.width, height: area.height }
}

function readRect(value: unknown): OverlayRect | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
  if (typeof record.x !== 'number' || typeof record.y !== 'number'
    || typeof record.width !== 'number' || typeof record.height !== 'number') {
    return undefined
  }
  if (![record.x, record.y, record.width, record.height].every(Number.isFinite)) return undefined
  if (record.width < 1 || record.height < 1) return undefined
  return { x: record.x, y: record.y, width: record.width, height: record.height }
}

async function publishChromeWindows(): Promise<void> {
  if (frame === undefined || frame.isDestroyed() || !frameReady) return
  const ids = collectChromeWindowIds([frame], process.platform)
  if (ids.length > 0) write({ type: 'chrome-windows', ids })
}

function openFrame(): BrowserWindow {
  const created = new BrowserWindow({
    width: 32,
    height: 32,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    roundedCorners: false,
    ...process.platform === 'darwin' ? { type: 'panel' as const } : {},
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  created.setAlwaysOnTop(true, 'floating')
  if (process.platform === 'darwin') {
    created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  }
  // The ribbon must be visible to the user but never pollute a model capture.
  // Content protection covers Windows (WDA_EXCLUDEFROMCAPTURE) and macOS
  // (NSWindowSharingNone); capture-exclusion ids remain a second layer on
  // Windows. `DSH_ORB_FRAME_CAPTUREABLE=1` is a development-only switch used
  // to record the drawn ribbon; production always keeps protection on.
  if (process.env.DSH_ORB_FRAME_CAPTUREABLE !== '1') created.setContentProtection(true)
  created.setIgnoreMouseEvents(true, { forward: true })
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  created.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  return created
}
