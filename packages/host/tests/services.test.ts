import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ProfileStore } from '../src/preferences.ts'
import { installOrbServices } from '../src/services.ts'

const roots: string[] = []
after(() => {
  for (const path of roots) rmSync(path, { recursive: true, force: true })
})

describe('Computer Use services', () => {
  it('publishes the live background model and coordinate mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orb-services-'))
    roots.push(dir)
    const store = new ProfileStore(dir)
    const provided = new Map<string, unknown>()
    installOrbServices({ provide: (name, value) => provided.set(name, value) }, store)

    const model = provided.get('orbCodeAgentModel') as { currentSelection(): unknown }
    const coordinates = provided.get('orbCoordinateMode') as { currentMode(): string }
    assert.deepEqual(model.currentSelection(), store.backgroundModel())
    assert.equal(coordinates.currentMode(), store.coordinateMode())

    store.setBackground({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' })
    store.setMillifractionEnabled(!store.millifractionEnabled())
    assert.deepEqual(model.currentSelection(), store.backgroundModel())
    assert.equal(coordinates.currentMode(), store.coordinateMode())
  })
})
