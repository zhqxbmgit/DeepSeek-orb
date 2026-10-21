// Pure scoring for the click-accuracy fixture.
//
// The scorer deliberately keeps the four questions separate:
//   1. did the real event land inside the target control?
//   2. for A, did the submitted tool argument match the specified value?
//   3. did the real event land where the submitted argument independently maps?
//   4. were the press / release / activation counts complete?
//
// New records use the event's own screen position (eventScreenX/Y). Old
// records contain only the cursor snapshot (screenX/Y); those are scored with
// locationSource:'snapshot' and are never given synthetic event coordinates.

export const SCORER_VERSION = 'click-accuracy-scorer-2'
export const PARAMETER_TOLERANCE = 0.0005 // normalized units; prompt values carry 3 decimals

export function round (n) { return Math.round(n) }
export function pointInRect (p, r) {
  return Boolean(p && r) && p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height
}
export function expectedLanding (window, position) {
  if (!window || !Array.isArray(position) || position.length !== 2) return undefined
  return {
    x: round(window.x + (position[0] / 1000) * window.width),
    y: round(window.y + (position[1] / 1000) * window.height),
  }
}
export function delta (a, b) {
  if (!a || !b) return undefined
  return { dx: a.x - b.x, dy: a.y - b.y, max: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) }
}

function firstEventLocation (down) {
  if (!down) return undefined
  if (Number.isFinite(down.eventScreenX) && Number.isFinite(down.eventScreenY)) {
    return { x: down.eventScreenX, y: down.eventScreenY, source: 'event' }
  }
  if (Number.isFinite(down.screenX) && Number.isFinite(down.screenY)) {
    return { x: down.screenX, y: down.screenY, source: 'snapshot' }
  }
  return undefined
}

function firstSnapshot (down) {
  if (!down || !Number.isFinite(down.screenX) || !Number.isFinite(down.screenY)) return undefined
  return { x: down.screenX, y: down.screenY }
}

/**
 * Score one click attempt from the real fixture events and the actual tool
 * argument. No tolerance is applied to the physical landing; the expected
 * value is an integer produced by Math.round, as documented by dsh-orb.
 */
export function scoreAttempt ({ click, attempt, targetRect, window, specified }) {
  const downs = attempt?.downs ?? []
  const ups = attempt?.ups ?? []
  const activations = attempt?.activations ?? []
  const down = downs[0]
  const location = firstEventLocation(down)
  const snapshot = firstSnapshot(down)
  const expected = click ? expectedLanding(window, click.args?.position) : undefined
  const targetHit = pointInRect(location, targetRect)
  const targetActivation = activations.some(a => a.isTarget === true)
  const activationCount = activations.length
  const parameterDelta = specified && click
    ? { x: click.args.position[0] - specified.x, y: click.args.position[1] - specified.y }
    : undefined
  const parametersMatchSpecified = specified
    ? Boolean(parameterDelta && Math.abs(parameterDelta.x) <= PARAMETER_TOLERANCE && Math.abs(parameterDelta.y) <= PARAMETER_TOLERANCE)
    : null
  const landingDelta = location && expected ? delta(location, expected) : undefined
  const landingMatchesExpected = Boolean(landingDelta && landingDelta.dx === 0 && landingDelta.dy === 0)
  const eventVsSnapshot = location && snapshot ? delta(location, snapshot) : undefined
  const duplicateDowns = downs.length > 1
  const missingUp = downs.length > 0 && ups.length === 0
  const duplicateActivations = activationCount > 1
  const pressReleaseComplete = downs.length === 1 && ups.length === 1 && activationCount === 1
  const targetHitAndActivated = Boolean(targetHit && targetActivation)
  const allChecksPassed = Boolean(
    targetHitAndActivated &&
    landingMatchesExpected &&
    pressReleaseComplete &&
    parametersMatchSpecified !== false &&
    !duplicateDowns && !missingUp && !duplicateActivations,
  )

  let primaryFailure = 'pass'
  if (!click) primaryFailure = 'no-click'
  else if (downs.length === 0) primaryFailure = 'no-event'
  else if (duplicateDowns) primaryFailure = 'duplicate-down'
  else if (missingUp) primaryFailure = 'missing-up'
  else if (duplicateActivations) primaryFailure = 'duplicate-activation'
  else if (!targetHitAndActivated) primaryFailure = targetHit ? 'control-no-response' : 'target-miss'
  else if (parametersMatchSpecified === false) primaryFailure = 'parameter-mismatch'
  else if (!landingMatchesExpected) primaryFailure = 'landing-offset'
  else if (!pressReleaseComplete) primaryFailure = 'incomplete-press-release'

  return {
    hit: targetHitAndActivated,
    checks: {
      targetHit,
      targetActivation,
      activationCount,
      parametersMatchSpecified,
      landingMatchesExpected,
      pressReleaseComplete,
      duplicateDowns,
      missingUp,
      duplicateActivations,
      allChecksPassed,
    },
    primaryFailure,
    locationSource: location?.source ?? 'none',
    eventLocation: location,
    cursorSnapshot: snapshot,
    eventVsSnapshot,
    expected,
    landingDelta,
    parameterDelta,
    specified,
    click: click?.args,
  }
}

export function attemptFromEvents (events, attemptNo) {
  const downs = events.filter(e => e.type === 'mouse' && e.msg === 'down' && e.button === 'left' && e.attempt === attemptNo)
  const ups = events.filter(e => e.type === 'mouse' && e.msg === 'up' && e.button === 'left' && e.attempt === attemptNo)
  const activations = events.filter(e => e.type === 'activation' && e.attemptCount === attemptNo)
  return { downs, ups, activations }
}

// --------------------------------------------------------------- aggregation
export function percentile (values, p) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}
export function median (values) { return percentile(values, 0.5) }

export function byGroup (records, key) {
  const map = new Map()
  for (const r of records) {
    const k = key(r)
    if (!map.has(k)) map.set(k, { total: 0, hit: 0, allChecks: 0, ids: [] })
    const v = map.get(k)
    v.total += 1
    if (r.hit) v.hit += 1
    if (r.firstAttempt?.checks?.allChecksPassed) v.allChecks += 1
    if (!r.hit) v.ids.push(r.trialId)
  }
  return [...map.entries()].map(([k, v]) => ({
    key: k,
    total: v.total,
    firstHit: v.hit,
    firstHitRate: v.total ? Number((v.hit / v.total).toFixed(3)) : 0,
    firstAllChecks: v.allChecks,
    firstAllChecksRate: v.total ? Number((v.allChecks / v.total).toFixed(3)) : 0,
    misses: v.ids,
  }))
}

export function durationStats (list) {
  const ms = list.map(r => r.elapsedMs).filter(Number.isFinite)
  if (ms.length === 0) return { measured: 0, totalMs: 0, medianMs: undefined, meanMs: undefined, maxMs: undefined }
  return {
    measured: ms.length,
    totalMs: ms.reduce((a, b) => a + b, 0),
    medianMs: median(ms),
    meanMs: Number((ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(1)),
    maxMs: Math.max(...ms),
  }
}

export function turnEndStats (records) {
  const map = new Map()
  for (const r of records) {
    const k = r.turnEnd?.kind ?? 'unknown'
    map.set(k, (map.get(k) ?? 0) + 1)
  }
  return Object.fromEntries(map)
}
