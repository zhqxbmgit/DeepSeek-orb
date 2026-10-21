import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_MODEL, ProfileStore } from '../src/preferences.ts'
import {
  catalogAdvertises,
  fallbackSelection,
  readProductDefault,
  refreshModelFallback,
} from '../src/model-defaults.ts'

const roots: string[] = []
after(() => {
  for (const path of roots) rmSync(path, { recursive: true, force: true })
})

/** A profile directory whose other preference files are irrelevant here. */
function profile(): string {
  const path = mkdtempSync(join(tmpdir(), 'orb-model-defaults-'))
  roots.push(path)
  return path
}

const official = { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] }
const account = { id: 'deepseek-account', name: 'DeepSeek Account', models: [{ id: 'deepseek-flash', name: 'Flash' }] }
const flash = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }

describe('model defaults', () => {
  it('advertises exactly the provider and model pair', () => {
    assert.equal(catalogAdvertises([official, account], flash), true)
    assert.equal(catalogAdvertises([official], flash), false)
    assert.equal(catalogAdvertises([account], { provider: 'deepseek-account', model: 'not-listed' }), false)
    assert.equal(catalogAdvertises([], DEFAULT_MODEL), false)
  })

  it('prefers the product default, then the shipped pair, then the first model', () => {
    // The account route is what the sign-in wrote and the catalog advertises it, so it
    // wins even though the shipped pair is advertised too.
    assert.deepEqual(fallbackSelection([official, account], flash), flash)
    // A product default the catalog dropped must not strand the background Agent on it.
    assert.deepEqual(
      fallbackSelection([official], { provider: 'deepseek-account', model: 'deepseek-flash' }),
      DEFAULT_MODEL,
    )
    // Nothing shipped is advertised: the first advertised model is the last resort.
    const other = {
      id: 'other',
      name: 'Other',
      models: [{ id: 'm', name: 'M', reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } }],
    }
    assert.deepEqual(fallbackSelection([other], undefined), { provider: 'other', model: 'm', reasoningEffort: 'low' })
    // No catalog at all: the shipped pair, so a caller always has something to route.
    assert.deepEqual(fallbackSelection([], undefined), DEFAULT_MODEL)
    assert.deepEqual(fallbackSelection([], { provider: 'gone', model: 'gone' }), DEFAULT_MODEL)
  })

  it('reads the product default defensively', () => {
    const catalog = { modelCatalog: () => ({}) }
    assert.deepEqual(readProductDefault({ sessionController: catalog, agentDefaultModel: { currentSelection: () => flash } }), flash)
    // A missing or partial selection is not usable: the shipped pair covers the read.
    assert.equal(readProductDefault({ sessionController: catalog }), undefined)
    assert.equal(readProductDefault({
      sessionController: catalog,
      agentDefaultModel: { currentSelection: () => ({ provider: '', model: 'm' }) },
    }), undefined)
    assert.equal(readProductDefault({
      sessionController: catalog,
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: '' }) },
    })?.reasoningEffort, undefined)
    // A config-editor write can leave the reference mid-update.
    assert.equal(readProductDefault({
      sessionController: catalog,
      agentDefaultModel: { currentSelection: () => { throw new Error('mid-update') } },
    }), undefined)
  })

  it('installs the fallback on the store and reports when it moved', async () => {
    const store = new ProfileStore(profile())
    const source = {
      sessionController: { modelCatalog: () => ({ groups: [official, account] }) },
      agentDefaultModel: { currentSelection: () => flash },
    }
    const refreshed = await refreshModelFallback(source, store)
    assert.deepEqual(refreshed.catalog.groups.map((group) => group.id), ['deepseek-official', 'deepseek-account'])
    assert.equal(refreshed.changed, true)
    assert.deepEqual(store.backgroundModel(), flash)
    // The same answer again is not a move.
    assert.equal((await refreshModelFallback(source, store)).changed, false)
  })

  it('leaves the store alone when the catalog read fails', async () => {
    const store = new ProfileStore(profile())
    const source = {
      sessionController: { modelCatalog: () => { throw new Error('catalog unavailable') } },
      agentDefaultModel: { currentSelection: () => flash },
    }
    // The caller decides: the runtime keeps the previous fallback and logs the failure.
    await assert.rejects(refreshModelFallback(source, store), /catalog unavailable/)
    assert.deepEqual(store.backgroundModel(), DEFAULT_MODEL)
  })
})
