import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  OBSERVATION_FRAME_OUTSET,
  observationFrameCssScript,
  observationFramePlacement,
} from '../src/overlay-geometry.ts'

const work = { x: 0, y: 0, width: 1000, height: 800 }

describe('observation frame geometry', () => {
  it('keeps the observation hole on the rectangle and clips a flush edge', () => {
    assert.equal(OBSERVATION_FRAME_OUTSET, 36)
    const placed = observationFramePlacement({ x: 100, y: 80, width: 200, height: 150 }, work)
    assert.deepEqual(placed.bounds, { x: 64, y: 44, width: 272, height: 222 })
    assert.deepEqual(placed.glow, { top: 28, right: 28, bottom: 28, left: 28 })
    assert.deepEqual(placed.stroke, { top: 8, right: 8, bottom: 8, left: 8 })
    const clipped = observationFramePlacement({ x: 0, y: 10, width: 40, height: 40 }, work)
    assert.equal(clipped.bounds.x, 0)
    assert.equal(clipped.glow.left, 0)
    assert.equal(clipped.stroke.left, 8)
  })

  it('writes the glow and stroke insets into the page', () => {
    const script = observationFrameCssScript(
      { top: 28, right: 0, bottom: 4, left: 8 },
      { top: 8, right: 8, bottom: 8, left: 8 },
    )
    assert.match(script, /--glow-top", "28px"/u)
    assert.match(script, /--glow-left", "8px"/u)
    assert.match(script, /--stroke-bottom", "8px"/u)
  })
})
