import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PANEL_PRESET,
  MIN_PANEL_SIZE,
  PANEL_SIZE_PRESETS,
  defaultPanelSize,
  fitPanelSize,
  parseGeometryStore,
  serializeGeometryStore,
  stepPanelSize,
} from '../src/panel-geometry.ts'

const FULL_HD = { x: 0, y: 0, width: 1920, height: 1040 }
/** A 1366-wide laptop at 125%: the work area in DIP is small and taskbar-short. */
const SCALED_LAPTOP = { x: 0, y: 0, width: 1093, height: 614 }

describe('panel size presets', () => {
  it('keeps the order small to large', () => {
    for (let index = 1; index < PANEL_SIZE_PRESETS.length; index += 1) {
      assert.ok((PANEL_SIZE_PRESETS[index]?.width ?? 0) > (PANEL_SIZE_PRESETS[index - 1]?.width ?? 0))
      assert.ok((PANEL_SIZE_PRESETS[index]?.height ?? 0) > (PANEL_SIZE_PRESETS[index - 1]?.height ?? 0))
    }
  })

  it('starts a fresh profile at the standard size when it fits', () => {
    assert.deepEqual(defaultPanelSize(FULL_HD), PANEL_SIZE_PRESETS[DEFAULT_PANEL_PRESET])
  })

  it('falls back to the largest preset that fits a small work area', () => {
    const small = { x: 0, y: 0, width: 1100, height: 560 }
    const size = defaultPanelSize(small)
    assert.ok(size.width <= small.width - 32)
    assert.ok(size.height <= small.height - 32)
    // 480×660 does not fit 560 tall; 400×560 is still too tall, so 340×480 does.
    assert.deepEqual(size, PANEL_SIZE_PRESETS[0])
  })

  it('fits an oversized saved size into the work area instead of covering it', () => {
    const size = fitPanelSize({ width: 1600, height: 1200 }, SCALED_LAPTOP)
    assert.equal(size.width, SCALED_LAPTOP.width - 32)
    assert.equal(size.height, SCALED_LAPTOP.height - 32)
  })

  it('never fits below the smallest layout the panel styles support', () => {
    const tiny = { x: 0, y: 0, width: 320, height: 400 }
    const size = fitPanelSize({ width: 900, height: 1200 }, tiny)
    assert.deepEqual(size, MIN_PANEL_SIZE)
  })

  it('steps larger and smaller through the presets', () => {
    const start = PANEL_SIZE_PRESETS[DEFAULT_PANEL_PRESET]
    assert.ok(start)
    const larger = stepPanelSize(start, FULL_HD, 'larger')
    assert.equal(larger.changed, true)
    assert.equal(larger.size.width, PANEL_SIZE_PRESETS[2]?.width)
    const smaller = stepPanelSize(larger.size, FULL_HD, 'smaller')
    assert.equal(smaller.changed, true)
    assert.equal(smaller.size.width, start.width)
  })

  it('reports both ends of the range instead of growing past the work area', () => {
    const largest = PANEL_SIZE_PRESETS[PANEL_SIZE_PRESETS.length - 1]
    assert.ok(largest)
    const beyond = stepPanelSize(largest, FULL_HD, 'larger')
    assert.equal(beyond.changed, false)
    assert.equal(beyond.size.width, largest.width)

    const smallest = PANEL_SIZE_PRESETS[0]
    assert.ok(smallest)
    const below = stepPanelSize(smallest, FULL_HD, 'smaller')
    assert.equal(below.changed, false)
    assert.equal(below.size.width, smallest.width)
  })

  it('still walks distinct sizes on a display that clamps every preset', () => {
    // 1093×614 fits 340×480 only; the larger presets clamp to 1061×582, which is a
    // distinct size, so the buttons must reach it rather than stopping at the first.
    const start = defaultPanelSize(SCALED_LAPTOP)
    const larger = stepPanelSize(start, SCALED_LAPTOP, 'larger')
    assert.equal(larger.changed, true)
    assert.ok(larger.size.width > start.width)
  })
})

describe('persisted geometry', () => {
  it('round-trips the ball origin and the panel size', () => {
    const text = serializeGeometryStore({ x: 1234, y: 567 }, { width: 480, height: 660 })
    assert.deepEqual(parseGeometryStore(text), {
      ball: { x: 1234, y: 567 },
      panel: { width: 480, height: 660 },
    })
  })

  it('drops a damaged file to the defaults instead of failing', () => {
    assert.deepEqual(parseGeometryStore('{not json'), { ball: null, panel: null })
    assert.deepEqual(parseGeometryStore('null'), { ball: null, panel: null })
    assert.deepEqual(parseGeometryStore('{"version":2,"ball":{"x":1,"y":2}}'), { ball: null, panel: null })
  })

  it('keeps the field that is still valid', () => {
    assert.deepEqual(parseGeometryStore('{"version":1,"ball":{"x":10,"y":20},"panel":{"width":"wide"}}'), {
      ball: { x: 10, y: 20 },
      panel: null,
    })
  })

  it('rejects nonsense numbers and coordinates', () => {
    assert.deepEqual(parseGeometryStore('{"ball":{"x":1e12,"y":0},"panel":{"width":0,"height":99999}}'), {
      ball: null,
      panel: null,
    })
  })
})
