import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_MODEL, ProfileStore, sameSelection } from '../src/preferences.ts'

const roots: string[] = []
after(() => {
  for (const path of roots) rmSync(path, { recursive: true, force: true })
})

function dir(name = 'profile'): string {
  const path = mkdtempSync(join(tmpdir(), `orb-preferences-${name}-`))
  roots.push(path)
  return path
}

const chosen = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }

describe('profile preferences', () => {
  it('follows the shipped model until the background choice is set', () => {
    const path = dir()
    const store = new ProfileStore(path)
    assert.deepEqual(store.backgroundModel(), DEFAULT_MODEL)
    assert.equal(store.applyModelFallback(chosen), true)
    assert.deepEqual(store.backgroundModel(), chosen)
    assert.equal(store.applyModelFallback(chosen), false)
    // A fallback is memory-only; it must not freeze the unpicked track on disk.
    assert.equal(existsSync(join(path, 'orb-agent-models.json')), false)
    store.setBackground({ provider: 'p', model: 'm', reasoningEffort: 'low' })
    assert.deepEqual(new ProfileStore(path).backgroundModel(), { provider: 'p', model: 'm', reasoningEffort: 'low' })
    assert.equal(sameSelection(chosen, { ...chosen }), true)
    assert.equal(sameSelection(chosen, { ...chosen, reasoningEffort: 'max' }), false)
  })

  it('defaults coordinates to millifraction on Windows and persists both choices', () => {
    const path = dir()
    const store = new ProfileStore(path)
    assert.equal(store.millifractionEnabled(), process.platform === 'win32')
    assert.equal(store.coordinateMode(), process.platform === 'win32' ? 'millifraction' : 'pixel')
    store.setMillifractionEnabled(false)
    assert.equal(store.coordinateMode(), 'pixel')
    assert.equal(new ProfileStore(path).millifractionEnabled(), false)
    assert.equal(new ProfileStore(path).observationFrameEnabled(), true)
    store.setObservationFrameEnabled(false)
    assert.equal(new ProfileStore(path).observationFrameEnabled(), false)
    assert.match(readFileSync(join(path, 'observation-frame.json'), 'utf8'), /"enabled": false/u)
  })

  it('ignores malformed stored choices and keeps safe defaults', () => {
    const path = dir()
    writeFileSync(join(path, 'orb-agent-models.json'), '{"background":{"provider":"","model":42}}')
    writeFileSync(join(path, 'millifraction-coordinates.json'), '{"enabled":"yes"}')
    writeFileSync(join(path, 'observation-frame.json'), 'not json')
    const store = new ProfileStore(path)
    assert.deepEqual(store.backgroundModel(), DEFAULT_MODEL)
    assert.equal(store.millifractionEnabled(), process.platform === 'win32')
    assert.equal(store.observationFrameEnabled(), true)
  })
})
