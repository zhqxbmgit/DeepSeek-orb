import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OverlayRuntime, type OverlayRuntimeDeps } from '../src/overlay-runtime.ts'
import { ProfileStore } from '../src/preferences.ts'

const roots: string[] = []
after(() => {
  for (const path of roots) rmSync(path, { recursive: true, force: true })
})

function dir(): string {
  const path = mkdtempSync(join(tmpdir(), 'orb-overlay-runtime-'))
  roots.push(path)
  return path
}

describe('observation-ribbon runtime state', () => {
  it('reports disabled when the preference is off and starts nothing', async () => {
    const path = dir()
    writeFileSync(join(path, 'observation-frame.json'), '{"enabled":false}\n')
    const store = new ProfileStore(path)
    const runtime = new OverlayRuntime(store, path, 'win32')
    await runtime.start()
    assert.deepEqual(runtime.status(), { state: 'disabled', error: '', phase: '' })
    assert.equal(runtime.hasHelper(), false)
    assert.deepEqual(runtime.chromeWindowIds(), [])
    runtime.stop()
    assert.deepEqual(runtime.status(), { state: 'disabled', error: '', phase: '' })
  })

  it('does not start on an unsupported platform', async () => {
    const path = dir()
    const store = new ProfileStore(path)
    const runtime = new OverlayRuntime(store, path, 'linux')
    assert.equal(runtime.supported(), false)
    await runtime.start()
    assert.equal(runtime.hasHelper(), false)
    assert.equal(runtime.status().state, 'stopped')
    runtime.stop()
  })

  it('has no helper to send to and never invents an acknowledgement', async () => {
    const runtime = new OverlayRuntime(new ProfileStore(dir()), dir(), 'win32')
    assert.equal(runtime.hasHelper(), false)
    await runtime.setObservationFrame({ x: 1, y: 2, width: 3, height: 4 })
    await assert.rejects(
      runtime.send({ id: 'probe', type: 'overlay-capture', active: true }),
      /not connected/u,
    )
    runtime.stop()
  })

  it('rejects an aborted wait without invoking the abort handler recursively', async () => {
    const runtime = new OverlayRuntime(new ProfileStore(dir()), dir(), 'win32')
    const fakeSocket = {
      destroyed: false,
      write() { return true },
      destroy() { this.destroyed = true },
    }
    Object.assign(runtime as unknown as { socket: unknown }, { socket: fakeSocket })
    const controller = new AbortController()
    const pending = runtime.send({ id: 'abort-probe', type: 'overlay-input', active: true }, controller.signal)
    controller.abort()
    await assert.rejects(pending, /aborted/u)
    runtime.stop()
  })
})

interface Gate<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function gate<T>(): Gate<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, deny) => {
    resolve = accept
    reject = deny
  })
  return { promise, resolve, reject }
}

interface FakeServer extends Server {
  closeCount: number
}

function fakeServer(): FakeServer {
  return {
    closeCount: 0,
    close(this: FakeServer) {
      this.closeCount += 1
    },
  } as unknown as FakeServer
}

interface FakeChild extends ChildProcess {
  killCalls: number
}

function fakeChild(): FakeChild {
  const stream = Object.assign(new EventEmitter(), { setEncoding() {} })
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout: stream,
    stderr: Object.assign(new EventEmitter(), { setEncoding() {} }),
    exitCode: null,
    signalCode: null,
    killCalls: 0,
    kill(this: FakeChild) {
      this.killCalls += 1
      return true
    },
  })
  return child as unknown as FakeChild
}

interface RuntimeHarness {
  readonly runtime: OverlayRuntime
  readonly spawns: string[]
  readonly servers: FakeServer[]
  readonly children: FakeChild[]
  calls: { resolve: number; listen: number }
}

function runtimeHarness(
  options: {
    resolve?: () => Promise<string>
    listen?: () => Promise<{ server: FakeServer; port: number }>
  } = {},
): RuntimeHarness {
  const path = dir()
  const store = new ProfileStore(path)
  const spawns: string[] = []
  const servers: FakeServer[] = []
  const children: FakeChild[] = []
  const calls = { resolve: 0, listen: 0 }
  let port = 40_000
  const deps: OverlayRuntimeDeps = {
    resolveBinary: async () => {
      calls.resolve += 1
      return options.resolve === undefined ? 'electron.exe' : options.resolve()
    },
    listen: async () => {
      calls.listen += 1
      if (options.listen !== undefined) return options.listen()
      const server = fakeServer()
      servers.push(server)
      port += 1
      return { server, port }
    },
    spawn: ((binary: string) => {
      spawns.push(binary)
      const child = fakeChild()
      children.push(child)
      return child
    }) as typeof spawn,
    mkdir: async () => undefined,
    helperMain: () => 'helper.js',
    homePath: (...parts: string[]) => join(path, ...parts),
  }
  return {
    runtime: new OverlayRuntime(store, path, 'win32', deps),
    spawns,
    servers,
    children,
    calls,
  }
}

describe('ribbon runtime startup lifecycle', () => {
  it('starts a fresh generation when the ribbon is closed and opened while download is pending', async () => {
    const first = gate<string>()
    let resolveCall = 0
    const harness = runtimeHarness({
      resolve: () => {
        resolveCall += 1
        return resolveCall === 1 ? first.promise : Promise.resolve('second-electron.exe')
      },
    })
    const oldStart = harness.runtime.start()
    assert.equal(harness.calls.resolve, 1)
    harness.runtime.stop()
    const newStart = harness.runtime.start()
    first.resolve('first-electron.exe')
    await Promise.all([oldStart, newStart])

    assert.equal(harness.calls.resolve, 2)
    assert.deepEqual(harness.spawns, ['second-electron.exe'])
    assert.equal(harness.children.length, 1)
    assert.equal(harness.runtime.status().state, 'starting')
    assert.equal(harness.runtime.hasHelper(), false)
    harness.runtime.stop()
    assert.equal(harness.children[0]?.killCalls, 1)
  })

  it('lets an explicit restart replace a pending start without a duplicate helper', async () => {
    const first = gate<string>()
    let resolveCall = 0
    const harness = runtimeHarness({
      resolve: () => {
        resolveCall += 1
        return resolveCall === 1 ? first.promise : Promise.resolve('restart-electron.exe')
      },
    })
    const oldStart = harness.runtime.start()
    const restarted = harness.runtime.restart()
    first.resolve('first-electron.exe')
    await Promise.all([oldStart, restarted])

    assert.equal(harness.calls.resolve, 2)
    assert.deepEqual(harness.spawns, ['restart-electron.exe'])
    assert.equal(harness.children.length, 1)
    assert.equal(harness.runtime.status().state, 'starting')
    harness.runtime.stop()
  })

  it('does not start a helper when the old download finishes after close without reopen', async () => {
    const first = gate<string>()
    const harness = runtimeHarness({ resolve: () => first.promise })
    const oldStart = harness.runtime.start()
    harness.runtime.stop()
    first.resolve('old-electron.exe')
    await oldStart

    assert.equal(harness.spawns.length, 0)
    assert.equal(harness.runtime.hasHelper(), false)
    assert.equal(harness.runtime.status().state, 'stopped')
  })

  it('ignores an old failure after the replacement generation is already running', async () => {
    const first = gate<string>()
    let resolveCall = 0
    const harness = runtimeHarness({
      resolve: () => {
        resolveCall += 1
        return resolveCall === 1 ? first.promise : Promise.resolve('current-electron.exe')
      },
    })
    const oldStart = harness.runtime.start()
    harness.runtime.stop()
    const newStart = harness.runtime.start()
    await newStart
    first.reject(new Error('old download failed'))
    await oldStart

    assert.deepEqual(harness.spawns, ['current-electron.exe'])
    assert.equal(harness.runtime.status().state, 'starting')
    harness.runtime.stop()
  })

  it('joins a spawned-but-not-yet-connected start instead of spawning a duplicate', async () => {
    const harness = runtimeHarness()
    await harness.runtime.start()
    assert.equal(harness.runtime.status().state, 'starting')
    await harness.runtime.start()
    await harness.runtime.start()

    assert.equal(harness.calls.resolve, 1)
    assert.equal(harness.calls.listen, 1)
    assert.deepEqual(harness.spawns, ['electron.exe'])
    assert.equal(harness.children.length, 1)
    harness.runtime.stop()
  })

  it('closes a provisional listener when a newer generation has replaced it', async () => {
    const oldListen = gate<{ server: FakeServer; port: number }>()
    let listenCall = 0
    const harness = runtimeHarness({
      listen: () => {
        listenCall += 1
        return listenCall === 1
          ? oldListen.promise
          : Promise.resolve({ server: fakeServer(), port: 41_000 })
      },
    })
    const oldStart = harness.runtime.start()
    // Let the old start reach its pending listener.
    await Promise.resolve()
    harness.runtime.stop()
    const newStart = harness.runtime.start()
    await newStart
    const oldServer = fakeServer()
    oldListen.resolve({ server: oldServer, port: 40_999 })
    await oldStart

    assert.equal(oldServer.closeCount, 1, 'the invalidated listener is closed')
    assert.equal(harness.runtime.status().state, 'starting')
    harness.runtime.stop()
  })

  it('survives repeated close/open cycles and keeps only the newest start', async () => {
    const gates = [gate<string>(), gate<string>(), gate<string>()]
    let resolveCall = 0
    const harness = runtimeHarness({
      resolve: () => {
        const index = resolveCall
        resolveCall += 1
        return index < 2 ? gates[index]!.promise : Promise.resolve('newest-electron.exe')
      },
    })
    const starts: Promise<void>[] = []
    starts.push(harness.runtime.start())
    harness.runtime.stop()
    starts.push(harness.runtime.start())
    harness.runtime.stop()
    starts.push(harness.runtime.start())
    gates[1]!.resolve('middle-electron.exe')
    gates[0]!.resolve('oldest-electron.exe')
    await Promise.all(starts)

    assert.deepEqual(harness.spawns, ['newest-electron.exe'])
    assert.equal(harness.children.length, 1)
    assert.equal(harness.runtime.status().state, 'starting')
    harness.runtime.stop()
    assert.equal(harness.children[0]?.killCalls, 1)
  })
})
