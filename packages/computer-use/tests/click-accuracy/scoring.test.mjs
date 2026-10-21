import test from 'node:test'
import assert from 'node:assert/strict'
import { scoreAttempt, expectedLanding } from './scoring.mjs'

const window = { x: 500, y: 200, width: 1400, height: 900 }
const targetRect = { x: 1100, y: 600, width: 200, height: 100 }
const click = { args: { position: [500, 500], screen_index: 0 } }
const specified = { x: 500, y: 500 }

function attempt ({ eventX = 1200, eventY = 650, snapshotX = eventX, snapshotY = eventY, downs = 1, ups = 1, acts = 1, eventFields = true, target = true } = {}) {
  const down = { type: 'mouse', msg: 'down', button: 'left', attempt: 1, screenX: snapshotX, screenY: snapshotY }
  if (eventFields) { down.eventScreenX = eventX; down.eventScreenY = eventY }
  return {
    downs: Array.from({ length: downs }, () => ({ ...down })),
    ups: Array.from({ length: ups }, () => ({ type: 'mouse', msg: 'up', button: 'left', attempt: 1, screenX: snapshotX, screenY: snapshotY, ...(eventFields ? { eventScreenX: eventX, eventScreenY: eventY } : {}) })),
    activations: Array.from({ length: acts }, () => ({ type: 'activation', attemptCount: 1, isTarget: target })),
  }
}

test('exact event hit passes all four checks', () => {
  const r = scoreAttempt({ click, attempt: attempt(), targetRect, window, specified })
  assert.equal(r.checks.targetHit, true)
  assert.equal(r.checks.parametersMatchSpecified, true)
  assert.equal(r.checks.landingMatchesExpected, true)
  assert.equal(r.checks.pressReleaseComplete, true)
  assert.equal(r.checks.allChecksPassed, true)
  assert.equal(r.hit, true)
  assert.equal(r.locationSource, 'event')
})

test('a 3px offset stays inside a large target but fails landing and all-checks', () => {
  const r = scoreAttempt({ click, attempt: attempt({ eventX: 1203, eventY: 653 }), targetRect, window, specified })
  assert.equal(r.checks.targetHit, true)
  assert.equal(r.checks.landingMatchesExpected, false)
  assert.equal(r.checks.allChecksPassed, false)
  assert.equal(r.primaryFailure, 'landing-offset')
  assert.deepEqual(r.landingDelta, { dx: 3, dy: 3, max: 3 })
})

test('a miss is not called a control failure', () => {
  const r = scoreAttempt({ click, attempt: attempt({ eventX: 900, eventY: 400, acts: 0 }), targetRect, window, specified })
  assert.equal(r.checks.targetHit, false)
  assert.equal(r.checks.targetActivation, false)
  assert.equal(r.primaryFailure, 'target-miss')
})

test('missing release is separate from target hit', () => {
  const r = scoreAttempt({ click, attempt: attempt({ ups: 0 }), targetRect, window, specified })
  assert.equal(r.checks.targetHit, true)
  assert.equal(r.checks.missingUp, true)
  assert.equal(r.checks.pressReleaseComplete, false)
  assert.equal(r.primaryFailure, 'missing-up')
})

test('duplicate press is separate from target hit', () => {
  const r = scoreAttempt({ click, attempt: attempt({ downs: 2 }), targetRect, window, specified })
  assert.equal(r.checks.targetHit, true)
  assert.equal(r.checks.duplicateDowns, true)
  assert.equal(r.primaryFailure, 'duplicate-down')
})

test('duplicate activation is separate from target hit', () => {
  const r = scoreAttempt({ click, attempt: attempt({ acts: 2 }), targetRect, window, specified })
  assert.equal(r.checks.targetHit, true)
  assert.equal(r.checks.duplicateActivations, true)
  assert.equal(r.primaryFailure, 'duplicate-activation')
})

test('no event is distinct from a miss', () => {
  const r = scoreAttempt({ click, attempt: attempt({ downs: 0, ups: 0, acts: 0 }), targetRect, window, specified })
  assert.equal(r.checks.targetHit, false)
  assert.equal(r.primaryFailure, 'no-event')
})

test('parameter mismatch is separate from hit', () => {
  const r = scoreAttempt({ click, attempt: attempt(), targetRect, window, specified: { x: 510, y: 500 } })
  assert.equal(r.checks.targetHit, true)
  assert.equal(r.checks.parametersMatchSpecified, false)
  assert.equal(r.checks.allChecksPassed, false)
  assert.equal(r.primaryFailure, 'parameter-mismatch')
})

test('snapshot-only old records are labelled snapshot and are not given event coordinates', () => {
  const r = scoreAttempt({ click, attempt: attempt({ eventFields: false }), targetRect, window, specified })
  assert.equal(r.locationSource, 'snapshot')
  assert.equal(r.checks.landingMatchesExpected, true)
  assert.equal(r.checks.allChecksPassed, true)
})

test('event location wins over a different cursor snapshot', () => {
  const r = scoreAttempt({ click, attempt: attempt({ eventX: 1200, eventY: 650, snapshotX: 1250, snapshotY: 700 }), targetRect, window, specified })
  assert.equal(r.locationSource, 'event')
  assert.equal(r.checks.landingMatchesExpected, true)
  assert.deepEqual(r.eventVsSnapshot, { dx: -50, dy: -50, max: 50 })
})

test('independent expected landing uses the actual submitted value', () => {
  assert.deepEqual(expectedLanding({ x: 811, y: 377, width: 1401, height: 901 }, [123.456, 678.901]), {
    x: Math.round(811 + 123.456 / 1000 * 1401),
    y: Math.round(377 + 678.901 / 1000 * 901),
  })
})

test('no click is a no-click failure', () => {
  const r = scoreAttempt({ click: undefined, attempt: attempt(), targetRect, window, specified })
  assert.equal(r.primaryFailure, 'no-click')
  assert.equal(r.checks.allChecksPassed, false)
})
