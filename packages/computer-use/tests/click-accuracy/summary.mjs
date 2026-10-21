import { median, percentile, durationStats, turnEndStats, byGroup } from './scoring.mjs'

function count (list, predicate) { return list.filter(predicate).length }
function rate (n, d) { return d ? Number((n / d).toFixed(3)) : 0 }
function latencyStats (list, field) {
  const values = list.map(r => r.turnEnd?.[field]).filter(Number.isFinite)
  if (values.length === 0) return { measured: 0, medianMs: undefined, maxMs: undefined }
  const sorted = [...values].sort((a, b) => a - b)
  return {
    measured: values.length,
    medianMs: sorted[Math.floor((sorted.length - 1) / 2)],
    maxMs: sorted[sorted.length - 1],
  }
}

function groupBlock (records, group, plannedCount) {
  const list = records.filter(r => r.group === group)
  const executed = list.filter(r => !r.environmentAbort)
  const aborts = list.filter(r => r.environmentAbort)
  const hits = executed.filter(r => r.hit === true)
  const allChecks = executed.filter(r => r.firstAttempt?.checks?.allChecksPassed === true)
  const failures = executed.filter(r => r.hit !== true || r.firstAttempt?.checks?.allChecksPassed !== true)
  const corrections = executed.filter(r => r.correctionAttempt)
  const recovered = corrections.filter(r => r.correctionAttempt.hit === true)
  const extra = executed.filter(r => (r.clickCalls?.length ?? 0) > 1)
  const locations = { event: 0, snapshot: 0, none: 0 }
  for (const r of executed) {
    const s = r.firstAttempt?.locationSource ?? 'none'
    locations[s] = (locations[s] ?? 0) + 1
  }
  return {
    group,
    planned: plannedCount ?? list.length,
    recorded: list.length,
    executed: executed.length,
    notExecuted: Math.max(0, (plannedCount ?? list.length) - list.length),
    aborts: aborts.length,
    abortIds: aborts.map(r => r.trialId),
    firstHit: hits.length,
    firstHitRate: rate(hits.length, executed.length),
    firstAllChecks: allChecks.length,
    firstAllChecksRate: rate(allChecks.length, executed.length),
    failed: failures.map(r => r.trialId),
    classifications: executed.reduce((m, r) => {
      const k = r.firstAttempt?.primaryFailure ?? 'unknown'
      m[k] = (m[k] ?? 0) + 1
      return m
    }, {}),
    checks: {
      specifiedMatches: count(executed, r => r.firstAttempt?.checks?.parametersMatchSpecified === true),
      landingMatches: count(executed, r => r.firstAttempt?.checks?.landingMatchesExpected === true),
      completePressRelease: count(executed, r => r.firstAttempt?.checks?.pressReleaseComplete === true),
      targetHits: hits.length,
      noEvent: count(executed, r => ['no-event', 'no-click'].includes(r.firstAttempt?.primaryFailure)),
      targetMiss: count(executed, r => r.firstAttempt?.primaryFailure === 'target-miss'),
      controlNoResponse: count(executed, r => r.firstAttempt?.primaryFailure === 'control-no-response'),
      parameterMismatch: count(executed, r => r.firstAttempt?.primaryFailure === 'parameter-mismatch'),
      landingOffset: count(executed, r => r.firstAttempt?.primaryFailure === 'landing-offset'),
      duplicateDowns: count(executed, r => r.firstAttempt?.checks?.duplicateDowns === true),
      missingUp: count(executed, r => r.firstAttempt?.checks?.missingUp === true),
      duplicateActivations: count(executed, r => r.firstAttempt?.checks?.duplicateActivations === true),
    },
    locationSources: locations,
    corrections: { attempted: corrections.length, recovered: recovered.length, recoveredIds: recovered.map(r => r.trialId) },
    extraClicks: { count: extra.length, ids: extra.map(r => r.trialId) },
    bySize: byGroup(executed, r => r.target?.sizeClass),
    byPosition: byGroup(executed, r => r.target?.position?.name ?? 'none'),
    byLayout: byGroup(executed, r => r.layoutVersion),
    duration: durationStats(executed),
    turnEnds: turnEndStats(executed),
    timing: {
      toolResultLatency: latencyStats(executed, 'toolResultLatencyMs'),
      postToolToEnd: latencyStats(executed, 'postToolToEndMs'),
      natural: executed.filter(r => r.turnEnd?.kind === 'natural-completed').length,
      cancelled: executed.filter(r => r.turnEnd?.cancelled === true).length,
    },
  }
}

function targetSizes (records) {
  const map = new Map()
  for (const r of records) {
    const key = r.target?.sizeClass
    if (!key) continue
    if (!map.has(key)) map.set(key, {
      sizeClass: key,
      physical: r.target.sizePhysical,
      dip: r.target.sizeDip,
      count: 0,
    })
    map.get(key).count += 1
  }
  return [...map.values()]
}

export function buildSummary ({ runId, records, meta, plan, startedAt, finishedAt, sessionIds, durations, stopInfo, sourceRunId, rescoredAt }) {
  const groups = [...new Set(records.map(r => r.group))]
  const plannedByGroup = {}
  if (plan?.trials) {
    for (const t of plan.trials) plannedByGroup[t.group] = (plannedByGroup[t.group] ?? 0) + 1
  }
  const groupSummaries = {}
  for (const g of groups) groupSummaries[g] = groupBlock(records, g, plannedByGroup[g])
  const planned = plan?.trials?.length ?? records.length
  const executed = records.filter(r => !r.environmentAbort).length
  const aborts = records.filter(r => r.environmentAbort)
  return {
    runId,
    sourceRunId: sourceRunId ?? runId,
    startedAt,
    finishedAt,
    rescoredAt,
    scorerVersion: 'click-accuracy-scorer-2',
    meta,
    planSeed: plan?.seed,
    planned,
    recorded: records.length,
    executed,
    aborts: { total: aborts.length, ids: aborts.map(r => r.trialId) },
    notExecuted: Math.max(0, planned - records.length),
    stopInfo,
    control: {
      stopRequested: stopInfo?.stopRequested === true,
      stopSource: stopInfo?.stopSource,
      stopReason: stopInfo?.stopReason,
      stopAt: stopInfo?.stopAt,
      turnCancelCount: stopInfo?.turnCancels?.length ?? 0,
      turnCancelReasons: (stopInfo?.turnCancels ?? []).reduce((m, x) => {
        m[x.reason] = (m[x.reason] ?? 0) + 1
        return m
      }, {}),
      foregroundLosses: stopInfo?.foregroundLosses ?? [],
      latePrepare: stopInfo?.latePrepare,
    },
    targetSizes: targetSizes(records),
    groups: groupSummaries,
    sessions: sessionIds,
    durations,
  }
}

export function summaryMarkdown (s) {
  const lines = []
  lines.push(`# dsh-orb click accuracy ${s.runId}`)
  lines.push('')
  lines.push(`- Started: ${s.startedAt ?? 'unknown'}`)
  lines.push(`- Finished: ${s.finishedAt ?? 'unknown'}`)
  lines.push(`- Scorer: ${s.scorerVersion}`)
  if (s.sourceRunId && s.sourceRunId !== s.runId) lines.push(`- Source run: ${s.sourceRunId}`)
  if (s.rescoredAt) lines.push(`- Rescored at: ${s.rescoredAt}`)
  lines.push(`- Environment: ${s.meta?.version}, ${s.meta?.model}, ${s.meta?.screen}, ${s.meta?.coordinateMode}`)
  lines.push(`- Planned: ${s.planned}; recorded: ${s.recorded}; executed: ${s.executed}; aborts: ${s.aborts.total}; not executed: ${s.notExecuted}`)
  if (s.control?.stopRequested) {
    lines.push(`- Stop: ${s.control.stopSource ?? 'unknown'} / ${s.control.stopReason ?? 'unknown'} at ${s.control.stopAt ?? 'unknown'}`)
  } else {
    lines.push('- Stop: not requested; normal group completion unless a turn cancel below says otherwise')
  }
  lines.push(`- Controller turn cancels: ${s.control?.turnCancelCount ?? 0} ${JSON.stringify(s.control?.turnCancelReasons ?? {})}; foreground losses: ${s.control?.foregroundLosses?.length ?? 0}; late prepare rejections: ${s.control?.latePrepare?.rejected === true ? 1 : 0}`)
  lines.push('')
  if (s.targetSizes?.length) {
    lines.push('| target class | physical px | DIP | count |')
    lines.push('|---|---:|---:|---:|')
    for (const t of s.targetSizes) {
      lines.push(`| ${t.sizeClass} | ${t.physical?.width}×${t.physical?.height} | ${t.dip?.width}×${t.dip?.height} | ${t.count} |`)
    }
    lines.push('')
  }
  for (const g of Object.values(s.groups)) {
    lines.push(`## ${g.group}`)
    lines.push('')
    lines.push(`- planned ${g.planned}; executed ${g.executed}; aborts ${g.aborts}; not executed ${g.notExecuted}`)
    lines.push(`- target hit ${g.firstHit}/${g.executed} (${(g.firstHitRate * 100).toFixed(1)}%); all four checks ${g.firstAllChecks}/${g.executed} (${(g.firstAllChecksRate * 100).toFixed(1)}%)`)
    lines.push(`- specified match ${g.checks.specifiedMatches}; landing match ${g.checks.landingMatches}; complete press/release ${g.checks.completePressRelease}; location sources ${JSON.stringify(g.locationSources)}`)
    lines.push(`- target miss ${g.checks.targetMiss}; control no-response ${g.checks.controlNoResponse}; parameter mismatch ${g.checks.parameterMismatch}; landing offset ${g.checks.landingOffset}; no event ${g.checks.noEvent}; duplicate down ${g.checks.duplicateDowns}; missing up ${g.checks.missingUp}; duplicate activation ${g.checks.duplicateActivations}`)
    lines.push(`- corrections: ${g.corrections.recovered}/${g.corrections.attempted} recovered; extra first-turn clicks ${g.extraClicks.count}; turn ends ${JSON.stringify(g.turnEnds)}`)
    lines.push(`- duration: total ${g.duration.totalMs}ms; median ${g.duration.medianMs}ms; max ${g.duration.maxMs}ms`)
    lines.push(`- timing: tool result latency median ${g.timing.toolResultLatency.medianMs}ms / max ${g.timing.toolResultLatency.maxMs}ms; tool result to turn end median ${g.timing.postToolToEnd.medianMs}ms / max ${g.timing.postToolToEnd.maxMs}ms; natural turns ${g.timing.natural}; cancelled turns ${g.timing.cancelled}`)
    if (g.failed.length) lines.push(`- failed: ${g.failed.join(', ')}`)
    lines.push('')
    if (g.bySize.length) {
      lines.push('| split | total | target hit | all checks |')
      lines.push('|---|---:|---:|---:|')
      for (const [name, rows] of [['size', g.bySize], ['position', g.byPosition], ['layout', g.byLayout]]) {
        for (const r of rows) lines.push(`| ${name}:${r.key} | ${r.total} | ${r.firstHit} (${(r.firstHitRate * 100).toFixed(1)}%) | ${r.firstAllChecks} (${(r.firstAllChecksRate * 100).toFixed(1)}%) |`)
      }
      lines.push('')
    }
  }
  lines.push('Per-trial evidence: `trials/<trialId>/result.json`, `before.png`, `after.png`; raw events in `fixture/`; sessions in `sessions/`.')
  return lines.join('\n') + '\n'
}
