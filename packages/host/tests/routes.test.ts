import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ProfileStore } from '../src/preferences.ts'
import type { FrameStatus, OverlayRuntime } from '../src/overlay-runtime.ts'
import { orbSupported, registerOrbRoutes } from '../src/routes.ts'
import type { TccMonitor } from '../src/tcc.ts'

const root = mkdtempSync(join(tmpdir(), 'orb-routes-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

function request(method: string, url: string, body?: string, headers: Record<string, string> = {}): IncomingMessage {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(body)
  const stream = Readable.from(payload.length === 0 ? [] : [payload])
  return Object.assign(stream, { method, url, headers }) as IncomingMessage
}

function response(): ServerResponse & { status: number; body: Buffer } {
  const res = {
    status: 0,
    body: Buffer.alloc(0),
    writableEnded: false,
    writeHead(status: number) { this.status = status },
    end(chunk?: Buffer | string) {
      if (chunk) this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      this.writableEnded = true
    },
    on() { return this },
    off() { return this },
  }
  return res as ServerResponse & { status: number; body: Buffer }
}

interface Harness {
  readonly store: ProfileStore
  readonly calls: string[]
  readonly frame: { status: FrameStatus }
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>
}

function harness(authenticated = true): Harness {
  const dir = mkdtempSync(join(root, 'profile-'))
  const store = new ProfileStore(dir)
  const calls: string[] = []
  const frame: { status: FrameStatus } = { status: { state: 'running', error: '', phase: '' } }
  const runtime = {
    status: () => store.observationFrameEnabled() ? frame.status : { state: 'disabled', error: '', phase: '' } as FrameStatus,
    start: async () => { calls.push('start') },
    restart: async () => { calls.push('restart') },
    stop: () => { calls.push('stop') },
    setObservationFrame: async () => { calls.push('hide') },
  } as unknown as OverlayRuntime
  let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
  const ctx = {
    webServer: {
      port: 9,
      register(route: { handler: typeof handler }) {
        handler = route.handler
        return () => {}
      },
    },
    connection: {
      admit: () => authenticated ? { peer: {} } : { rejection: 401 },
    },
    sessionController: {
      modelCatalog: () => ({
        groups: [{
          id: 'deepseek-account',
          name: 'DeepSeek Account',
          models: [{ id: 'deepseek-flash', name: 'Flash' }],
        }],
      }),
    },
  }
  const tcc = {
    status: () => ({ applicable: false, appName: '', screen: 'granted', accessibility: 'granted' }),
    open: async () => { calls.push('tcc') },
  } as unknown as TccMonitor
  registerOrbRoutes({ ctx, store, tcc, runtime })
  return {
    store,
    calls,
    frame,
    handler: (req, res) => {
      if (handler === undefined) throw new Error('route was not registered')
      return handler(req, res)
    },
  }
}

async function answer(h: Harness, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = response()
  await h.handler(request(method, path, body === undefined ? undefined : JSON.stringify(body)), res)
  const text = res.body.toString('utf8')
  return { status: res.status, json: text === '' ? {} : JSON.parse(text) as Record<string, unknown> }
}

describe('main-window settings routes', () => {
  it('serves only the snapshot this build owns', async () => {
    const h = harness()
    const { status, json } = await answer(h, 'GET', '/.dsh-orb/settings')
    assert.equal(status, 200)
    assert.equal(json.supported, true)
    assert.deepEqual(json.background, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' })
    assert.deepEqual(json.frame, { state: 'running', error: '', phase: '' })
    for (const retired of ['ballEnabled', 'avatarUrl', 'avatarPresets', 'overlay', 'selectionEnabled', 'update', 'history', 'workspace']) {
      assert.equal(retired in json, false, `${retired} must not be in the snapshot`)
    }
    const models = await answer(h, 'GET', '/.dsh-orb/models')
    assert.equal(models.status, 200)
    assert.equal((models.json.groups as unknown[]).length, 1)
  })

  it('rejects unauthenticated requests before reading a body', async () => {
    const h = harness(false)
    const { status } = await answer(h, 'GET', '/.dsh-orb/settings')
    assert.equal(status, 401)
  })

  it('saves the background model and coordinate choice', async () => {
    const h = harness()
    const model = await answer(h, 'POST', '/.dsh-orb/background-model', {
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      reasoningEffort: 'high',
    })
    assert.equal(model.status, 200)
    assert.deepEqual(h.store.backgroundModel(), {
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      reasoningEffort: 'high',
    })
    const coordinates = await answer(h, 'POST', '/.dsh-orb/millifraction', { enabled: false })
    assert.equal(coordinates.status, 200)
    assert.equal(h.store.millifractionEnabled(), false)
    assert.equal((await answer(h, 'POST', '/.dsh-orb/millifraction', { enabled: 'no' })).status, 400)
    assert.equal((await answer(h, 'POST', '/.dsh-orb/background-model', { provider: '', model: 'x' })).status, 400)
  })

  it('stops the ribbon process when switched off and restarts it on demand', async () => {
    const h = harness()
    const off = await answer(h, 'POST', '/.dsh-orb/observation-frame', { enabled: false })
    assert.equal(off.status, 200)
    assert.equal(h.store.observationFrameEnabled(), false)
    assert.deepEqual(h.calls, ['hide', 'stop'])
    assert.deepEqual(off.json.frame, { state: 'disabled', error: '', phase: '' })

    h.frame.status = { state: 'error', error: 'helper-exited', phase: '' }
    const restart = await answer(h, 'POST', '/.dsh-orb/frame/restart', {})
    assert.equal(restart.status, 200)
    assert.equal(h.store.observationFrameEnabled(), true)
    assert.deepEqual(h.calls, ['hide', 'stop', 'restart'])
  })

  it('returns 404 for the retired ball, avatar, update, history, and workspace routes', async () => {
    const h = harness()
    for (const [method, path] of [
      ['POST', '/.dsh-orb/ball'],
      ['GET', '/.dsh-orb/avatar'],
      ['POST', '/.dsh-orb/update/check'],
      ['GET', '/.dsh-orb/history'],
      ['POST', '/.dsh-orb/workspace'],
      ['GET', '/.dsh-orb/jump'],
      ['GET', '/.dsh-orb/settings-open'],
    ] as const) {
      const result = await answer(h, method, path)
      assert.equal(result.status, 404, `${method} ${path}`)
    }
  })

  it('reports platform support', () => {
    assert.equal(orbSupported('linux'), false)
    assert.equal(orbSupported('darwin'), true)
    assert.equal(orbSupported('win32'), true)
  })
})
