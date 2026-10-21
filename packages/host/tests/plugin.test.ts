import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../src/index.ts'

const root = mkdtempSync(join(tmpdir(), 'orb-plugin-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

function host(profile: string) {
  const routes: { kind: string; path: string }[] = []
  const provided: string[] = []
  const listeners: { name: string; prepend?: boolean }[] = []
  let dispose: (() => void) | undefined
  const ctx = {
    webServer: {
      port: 9,
      register(route: { kind: string; path: string }) {
        routes.push({ kind: route.kind, path: route.path })
        return () => {}
      },
    },
    connection: {
      authenticatedUrl: (base: string) => `${base}/?token=secret`,
      admit: () => ({ peer: {} }),
    },
    sessionController: {
      modelCatalog: () => ({ groups: [] }),
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    },
    effect(run: () => void | (() => void)) { dispose = run() ?? undefined },
    get(service: string) {
      if (service === 'profileContext') return { dir: profile }
      return undefined
    },
    provide(service: string) { provided.push(service) },
    on(event: string, _listener: unknown, options?: { prepend?: boolean }) {
      listeners.push({ name: event, prepend: options?.prepend })
      return () => {}
    },
  }
  return { ctx, routes, provided, listeners, stop: () => dispose?.() }
}

describe('orb-host plugin', () => {
  it('registers the main-window settings and overlay services without a ball lifecycle', async () => {
    const profile = join(root, 'off')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'observation-frame.json'), '{"enabled":false}\n')
    const started = host(profile)
    const errors: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
    try {
      apply(started.ctx as never)
    } finally {
      console.error = original
    }
    assert.equal(name, 'orb-host')
    assert.deepEqual(inject, ['webServer', 'connection', 'sessionController', 'agentDefaultModel'])
    assert.deepEqual(started.routes, [{ kind: 'prefix', path: '/.dsh-orb' }])
    assert.deepEqual(started.provided, [
      'computerUseOverlayGuard',
      'orbCodeAgentModel',
      'orbCoordinateMode',
    ])
    assert.equal(started.listeners.length, 0, 'no ball question/session listeners')
    assert.equal(errors.some((line) => line.includes('token=') || line.includes('secret')), false)
    assert.equal(errors.some((line) => line.includes('ribbon socket')), false)
    assert.equal(errors.some((line) => line.includes('floating')), false)
    started.stop()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(errors.some((line) => line.includes('ribbon socket')), false)
  })
})
