/**
 * The observation-ribbon process and its loopback control socket.
 *
 * This replaces the floating-ball runtime. There is one helper window, one
 * socket, and one job: show or hide the ribbon and acknowledge capture/input
 * intervals. It has no session, prompt, question, avatar, update, or history
 * path. A helper that exits is not relaunched in a loop; the settings page
 * surfaces the failure and offers one explicit restart.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { ProfileStore } from './preferences.ts'
import { helperMain } from './helper-path.ts'
import { resolveElectronBinary, type ElectronRuntimePhase } from './electron-runtime.ts'
import type { OverlayRect } from './overlay-guard.ts'

/** How long the helper gets to connect and authenticate after spawn. */
const CONNECT_TIMEOUT_MS = 15_000
/** How long the Host waits for one overlay acknowledgement. */
const ACK_TIMEOUT_MS = 2_000

/** Dependencies that tests can replace without touching the real Electron or network. */
export interface OverlayRuntimeDeps {
  readonly resolveBinary?: (report?: (phase: ElectronRuntimePhase) => void) => Promise<string>
  readonly listen?: (onSocket: (socket: Socket) => void) => Promise<{ server: Server; port: number }>
  readonly spawn?: typeof spawn
  readonly mkdir?: (path: string, options: { recursive: true }) => Promise<unknown>
  readonly helperMain?: () => string
  readonly homePath?: (...parts: string[]) => string
}

export type FrameState = 'disabled' | 'starting' | 'running' | 'error' | 'stopped'

/** What the settings page shows about the ribbon process. */
export interface FrameStatus {
  readonly state: FrameState
  /** Stable code such as `runtime-download` or `helper-exited`; empty when healthy. */
  readonly error: string
  /** `downloading` or `extracting` while the Electron runtime is prepared. */
  readonly phase: ElectronRuntimePhase | ''
}

interface Waiter {
  resolve(): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  /** Remove the AbortSignal listener; never invoke the abort handler itself. */
  cleanup?: () => void
}

function abortError(): Error {
  const error = new Error('dsh-orb: overlay acknowledgement aborted')
  error.name = 'AbortError'
  return error
}

function readWindowIds(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length > 16) return []
  const ids: number[] = []
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry <= 0) return []
    if (!ids.includes(entry)) ids.push(entry)
  }
  return ids
}

export class OverlayRuntime {
  private readonly token = randomBytes(32).toString('hex')
  private readonly waiters = new Map<string, Waiter>()
  private server: Server | undefined
  private socket: Socket | undefined
  private child: ChildProcess | undefined
  private socketBuffer = ''
  private port = 0
  private state: FrameState = 'stopped'
  private error = ''
  private phase: ElectronRuntimePhase | '' = ''
  private generation = 0
  /** A start belongs to exactly one generation; an old entry cannot clear a new one. */
  private starting: { generation: number; promise: Promise<void> } | undefined
  private stopping = false
  private connectTimer: ReturnType<typeof setTimeout> | undefined
  private chromeIds: readonly number[] = []
  private readonly resolveBinary: NonNullable<OverlayRuntimeDeps['resolveBinary']>
  private readonly listenFactory: NonNullable<OverlayRuntimeDeps['listen']>
  private readonly spawnProcess: typeof spawn
  private readonly makeDirectory: NonNullable<OverlayRuntimeDeps['mkdir']>
  private readonly frameMain: NonNullable<OverlayRuntimeDeps['helperMain']>
  private readonly homePath: NonNullable<OverlayRuntimeDeps['homePath']>

  constructor(
    private readonly store: ProfileStore,
    private readonly profileDir: string = store.dir,
    private readonly platform: NodeJS.Platform = process.platform,
    deps: OverlayRuntimeDeps = {},
  ) {
    this.resolveBinary = deps.resolveBinary ?? resolveElectronBinary
    this.listenFactory = deps.listen ?? (onSocket => this.openServer(onSocket))
    this.spawnProcess = deps.spawn ?? spawn
    this.makeDirectory = deps.mkdir ?? mkdir
    this.frameMain = deps.helperMain ?? helperMain
    this.homePath = deps.homePath ?? dshHomePath
  }

  /** The process and drawing capability this Host supports. */
  supported(): boolean {
    return this.platform === 'darwin' || this.platform === 'win32'
  }

  status(): FrameStatus {
    if (!this.store.observationFrameEnabled()) return { state: 'disabled', error: '', phase: '' }
    return { state: this.state, error: this.error, phase: this.phase }
  }

  hasHelper(): boolean {
    return this.socket !== undefined && !this.socket.destroyed
  }

  chromeWindowIds(): readonly number[] {
    return this.chromeIds
  }

  private setError(code: string): void {
    this.state = 'error'
    this.phase = ''
    this.error = code
    // A start promise may resolve after spawning but before the helper
    // connects. Keeping it would block a real retry; an error means the
    // next start must be a new generation.
    this.starting = undefined
  }

  /**
   * Resolve the runtime, open the loopback socket, and spawn the helper.
   * A failed start is visible through {@link status}; it never retries by
   * itself.
   */
  async start(): Promise<void> {
    if (!this.supported() || !this.store.observationFrameEnabled()) return
    if (this.starting !== undefined && this.starting.generation === this.generation) {
      return this.starting.promise
    }
    if (this.state === 'running' && this.hasHelper()) return
    // A previous helper may still hold a socket/server after an error. Clear
    // that generation before starting a replacement; otherwise a late failure
    // could tear down the new helper.
    if (this.state === 'error' || (this.state === 'running' && !this.hasHelper())) this.stop()

    const generation = ++this.generation
    this.stopping = false
    this.error = ''
    this.phase = ''
    this.state = 'starting'
    const promise = this.startInternal(generation)
    const entry = { generation, promise }
    this.starting = entry
    // A start task resolves as soon as the helper is spawned, but the helper
    // may still be connecting. Keep the entry while state is `starting` so a
    // repeated recovery request joins it instead of spawning a duplicate.
    // The identity check protects a replacement entry after stop/start.
    void promise.then(
      () => {
        if (this.starting === entry && this.state !== 'starting') this.starting = undefined
      },
      () => {
        if (this.starting === entry) this.starting = undefined
      },
    )
    return promise
  }

  private async startInternal(generation: number): Promise<void> {
    let binary: string
    try {
      binary = await this.resolveBinary((phase) => {
        if (generation !== this.generation || this.stopping) return
        this.phase = phase
        this.state = 'starting'
        console.error(`dsh-orb: ribbon runtime ${phase}`)
      })
    } catch (error) {
      if (generation !== this.generation || this.stopping) return
      console.error(`dsh-orb: ribbon runtime unavailable: ${error instanceof Error ? error.message : String(error)}`)
      this.setError('runtime-download')
      return
    }
    if (generation !== this.generation || this.stopping) return
    this.phase = ''

    let opened: { server: Server; port: number }
    try {
      opened = await this.listenFactory(socket => {
        if (generation !== this.generation || this.stopping) {
          socket.destroy()
          return
        }
        this.accept(socket)
      })
    } catch (error) {
      if (generation !== this.generation || this.stopping) return
      this.setError('helper-socket')
      console.error(`dsh-orb: ribbon socket failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (generation !== this.generation || this.stopping) {
      // The startup was invalidated while listening. Nobody else owns this
      // provisional server, so close it here instead of leaking a socket.
      try { opened.server.close() } catch { /* already closed */ }
      return
    }
    this.server = opened.server
    this.port = opened.port
    console.error(`dsh-orb: ribbon socket 127.0.0.1:${this.port}`)

    try {
      await this.makeDirectory(this.userData(), { recursive: true })
    } catch (error) {
      if (generation !== this.generation || this.stopping) return
      this.closeServer()
      this.setError('helper-directory')
      console.error(`dsh-orb: ribbon user data failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (generation !== this.generation || this.stopping) return
    this.launch(binary, generation)
  }

  /** Production listener; tests replace it through {@link OverlayRuntimeDeps.listen}. */
  private async openServer(onSocket: (socket: Socket) => void): Promise<{ server: Server; port: number }> {
    const server = createServer(onSocket)
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve())
      })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('ribbon socket has no port')
      return { server, port: address.port }
    } catch (error) {
      try { server.close() } catch { /* never started */ }
      throw error
    }
  }

  private userData(): string {
    const id = createHash('sha256').update(this.profileDir).digest('hex').slice(0, 16)
    return this.homePath('dsh-orb', 'frame-helper', id)
  }

  private launch(binary: string, generation: number): void {
    if (generation !== this.generation || this.stopping) return
    if (this.server === undefined || this.port === 0) return
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_ORB_TOKEN: this.token,
      DSH_ORB_SOCKET: `127.0.0.1:${this.port}`,
    }
    delete env.ELECTRON_RUN_AS_NODE
    let child: ChildProcess
    try {
      child = this.spawnProcess(binary, [`--user-data-dir=${this.userData()}`, this.frameMain()], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      console.error(`dsh-orb: ribbon helper failed to start: ${error instanceof Error ? error.message : String(error)}`)
      this.fail('helper-spawn')
      return
    }
    this.child = child
    console.error(`dsh-orb: ribbon helper started pid ${child.pid ?? 'unknown'}`)
    const token = this.token
    const log = (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (!line.trim() || line.includes(token) || /token=|api[_-]?key|authorization/i.test(line)) continue
        console.error(`dsh-orb helper: ${line}`)
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', log)
    child.stderr?.on('data', log)
    child.once('error', (error) => {
      if (generation !== this.generation || this.child !== child) return
      console.error(`dsh-orb: ribbon helper failed: ${error.message}`)
      this.fail('helper-spawn')
    })
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = undefined
      if (generation !== this.generation || this.stopping) return
      console.error(`dsh-orb: ribbon helper exited (${String(code ?? signal)})`)
      this.fail('helper-exited')
    })
    this.connectTimer = setTimeout(() => {
      if (this.hasHelper() || generation !== this.generation) return
      console.error('dsh-orb: ribbon helper did not connect')
      this.fail('helper-timeout')
    }, CONNECT_TIMEOUT_MS)
    this.connectTimer.unref()
  }

  private fail(code: string): void {
    this.clearConnectTimer()
    this.setError(code)
    this.destroySocket()
    this.closeServer()
    this.killChild()
    this.rejectWaiters()
  }

  private accept(socket: Socket): void {
    if (this.socket !== undefined && !this.socket.destroyed) {
      socket.destroy()
      return
    }
    socket.setEncoding('utf8')
    let authenticated = false
    const handshake = setTimeout(() => {
      if (!authenticated) socket.destroy()
    }, 3_000)
    handshake.unref()
    socket.on('data', (chunk: string) => {
      if (authenticated) {
        this.onData(chunk)
        return
      }
      this.socketBuffer += chunk
      const newline = this.socketBuffer.indexOf('\n')
      if (newline < 0) {
        if (this.socketBuffer.length > 64 * 1024) socket.destroy()
        return
      }
      const line = this.socketBuffer.slice(0, newline)
      this.socketBuffer = this.socketBuffer.slice(newline + 1)
      const hello = this.parse(line)
      if (hello === undefined || !this.helloOk(hello)) {
        socket.destroy()
        return
      }
      authenticated = true
      clearTimeout(handshake)
      this.socket = socket
      this.clearConnectTimer()
      this.starting = undefined
      this.state = 'running'
      this.error = ''
      this.phase = ''
      console.error('dsh-orb: ribbon helper connected')
      if (this.socketBuffer !== '') {
        const rest = this.socketBuffer
        this.socketBuffer = ''
        this.onData(rest)
      }
    })
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.chromeIds = []
      this.rejectWaiters()
      if (this.stopping || this.state === 'error') return
      this.fail('helper-disconnected')
    })
    socket.on('error', () => {
      socket.destroy()
    })
  }

  private onData(chunk: string): void {
    this.socketBuffer += chunk
    if (this.socketBuffer.length > 1_000_000) {
      this.destroySocket()
      return
    }
    const parts = this.socketBuffer.split('\n')
    this.socketBuffer = parts.pop() ?? ''
    for (const part of parts) {
      if (part.trim() === '') continue
      const message = this.parse(part)
      if (message === undefined) {
        this.destroySocket()
        return
      }
      this.onMessage(message)
    }
  }

  private parse(line: string): Record<string, unknown> | undefined {
    try {
      const value = JSON.parse(line) as unknown
      return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
    } catch {
      return undefined
    }
  }

  private helloOk(message: Record<string, unknown>): boolean {
    if (message.type !== 'hello' || typeof message.token !== 'string') return false
    const given = Buffer.from(message.token)
    const expected = Buffer.from(this.token)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  private onMessage(message: Record<string, unknown>): void {
    if (message.type === 'overlay-ack' && typeof message.id === 'string') {
      const waiter = this.waiters.get(message.id)
      if (waiter === undefined) return
      this.clearWaiter(message.id, waiter)
      waiter.resolve()
      return
    }
    if (message.type === 'chrome-windows') {
      this.chromeIds = readWindowIds(message.ids)
      return
    }
    if (message.type === 'overlay-error') {
      const code = typeof message.code === 'string' ? message.code : 'frame-render'
      console.error(`dsh-orb: ribbon renderer error: ${code} ${String(message.message ?? '')}`)
      this.setError(code)
    }
  }

  private clearWaiter(id: string, waiter: Waiter): void {
    clearTimeout(waiter.timer)
    waiter.cleanup?.()
    this.waiters.delete(id)
  }

  private rejectWaiters(): void {
    for (const [id, waiter] of [...this.waiters]) {
      this.clearWaiter(id, waiter)
      waiter.reject(new Error('dsh-orb: overlay helper is unavailable'))
    }
  }

  /**
   * Send one overlay message and wait for its acknowledgement.
   * @param message - message carrying a string id.
   * @param signal - optional cancellation for the wait.
   */
  send(message: { id: string; type: string; [key: string]: unknown }, signal?: AbortSignal): Promise<void> {
    const socket = this.socket
    if (socket === undefined || socket.destroyed) {
      return Promise.reject(new Error('dsh-orb: overlay helper is not connected'))
    }
    if (signal?.aborted) return Promise.reject(abortError())
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiter = this.waiters.get(message.id)
        if (waiter === undefined) return
        this.clearWaiter(message.id, waiter)
        waiter.reject(new Error('dsh-orb: overlay acknowledgement timed out'))
      }, ACK_TIMEOUT_MS)
      timer.unref()
      const onAbort = signal === undefined ? undefined : () => {
        const waiter = this.waiters.get(message.id)
        if (waiter === undefined) return
        this.clearWaiter(message.id, waiter)
        waiter.reject(abortError())
      }
      const cleanup = onAbort === undefined || signal === undefined
        ? undefined
        : () => signal.removeEventListener('abort', onAbort)
      const waiter: Waiter = { resolve, reject, timer, ...cleanup === undefined ? {} : { cleanup } }
      this.waiters.set(message.id, waiter)
      if (onAbort !== undefined) signal?.addEventListener('abort', onAbort, { once: true })
      try {
        socket.write(`${JSON.stringify(message)}\n`)
      } catch (error) {
        this.clearWaiter(message.id, waiter)
        waiter.reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Hide or show the ribbon. A missing helper is a no-op: the capture still belongs to the Agent. */
  async setObservationFrame(bounds: OverlayRect | null, signal?: AbortSignal): Promise<void> {
    if (!this.hasHelper()) return
    const wanted = bounds === null || !this.store.observationFrameEnabled() ? null : bounds
    await this.send({ id: randomUUID(), type: 'observation-frame', bounds: wanted }, signal)
  }

  /** Explicit recovery from the settings page. */
  async restart(): Promise<void> {
    this.stop()
    this.store.setObservationFrameEnabled(true)
    await this.start()
  }

  /** Stop the helper and release the socket. Safe to call repeatedly. */
  stop(): void {
    this.generation += 1
    this.stopping = true
    // The old task still owns its own finally, but no new start may reuse its
    // promise. Identity checks in that finally protect the replacement entry.
    this.starting = undefined
    this.state = 'stopped'
    this.error = ''
    this.phase = ''
    this.clearConnectTimer()
    this.rejectWaiters()
    this.destroySocket()
    this.closeServer()
    this.killChild()
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer)
    this.connectTimer = undefined
  }

  private destroySocket(): void {
    const socket = this.socket
    this.socket = undefined
    this.chromeIds = []
    this.socketBuffer = ''
    socket?.destroy()
  }

  private closeServer(): void {
    this.server?.close()
    this.server = undefined
    this.port = 0
  }

  private killChild(): void {
    const child = this.child
    this.child = undefined
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }
}
