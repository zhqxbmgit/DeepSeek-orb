#!/usr/bin/env node
// Real-plugin click-accuracy baseline runner for dsh-orb 0.2.17.
//
// This script never clicks. It prepares the inert WinForms fixture, sends one
// task per turn through a real Computer Use session (the installed plugin's
// click tool), records the fixture's real mouse events, and scores them.
//
// Usage (from the repository root):
//   node packages/computer-use/tests/click-accuracy/runner.mjs \
//     --run-id orb-click-0217-YYYYMMDD-HHMM --groups A,B
//
// Options:
//   --groups A,B          run both groups (default)
//   --limit-a N           stop after N A trials (probe)
//   --limit-b N           stop after N B trials (probe)
//   --timeout-ms N        per-turn deadline (default 180000)
//   --no-fixture-start    reuse an already-running fixture in <run>/fixture
//   --score-only          re-score an existing run, no GUI/model calls
//
// Real tool calls are made by the Computer Use session, never by this script.

import { createHash, createHmac, randomUUID } from 'node:crypto'
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { zstdDecompressSync } from 'node:zlib'
import { buildPlan, buildPlan2 } from './plan.mjs'
import { scoreAttempt, attemptFromEvents, expectedLanding } from './scoring.mjs'
import { buildSummary, summaryMarkdown } from './summary.mjs'

const REPO = resolve(process.cwd())
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const WEB_URL = process.env.DSH_WEB_URL
if (!WEB_URL) throw new Error('DSH_WEB_URL is not set')
const AUTHORITY = new URL(WEB_URL).host
const FIXTURE_SCRIPT = join(REPO, 'packages', 'computer-use', 'tests', 'click-accuracy', 'fixture-window.ps1')
const DISPLAY_SCRIPT = join(REPO, 'packages', 'computer-use', 'tests', 'click-accuracy', 'display-info.ps1')
const EVIDENCE_ROOT = join(REPO, '.zcode', 'evidence', 'click-accuracy-0217')
const SCORER_PATH = join(REPO, 'packages', 'computer-use', 'tests', 'click-accuracy', 'scoring.mjs')
const SCORER_VERSION = 'click-accuracy-scorer-2'

function parseArgs (argv) {
  const out = {
    groups: ['A2', 'B2'],
    limitA: Infinity, limitB: Infinity, limitA2: Infinity, limitB2: Infinity,
    timeoutMs: 180000, noFixtureStart: false, scoreOnly: false,
    postClickGraceMs: 20000, analysisId: undefined,
    controlProbe: undefined, controlDelayMs: 700,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--run-id') out.runId = argv[++i]
    else if (a === '--groups') out.groups = argv[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    else if (a === '--limit-a') out.limitA = Number(argv[++i])
    else if (a === '--limit-b') out.limitB = Number(argv[++i])
    else if (a === '--limit-a2') out.limitA2 = Number(argv[++i])
    else if (a === '--limit-b2') out.limitB2 = Number(argv[++i])
    else if (a === '--timeout-ms') out.timeoutMs = Number(argv[++i])
    else if (a === '--post-click-grace-ms') out.postClickGraceMs = Number(argv[++i])
    else if (a === '--analysis-id') out.analysisId = argv[++i]
    else if (a === '--control-probe') out.controlProbe = argv[++i]
    else if (a === '--control-delay-ms') out.controlDelayMs = Number(argv[++i])
    else if (a === '--no-fixture-start') out.noFixtureStart = true
    else if (a === '--score-only') out.scoreOnly = true
    else if (a === '--help' || a === '-h') { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 30).join('\n')); process.exit(0) }
    else throw new Error(`unknown argument: ${a}`)
  }
  if (!out.runId) out.runId = `orb-click-0217-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`
  return out
}

const ARGS = parseArgs(process.argv.slice(2))
const RUN_ID = ARGS.runId
const RUN_DIR = join(REPO, '.zcode', 'clicktest', 'runs', RUN_ID)
const FIXTURE_DIR = join(RUN_DIR, 'fixture')
const EVIDENCE_DIR = join(EVIDENCE_ROOT, RUN_ID)
const STARTED_AT = new Date().toISOString()
const CONTROL_LOG = join(RUN_DIR, 'control.jsonl')
const RUN_STATE = {
  stopRequested: false,
  stopReason: undefined,
  stopSource: undefined,
  stopAt: undefined,
  aborted: false,
  events: [],
  turnCancels: [],
  foregroundLosses: [],
}
let logReady = false

function controlEvent (type, detail = {}) {
  const event = { time: new Date().toISOString(), type, ...detail }
  RUN_STATE.events.push(event)
  if (logReady) {
    try { appendFileSync(CONTROL_LOG, JSON.stringify(event) + '\n') } catch { }
  }
  return event
}

function requestStop (source, reason, detail = {}) {
  if (RUN_STATE.stopRequested) return
  RUN_STATE.stopRequested = true
  RUN_STATE.aborted = true
  RUN_STATE.stopSource = source
  RUN_STATE.stopReason = reason
  RUN_STATE.stopAt = new Date().toISOString()
  controlEvent('stop-requested', { source, reason, ...detail })
}

process.on('SIGINT', () => {
  if (!RUN_STATE.stopRequested) requestStop('controller', 'sigint')
  else process.exitCode = 130
})
process.on('SIGTERM', () => {
  if (!RUN_STATE.stopRequested) requestStop('controller', 'sigterm')
})


function log (...parts) {
  const line = `${new Date().toISOString()} ${parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ')}`
  console.log(line)
  try { appendFileSync(join(RUN_DIR, 'runner.log'), line + '\n') } catch { }
}

function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }
function readJson (p) { return JSON.parse(readFileSync(p, 'utf8')) }
function writeJson (p, v) { writeFileSync(p, JSON.stringify(v, null, 2)) }
function writeJsonAtomic (p, v) {
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(v))
  try { rmSync(p, { force: true }) } catch { }
  renameSync(tmp, p)
}

// ------------------------------------------------------------------ auth/rpc
function browserCookie () {
  const credPath = join(DSH_HOME, '.credentials.yaml')
  const text = readFileSync(credPath, 'utf8')
  const m = /client-connection\/browser-session:\s*\n\s+kind:\s*grant\s*\n\s+payload:\s*\n\s+version:\s*1\s*\n\s+secret:\s*([A-Za-z0-9_-]+)/u.exec(text)
  if (!m) throw new Error('browser-session secret not found in credentials')
  const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - m[1].length % 4) % 4), 'base64')
  const issuedAt = Date.now()
  const payload = { version: 1, authority: AUTHORITY, issuedAt, expiresAt: issuedAt + 30 * 86400 * 1000 }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  const name = 'dsh-auth-' + createHash('sha256').update(AUTHORITY).digest('base64url')
  return `${name}=v1.${body}.${sig}`
}

const COOKIE = browserCookie()

async function rpc (endpoint, args) {
  const response = await fetch(`http://${AUTHORITY}/api/${endpoint}`, {
    method: 'POST',
    headers: {
      cookie: COOKIE,
      'content-type': 'application/json',
      origin: `http://${AUTHORITY}`,
    },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
  })
  const json = await response.json()
  if (!json.result?.ok) {
    const err = json.result?.error ?? json
    throw new Error(`${endpoint}: ${err.code ?? 'error'} ${err.message ?? JSON.stringify(err)}`)
  }
  return json.result.value
}

async function createSession (cwd) {
  const value = await rpc('session/create', { request: { cwd, agentPreset: 'computer-use' } })
  return value.sessionId
}
async function prompt (sessionId, text) {
  return rpc('session/prompt', {
    request: {
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    },
  })
}
async function cancel (sessionId) {
  try { return await rpc('session/cancel', { request: { sessionId } }) } catch (e) { log('cancel error', e.message); return undefined }
}

// --------------------------------------------------------------- session log
function findSessionLog (sessionId) {
  const root = join(DSH_HOME, 'sessions')
  for (const dir of readdirSync(root)) {
    const p = join(root, dir, sessionId, 'session.v4.jsonl.zstd')
    if (existsSync(p)) return p
  }
  throw new Error(`session log not found for ${sessionId}`)
}

async function waitForSessionLog (sessionId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { return findSessionLog(sessionId) } catch { }
    await sleep(250)
  }
  throw new Error(`session log not found for ${sessionId}`)
}

function decodeZstdFrames (input) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  for (let i = 0; i + 4 <= input.length; i += 1) {
    if (input[i] === magic[0] && input[i + 1] === magic[1] && input[i + 2] === magic[2] && input[i + 3] === magic[3]) starts.push(i)
  }
  const chunks = []
  let cursor = 0
  while (cursor < starts.length) {
    let accepted = false
    for (let end = cursor + 1; end <= starts.length; end += 1) {
      const from = starts[cursor]
      const to = end < starts.length ? starts[end] : input.length
      try {
        const text = zstdDecompressSync(input.subarray(from, to)).toString('utf8')
        if (text.length === 0 && to < input.length) continue
        chunks.push(text)
        cursor = end
        accepted = true
        break
      } catch { }
    }
    if (!accepted) break
  }
  return chunks.join('')
}

class SessionReader {
  constructor (sessionId, file) {
    this.sessionId = sessionId
    this.file = file ?? findSessionLog(sessionId)
    this.size = -1
    this.events = []
  }

  refresh () {
    const st = statSync(this.file)
    if (st.size === this.size) return false
    this.size = st.size
    const text = decodeZstdFrames(readFileSync(this.file))
    this.events = text.split(/\r?\n/u).filter(Boolean).map(line => {
      try { return JSON.parse(line) } catch { return undefined }
    }).filter(Boolean)
    return true
  }

  maxSeq () {
    return this.events.reduce((m, e) => Math.max(m, Number.isInteger(e.seq) ? e.seq : -1), -1)
  }

  maxTurn () {
    return this.events.reduce((m, e) => e.type === 'turn/start' ? Math.max(m, e.data?.turn ?? 0) : m, 0)
  }

  find (predicate) { return this.events.find(predicate) }
  all (predicate) { return this.events.filter(predicate) }
}

function textOfMessage (event) {
  const content = event?.data?.content
  if (!Array.isArray(content)) return ''
  return content.filter(b => b?.type === 'text').map(b => b.text).join('\n')
}
function imageOfMessage (event) {
  const content = event?.data?.content
  if (!Array.isArray(content)) return undefined
  const block = content.find(b => b?.type === 'image')
  return block?.attachment
}

async function waitFor (reader, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    reader.refresh()
    const found = predicate(reader)
    if (found) return found
    await sleep(750)
  }
  log(`timeout waiting for ${label}`)
  return undefined
}

async function waitForTurn (reader, previousMaxTurn, timeoutMs) {
  const start = await waitFor(reader, r => r.events.find(e => e.type === 'turn/start' && (e.data?.turn ?? 0) > previousMaxTurn), timeoutMs, 'turn/start')
  if (!start) return undefined
  const turn = start.data.turn
  const end = await waitFor(reader, r => r.events.find(e => e.type === 'turn/end' && e.data?.turn === turn), timeoutMs, `turn/end ${turn}`)
  return { turn, start, end }
}

function turnEvents (reader, turn) {
  return reader.events.filter(e => e.data?.turn === turn && (e.type === 'tool/call' || e.type === 'tool/result' || e.type === 'user/message' || e.type === 'assistant/message'))
}

function clickCallsInTurn (reader, turn) {
  return reader.events.filter(e => e.type === 'tool/call' && e.data?.turn === turn && e.data?.name === 'click').map(e => {
    let args
    try { args = JSON.parse(e.data.arguments ?? '{}') } catch { args = {} }
    return { seq: e.seq, callId: e.data.callId, args }
  })
}

function clickResultsInTurn (reader, turn) {
  return reader.events.filter(e => e.type === 'tool/result' && e.data?.turn === turn && String(e.data?.message?.toolCallId ?? '').length > 0).map(e => {
    const msg = e.data.message
    return { seq: e.seq, callId: msg.toolCallId, content: msg.content ?? [] }
  })
}

function findClickResult (reader, turn, callId) {
  const r = clickResultsInTurn(reader, turn).find(x => x.callId === callId)
  if (!r) return undefined
  const text = r.content.filter(b => b?.type === 'text').map(b => b.text).join('\n')
  const image = r.content.find(b => b?.type === 'image')?.attachment
  return { ...r, text, image }
}

function forbiddenCallsInTurn (reader, turn) {
  return reader.events.filter(e => e.type === 'tool/call' && e.data?.turn === turn && !['click', 'screenshot'].includes(e.data?.name)).map(e => ({
    seq: e.seq, name: e.data.name, arguments: e.data.arguments,
  }))
}

function computerUseNoticeInTurn (reader, startSeq, endSeq) {
  return reader.events.find(e => e.type === 'user/message' && e.seq > startSeq && e.seq < endSeq
    && e.data?.source?.kind === 'computer-use' && e.data?.source?.form === 'notice')
}

function promptMessageInTurn (reader, startSeq, marker) {
  return reader.events.find(e => e.type === 'user/message' && e.seq > startSeq
    && e.data?.source?.kind === 'user' && textOfMessage(e).includes(marker))
}

// ------------------------------------------------------------------- fixture
const PROBE_AUX = []

async function waitForFile (path, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try { return readJson(path) } catch { }
    }
    await sleep(150)
  }
  return undefined
}

async function startDummyFixture () {
  const dir = join(RUN_DIR, 'dummy-fixture')
  mkdirSync(dir, { recursive: true })
  const args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', FIXTURE_SCRIPT, '-RunDir', dir, '-RunId', `${RUN_ID}-dummy`]
  const proc = spawn('powershell.exe', args, { cwd: REPO, stdio: 'ignore', windowsHide: true })
  const state = await waitForFile(join(dir, 'state.json'))
  if (!state) throw new Error('dummy fixture did not start')
  PROBE_AUX.push({ proc, dir, state, kind: 'dummy-fixture' })
  controlEvent('probe-dummy-started', { pid: state.pid, hwnd: state.hwnd, foregroundHwnd: state.foregroundHwnd })
  return state
}

function scheduleControlProbe (scenario, fixture, delayMs) {
  setTimeout(async () => {
    try {
      controlEvent('probe-fault-scheduled', { scenario, delayMs, at: new Date().toISOString() })
      if (scenario === 'stop' || scenario === 'stop-late-prepare') {
        const statePath = join(FIXTURE_DIR, 'state.json')
        const r = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', join(REPO, 'packages', 'computer-use', 'tests', 'click-accuracy', 'control-fault.ps1'), '-StatePath', statePath, '-Action', 'stop'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
        controlEvent('probe-stop-clicked', { exit: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() })
      } else if (scenario === 'foreground') {
        const dummy = await startDummyFixture()
        // The dummy activates once itself. If Windows keeps the old foreground,
        // force only this dedicated dummy window, never the main fixture.
        const statePath = join(RUN_DIR, 'dummy-fixture', 'state.json')
        const r = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', join(REPO, 'packages', 'computer-use', 'tests', 'click-accuracy', 'control-fault.ps1'), '-StatePath', statePath, '-Action', 'foreground'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
        controlEvent('probe-foreground-switched', { dummyPid: dummy.pid, dummyHwnd: dummy.hwnd, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() })
      } else if (scenario === 'close') {
        const state = readFixtureState()
        controlEvent('probe-kill-fixture-requested', { pid: state?.pid })
        if (state?.pid) process.kill(state.pid)
      } else {
        throw new Error(`unknown control probe: ${scenario}`)
      }
    } catch (e) {
      controlEvent('probe-fault-error', { scenario, error: e.message })
    }
  }, delayMs)
}

class Fixture {
  constructor () {    this.dir = FIXTURE_DIR
    this.seq = 0
    this.proc = undefined
    this.state = undefined
  }

  async start () {
    mkdirSync(this.dir, { recursive: true })
    rmSync(join(this.dir, 'command.json'), { force: true })
    const args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', FIXTURE_SCRIPT, '-RunDir', this.dir, '-RunId', RUN_ID]
    this.proc = spawn('powershell.exe', args, { cwd: REPO, stdio: 'ignore', windowsHide: true })
    const state = await this.waitState(15000, s => s && s.status === 'ready')
    if (!state) throw new Error('fixture did not become ready')
    log('fixture ready', { pid: state.pid, hwnd: state.hwnd, window: state.windowRect })
    return state
  }

  async waitState (timeoutMs, predicate) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        if (existsSync(join(this.dir, 'state.json'))) {
          const s = readJson(join(this.dir, 'state.json'))
          this.state = s
          if (!predicate || predicate(s)) return s
        }
      } catch { }
      await sleep(120)
    }
    return undefined
  }

  async send (command, trial) {
    this.seq += 1
    const body = { seq: this.seq, command }
    if (trial !== undefined) body.trial = trial
    writeJsonAtomic(join(this.dir, 'command.json'), body)
    return this.seq
  }

  async prepare (trial) {
    if (RUN_STATE.stopRequested) throw new Error('prepare refused: run is stopped')
    const seq = await this.send('prepare', trial)
    const state = await this.waitState(15000, s => s && s.preparedSeq === seq && s.trial?.trialId === trial.trialId)
    if (!state) throw new Error(`fixture did not prepare ${trial.trialId}`)
    if (state.stopLatched) throw new Error('prepare refused by fixture: stop latched')
    return state
  }

  async stop () {
    try { await this.send('stop') } catch { }
  }

  async close () {
    try { await this.send('exit') } catch { }
    await sleep(500)
    if (this.proc && this.proc.exitCode === null) {
      try { this.proc.kill() } catch { }
    }
  }
}

function guardState (state, trial) {
  if (!state) return { ok: false, reason: 'no-state' }
  if (state.runId !== RUN_ID) return { ok: false, reason: 'run-id-mismatch' }
  if (state.stopped || state.stopLatched) return { ok: false, reason: 'fixture-stopped' }
  if (state.startupActivated !== true) return { ok: false, reason: 'startup-not-activated' }
  if (!state.visible) return { ok: false, reason: 'fixture-not-visible' }
  if (state.trial?.trialId !== trial.trialId) return { ok: false, reason: 'trial-mismatch' }
  if (Math.abs(state.windowRect.x - trial.window.x) > 1 || Math.abs(state.windowRect.y - trial.window.y) > 1
    || Math.abs(state.windowRect.width - trial.window.width) > 1 || Math.abs(state.windowRect.height - trial.window.height) > 1) {
    return { ok: false, reason: 'window-geometry-mismatch', actual: state.windowRect, expected: trial.window }
  }
  const g = state.guard
  if (!g) return { ok: false, reason: 'no-guard' }
  if (!g.foregroundIsSelf) return { ok: false, reason: 'foreground-not-fixture', foregroundPid: g.foregroundPid, foregroundHwnd: g.foregroundHwnd }
  if (!g.windowIsSelf && !g.windowTransparent) return { ok: false, reason: 'target-occluded', windowPid: g.windowPid }
  if (state.attemptCount !== 0) return { ok: false, reason: 'attempts-not-zero', attempts: state.attemptCount }
  return { ok: true, guard: g }
}

function readFixtureState () {
  try { return readJson(join(FIXTURE_DIR, 'state.json')) } catch { return undefined }
}

function pidAlive (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * Observe stop/foreground/occlusion while a turn is in flight. Returns
 * {stop:true} only for a reason that must abort the whole run; the caller
 * cancels this session's turn and stops scheduling every later group.
 */
function observeControl (trial) {
  const state = readFixtureState()
  if (!state) {
    requestStop('fixture', 'fixture-state-missing', { trialId: trial.trialId })
    return { stop: true, source: 'fixture', reason: 'fixture-state-missing' }
  }
  if (state.runId !== RUN_ID) {
    requestStop('fixture', 'run-id-mismatch', { expected: RUN_ID, actual: state.runId })
    return { stop: true, source: 'fixture', reason: 'run-id-mismatch' }
  }
  if (!pidAlive(state.pid)) {
    requestStop('fixture', 'fixture-process-exited', { trialId: trial.trialId, pid: state.pid })
    return { stop: true, source: 'fixture', reason: 'fixture-process-exited' }
  }
  if (state.stopped || state.stopLatched) {
    requestStop('fixture', 'stop-button', { trialId: trial.trialId, attemptCount: state.attemptCount })
    return { stop: true, source: 'fixture', reason: 'stop-button' }
  }
  if (state.trial?.trialId !== trial.trialId) {
    requestStop('fixture', 'trial-mismatch', { expected: trial.trialId, actual: state.trial?.trialId })
    return { stop: true, source: 'fixture', reason: 'trial-mismatch' }
  }
  if (!state.visible) {
    requestStop('fixture', 'fixture-not-visible', { trialId: trial.trialId })
    return { stop: true, source: 'fixture', reason: 'fixture-not-visible' }
  }
  if (!state.guard?.foregroundIsSelf) {
    RUN_STATE.foregroundLosses.push({
      at: new Date().toISOString(),
      trialId: trial.trialId,
      foregroundHwnd: state.guard?.foregroundHwnd,
      foregroundPid: state.guard?.foregroundPid,
    })
    requestStop('foreground', 'foreground-not-fixture', {
      trialId: trial.trialId,
      foregroundHwnd: state.guard?.foregroundHwnd,
      foregroundPid: state.guard?.foregroundPid,
    })
    return { stop: true, source: 'foreground', reason: 'foreground-not-fixture' }
  }
  if (!state.guard.windowIsSelf && !state.guard.windowTransparent) {
    requestStop('occlusion', 'target-occluded', { trialId: trial.trialId, windowPid: state.guard.windowPid })
    return { stop: true, source: 'occlusion', reason: 'target-occluded' }
  }
  return { stop: false, state }
}

// -------------------------------------------------------------- attachments
function attachmentPath (id) {
  const hex = String(id).replace(/^sha256:/u, '')
  return join(DSH_HOME, 'attachments', 'v1', 'objects', hex.slice(0, 2), hex)
}

function copyAttachment (id, outPath) {
  if (!id) return undefined
  const src = attachmentPath(id)
  if (!existsSync(src)) return { id, error: 'attachment-missing' }
  mkdirSync(dirname(outPath), { recursive: true })
  copyFileSync(src, outPath)
  return { id, path: outPath, bytes: statSync(outPath).size }
}

function attachmentMeta (image) {
  if (!image) return undefined
  return {
    id: image.attachmentId,
    mediaType: image.mediaType,
    width: image.width,
    height: image.height,
    bytes: image.bytes,
    originalDimensions: image.originalDimensions,
  }
}

// -------------------------------------------------------------------- scoring
function eventsForTrial (trialId) {
  const p = join(FIXTURE_DIR, 'events.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return undefined }
  }).filter(e => e && e.trialId === trialId)
}

// ------------------------------------------------------------------ prompt text
function fmtCoord (n) {
  const r = Math.round(n * 1000) / 1000
  return Number.isInteger(r) ? String(r) : String(r)
}

function aPrompt (trial, first) {
  const nx = (trial.targetCenterScreen.x - trial.window.x) / trial.window.width * 1000
  const ny = (trial.targetCenterScreen.y - trial.window.y) / trial.window.height * 1000
  const pos = `[${fmtCoord(nx)}, ${fmtCoord(ny)}]`
  const rules = first
    ? '这是 0.2.17 点击准确性 A 组基线。规则：只使用 click 工具；不调用 screenshot/pwsh/read 或其他工具；必须逐字使用我给出的坐标；每题只点击一次；点击后立即结束本轮。\n'
    : ''
  return `${rules}[${trial.trialId}] 第 ${trial.index}/27 题，${trial.layoutVersion}。请调用 click：screen_index=0，position=${pos}。不要解释，不要重试，点击后结束本轮。`
}

function bPrompt (trial, first) {
  const rules = first
    ? '这是 0.2.17 点击准确性 B 组基线。规则：只使用本轮自动附带的截图和 click 工具；不要调用 screenshot/pwsh/read 或其他读取文件的工具；按文字选择唯一目标；先点一次，只有明显未命中才允许纠正一次；不要反复试点；点击后立即结束本轮。\n'
    : ''
  return `${rules}[${trial.trialId}] 第 ${trial.index}/30 题。${trial.instruction} 只调用 click（screen_index=0），不要解释，点击后结束本轮。`
}

function bCorrectionPrompt (trial) {
  return `[${trial.trialId}-R] 上一次点击未命中。请只再点击一次「${trial.targetLabel}」，这是唯一一次纠正；不要解释，点击后结束本轮。`
}

function a2Prompt (trial, first) {
  const rules = first
    ? '这是 0.2.17 小数坐标 A2 组。规则：只使用 click 工具；不调用 screenshot/pwsh/read 或其他工具；必须逐字使用给定的小数坐标；每题只点击一次；点击后自然结束本轮，不要解释。\n'
    : ''
  return `${rules}[${trial.trialId}] 第 ${trial.index}/12 题，${trial.layoutVersion}。请调用 click：screen_index=0，position=[${trial.specified.x}, ${trial.specified.y}]。不要重试，点击后结束本轮。`
}

function b2Prompt (trial, first) {
  const rules = first
    ? '这是 0.2.17 小目标 B2 组。规则：只使用本轮自动附带的截图和 click 工具；不调用 screenshot/pwsh/read 或其他读取文件的工具；按文字/图标选择唯一目标；先点一次；只有明确未命中时才会收到一次统一纠正提示；不要反复试点；点击后自然结束本轮。\n'
    : ''
  return `${rules}[${trial.trialId}] 第 ${trial.index}/36 题。${trial.instruction} 只调用 click（screen_index=0），不要解释，点击后结束本轮。`
}

function b2CorrectionPrompt (trial) {
  return `[${trial.trialId}-R] 未命中，请根据新回图纠正。请只再点击一次「${trial.targetLabel}」，这是唯一一次反馈后纠正；不要解释，点击后结束本轮。`
}

// ---------------------------------------------------------------- turn driver
function turnEndKind (end) {
  if (!end) return 'no-end'
  const reason = end.data?.reason
  if (reason?.kind === 'completed') return 'natural-completed'
  if (reason?.kind === 'aborted') return 'aborted'
  return reason?.kind ?? 'unknown'
}

function eventTimeIso (event) {
  if (!event) return undefined
  if (typeof event.time === 'number') return new Date(event.time).toISOString()
  return undefined
}

async function cancelAndWait (reader, sessionId, turn, reason) {
  const requestedAt = new Date().toISOString()
  RUN_STATE.turnCancels.push({ turn, reason, requestedAt, sessionId })
  controlEvent('turn-cancel-requested', { sessionId, turn, reason, requestedAt })
  await cancel(sessionId)
  const end = await waitFor(reader, r => r.events.find(e => e.type === 'turn/end' && e.data?.turn === turn), 15000, `aborted turn ${turn}`)
  const endedAt = new Date().toISOString()
  controlEvent('turn-cancel-completed', {
    sessionId,
    turn,
    reason,
    requestedAt,
    endedAt,
    turnEndKind: turnEndKind(end),
    turnEndReason: end?.data?.reason,
  })
  return { end, requestedAt, endedAt }
}

/**
 * Send one prompt and wait for its turn. The monitor runs while the model is
 * thinking and while a tool is executing; a stop or foreground loss cancels
 * only this session's active turn. It never sends prepare/raise/click.
 */
async function sendAndWait (reader, sessionId, text, options) {
  if (RUN_STATE.stopRequested) {
    return { ok: false, stop: true, reason: RUN_STATE.stopReason, sentAt: undefined, elapsedMs: 0 }
  }
  const previousMaxTurn = reader.maxTurn()
  const sentAt = Date.now()
  const sentAtIso = new Date(sentAt).toISOString()
  await prompt(sessionId, text)
  let start
  const startDeadline = Date.now() + options.timeoutMs
  while (Date.now() < startDeadline) {
    reader.refresh()
    start = reader.events.find(e => e.type === 'turn/start' && (e.data?.turn ?? 0) > previousMaxTurn)
    if (start) break
    const observed = options.monitor ? options.monitor(reader, -1) : undefined
    if (observed?.stop || RUN_STATE.stopRequested) {
      if (observed?.stop && !RUN_STATE.stopRequested) requestStop(observed.source ?? 'monitor', observed.reason ?? 'stop', observed.detail ?? {})
      // The prompt is already accepted. Try the official cancel even though no
      // turn has started; if a turn starts immediately afterwards, cancel again.
      await cancel(sessionId)
      const late = await waitFor(reader, r => r.events.find(e => e.type === 'turn/start' && (e.data?.turn ?? 0) > previousMaxTurn), 3000, 'late turn after stop')
      if (late) {
        const lateTurn = late.data.turn
        await cancelAndWait(reader, sessionId, lateTurn, 'controller-stop-before-turn-start')
      }
      controlEvent('stop-before-turn-start', { sessionId, stopReason: RUN_STATE.stopReason })
      return {
        ok: false,
        stop: true,
        reason: RUN_STATE.stopReason,
        sentAt,
        sentAtIso,
        elapsedMs: Date.now() - sentAt,
        turnEndKind: 'controller-stop-before-turn-start',
      }
    }
    await sleep(300)
  }
  if (!start) {
    if (RUN_STATE.stopRequested) return { ok: false, stop: true, reason: RUN_STATE.stopReason, sentAt, elapsedMs: Date.now() - sentAt }
    return { ok: false, reason: 'no-turn-start', sentAt, elapsedMs: Date.now() - sentAt }
  }
  const turn = start.data.turn
  const deadline = Date.now() + options.timeoutMs
  let clickResultAt
  let clickResultIso
  let stopObservedAt
  let firstResultHandled = false
  let firstResultDecision
  while (Date.now() < deadline) {
    reader.refresh()
    const end = reader.events.find(e => e.type === 'turn/end' && e.data?.turn === turn)
    if (end) {
      return {
        ok: true,
        turn,
        start,
        end,
        sentAt,
        sentAtIso,
        elapsedMs: Date.now() - sentAt,
        cancelled: false,
        turnEndKind: turnEndKind(end),
        clickResultAt,
        clickResultIso,
        stopObservedAt,
        firstResultDecision,
      }
    }
    const clickResults = clickCallsInTurn(reader, turn)
      .map(c => findClickResult(reader, turn, c.callId))
      .filter(Boolean)
    if (clickResults.length > 0 && clickResultAt === undefined) {
      clickResultAt = Date.now()
      clickResultIso = new Date(clickResultAt).toISOString()
    }
    if (clickResults.length > 0 && !firstResultHandled && options.onFirstResult) {
      const decision = options.onFirstResult(clickResults[0], turn)
      if (decision) {
        firstResultHandled = true
        firstResultDecision = decision
        if (decision.cancel) {
          const cancelled = await cancelAndWait(reader, sessionId, turn, decision.reason ?? 'first-result-cancel')
          reader.refresh()
          const endAfter = cancelled.end ?? reader.events.find(e => e.type === 'turn/end' && e.data?.turn === turn)
          return {
            ok: true,
            turn,
            start,
            end: endAfter,
            sentAt,
            sentAtIso,
            elapsedMs: Date.now() - sentAt,
            cancelled: true,
            cancelRequestedAt: cancelled.requestedAt,
            cancelEndedAt: cancelled.endedAt,
            turnEndKind: `controller-${decision.reason ?? 'first-result'}-cancel`,
            clickResultAt,
            clickResultIso,
            firstResultDecision,
          }
        }
      }
    }
    const observed = options.monitor ? options.monitor(reader, turn) : undefined
    if (observed?.stop) {
      if (!RUN_STATE.stopRequested) requestStop(observed.source ?? 'monitor', observed.reason ?? 'stop', observed.detail ?? {})
      stopObservedAt = new Date().toISOString()
      const cancelled = await cancelAndWait(reader, sessionId, turn, 'controller-stop')
      reader.refresh()
      const endAfter = cancelled.end ?? reader.events.find(e => e.type === 'turn/end' && e.data?.turn === turn)
      return {
        ok: false,
        stop: true,
        reason: RUN_STATE.stopReason,
        turn,
        start,
        end: endAfter,
        sentAt,
        sentAtIso,
        elapsedMs: Date.now() - sentAt,
        cancelled: true,
        cancelRequestedAt: cancelled.requestedAt,
        cancelEndedAt: cancelled.endedAt,
        turnEndKind: 'controller-stop-cancel',
        clickResultAt,
        clickResultIso,
        stopObservedAt,
      }
    }
    if (options.postClickGraceMs && clickResultAt !== undefined && Date.now() - clickResultAt > options.postClickGraceMs) {
      const cancelled = await cancelAndWait(reader, sessionId, turn, 'post-click-grace-expired')
      reader.refresh()
      const endAfter = cancelled.end ?? reader.events.find(e => e.type === 'turn/end' && e.data?.turn === turn)
      return {
        ok: true,
        turn,
        start,
        end: endAfter,
        sentAt,
        sentAtIso,
        elapsedMs: Date.now() - sentAt,
        cancelled: true,
        cancelRequestedAt: cancelled.requestedAt,
        cancelEndedAt: cancelled.endedAt,
        turnEndKind: 'controller-post-click-cancel',
        clickResultAt,
        clickResultIso,
      }
    }
    await sleep(500)
  }
  const cancelled = await cancelAndWait(reader, sessionId, turn, 'turn-timeout')
  reader.refresh()
  return {
    ok: false,
    reason: 'turn-timeout',
    turn,
    start,
    end: cancelled.end ?? reader.events.find(e => e.type === 'turn/end' && e.data?.turn === turn),
    sentAt,
    sentAtIso,
    elapsedMs: Date.now() - sentAt,
    cancelled: true,
    cancelRequestedAt: cancelled.requestedAt,
    cancelEndedAt: cancelled.endedAt,
    turnEndKind: 'controller-timeout-cancel',
    clickResultAt,
    clickResultIso,
  }
}

function clickState (reader, turn) {
  const calls = clickCallsInTurn(reader, turn)
  const results = calls.map(c => ({ call: c, result: findClickResult(reader, turn, c.callId) }))
  return { calls, results }
}

function specifiedForTrial (trial, group) {
  if (group !== 'A' && group !== 'A2') return undefined
  if (trial.specified) return trial.specified
  return {
    x: (trial.targetCenterScreen.x - trial.window.x) / trial.window.width * 1000,
    y: (trial.targetCenterScreen.y - trial.window.y) / trial.window.height * 1000,
  }
}

function promptForTrial (trial, group, firstPrompt) {
  if (group === 'A2') return a2Prompt(trial, firstPrompt)
  if (group === 'B2') return b2Prompt(trial, firstPrompt)
  return group === 'A' ? aPrompt(trial, firstPrompt) : bPrompt(trial, firstPrompt)
}

async function runOneTrial ({ fixture, reader, sessionId, trial, group, firstPrompt, timeoutMs, postClickGraceMs }) {
  if (RUN_STATE.stopRequested) {
    return { trialId: trial.trialId, group, ok: false, abort: true, reason: 'stop-before-prepare', stopSource: RUN_STATE.stopSource }
  }
  let prepared
  try {
    prepared = await fixture.prepare(trial)
  } catch (e) {
    requestStop('fixture', 'prepare-failed', { trialId: trial.trialId, error: e.message })
    return { trialId: trial.trialId, group, ok: false, abort: true, reason: 'prepare-failed', error: e.message }
  }
  // No raise, Activate, SetForegroundWindow or TopMost change here. A stale
  // foreground is evidence; the monitor below aborts instead of taking it back.
  let guard = guardState(prepared, trial)
  if (!guard.ok) {
    requestStop('guard', guard.reason, { trialId: trial.trialId, ...guard })
    return { trialId: trial.trialId, group, ok: false, abort: true, reason: `guard-failed:${guard.reason}`, guard, state: prepared }
  }
  const startedAt = Date.now()
  const text = promptForTrial(trial, group, firstPrompt)
  const monitor = () => observeControl(trial)
  const targetForFirst = prepared.buttons.find(b => b.isTarget)
  const onFirstResult = (result) => {
    const events = eventsForTrial(trial.trialId)
    const attempt = attemptFromEvents(events, 1)
    if (attempt.downs.length === 0) return undefined
    const preliminary = scoreAttempt({
      click: result.call,
      attempt,
      targetRect: targetForFirst?.screenRect,
      window: prepared.windowRect,
      specified: specifiedForTrial(trial, group),
    })
    if (!preliminary.hit) {
      return { cancel: true, reason: 'first-click-miss', score: preliminary }
    }
    return { cancel: false, score: preliminary }
  }
  const turnResult = await sendAndWait(reader, sessionId, text, {
    timeoutMs,
    postClickGraceMs,
    monitor,
    onFirstResult,
  })
  const elapsedMs = Date.now() - startedAt
  if (turnResult.stop) {
    return {
      trialId: trial.trialId,
      group,
      ok: false,
      abort: true,
      reason: 'stop-requested',
      stopSource: RUN_STATE.stopSource,
      stopReason: RUN_STATE.stopReason,
      guard,
      turnResult,
      elapsedMs,
    }
  }
  if (!turnResult.ok) {
    return {
      trialId: trial.trialId,
      group,
      ok: false,
      abort: true,
      reason: turnResult.reason,
      guard,
      turnResult,
      elapsedMs,
    }
  }
  const turn = turnResult.turn
  reader.refresh()
  const calls = clickCallsInTurn(reader, turn)
  const clickResults = calls.map(c => ({ call: c, result: findClickResult(reader, turn, c.callId) }))
  const turnStartSeq = turnResult.start?.seq ?? 0
  const turnEndSeq = turnResult.end?.seq ?? reader.maxSeq()
  const firstClickSeq = calls[0]?.seq ?? turnEndSeq
  const notice = computerUseNoticeInTurn(reader, turnStartSeq, firstClickSeq)
  const forbidden = forbiddenCallsInTurn(reader, turn)
  const promptEvent = promptMessageInTurn(reader, turnStartSeq, `[${trial.trialId}]`)
  const fixtureEvents = eventsForTrial(trial.trialId)
  const targetButton = prepared.buttons.find(b => b.isTarget)
  const targetRect = targetButton.screenRect
  const attempt1 = attemptFromEvents(fixtureEvents, 1)
  const attempt2 = attemptFromEvents(fixtureEvents, 2)
  const firstClick = clickResults[0]
  const secondClick = clickResults[1]
  const specified = specifiedForTrial(trial, group)
  const firstScore = scoreAttempt({
    click: firstClick?.call,
    attempt: attempt1,
    targetRect,
    window: prepared.windowRect,
    specified,
  })
  const secondScore = secondClick
    ? scoreAttempt({ click: secondClick.call, attempt: attempt2, targetRect, window: prepared.windowRect })
    : undefined
  const firstResultEvent = firstClick?.result
    ? reader.events.find(e => e.seq === firstClick.result.seq)
    : undefined
  const toolResultAt = eventTimeIso(firstResultEvent)
  const turnEndAt = eventTimeIso(turnResult.end)
  return {
    trialId: trial.trialId,
    group,
    ok: true,
    abort: false,
    guard,
    turn,
    elapsedMs,
    promptSeq: promptEvent?.seq,
    clickCalls: calls.map(c => ({
      seq: c.seq,
      callId: c.callId,
      args: c.args,
      expected: expectedLanding(prepared.windowRect, c.args.position),
    })),
    clickResults: clickResults.map(x => ({
      callId: x.call.callId,
      seq: x.result?.seq,
      text: x.result?.text,
      image: attachmentMeta(x.result?.image),
    })),
    beforeImage: attachmentMeta(imageOfMessage(notice)),
    afterImage: attachmentMeta(firstClick?.result?.image),
    afterImage2: attachmentMeta(secondClick?.result?.image),
    fixtureEvents,
    firstScore,
    secondScore,
    hit: firstScore.hit,
    recoveryHit: secondScore?.hit === true,
    specified,
    forbidden,
    noticeText: textOfMessage(notice),
    targetButton,
    stateAtStart: {
      windowRect: prepared.windowRect,
      dpi: prepared.dpi,
      scale: prepared.scale,
      targetCenter: prepared.targetCenter,
      buttons: prepared.buttons,
      guard: prepared.guard,
      startupActivated: prepared.startupActivated,
    },
    turnResult,
    turnEnd: {
      kind: turnResult.turnEndKind,
      reason: turnResult.end?.data?.reason,
      cancelled: turnResult.cancelled === true,
      clickResultAt: turnResult.clickResultIso,
      toolResultAt,
      turnEndAt,
      stopObservedAt: turnResult.stopObservedAt,
      cancelRequestedAt: turnResult.cancelRequestedAt,
      cancelEndedAt: turnResult.cancelEndedAt,
      toolResultLatencyMs: toolResultAt ? new Date(toolResultAt).getTime() - turnResult.sentAt : undefined,
      postToolToEndMs: toolResultAt && turnEndAt ? new Date(turnEndAt).getTime() - new Date(toolResultAt).getTime() : undefined,
      turnElapsedMs: turnEndAt ? new Date(turnEndAt).getTime() - turnResult.sentAt : undefined,
      firstResultDecision: turnResult.firstResultDecision
        ? { cancel: turnResult.firstResultDecision.cancel === true, reason: turnResult.firstResultDecision.reason }
        : undefined,
    },
  }
}

// ------------------------------------------------------------------- evidence
function clickText (result) {
  return (result.clickResults ?? []).map(r => r.text ?? '').join('\n')
}
function modeFromResult (result) {
  const text = clickText(result)
  if (/0[–-]1000/u.test(text)) return 'millifraction'
  if (/pixels?/iu.test(text)) return 'pixel'
  return 'unknown'
}

function saveTrialEvidence (result, trial) {
  const dir = join(EVIDENCE_DIR, 'trials', trial.trialId)
  mkdirSync(dir, { recursive: true })
  const beforeCopy = result.beforeImage?.id ? copyAttachment(result.beforeImage.id, join(dir, `before.${result.beforeImage.mediaType?.split('/')[1] ?? 'webp'}`)) : undefined
  const afterCopy = result.afterImage?.id ? copyAttachment(result.afterImage.id, join(dir, `after.${result.afterImage.mediaType?.split('/')[1] ?? 'webp'}`)) : undefined
  const after2Copy = result.afterImage2?.id ? copyAttachment(result.afterImage2.id, join(dir, `after2.${result.afterImage2.mediaType?.split('/')[1] ?? 'webp'}`)) : undefined
  const before = result.beforeImage ? { ...result.beforeImage, ...(beforeCopy ?? {}) } : undefined
  const after = result.afterImage ? { ...result.afterImage, ...(afterCopy ?? {}) } : undefined
  const after2 = result.afterImage2 ? { ...result.afterImage2, ...(after2Copy ?? {}) } : undefined
  const record = {
    runId: RUN_ID,
    trialId: trial.trialId,
    group: result.group,
    layoutVersion: trial.layoutVersion,
    index: trial.index,
    seed: trial.seed ?? planSeedForTrial(trial),
    scorerVersion: SCORER_VERSION,
    target: {
      id: trial.targetId,
      label: trial.targetLabel,
      rectClient: trial.targetRect,
      rectScreen: result.targetButton?.screenRect,
      centerScreen: result.targetButton ? {
        x: result.targetButton.screenRect.x + Math.floor(result.targetButton.screenRect.width / 2),
        y: result.targetButton.screenRect.y + Math.floor(result.targetButton.screenRect.height / 2),
      } : undefined,
      sizePhysical: trial.sizePhysical,
      sizeDip: trial.sizeDip,
      position: trial.position,
      sizeClass: trial.sizeClass,
      roundingNote: trial.roundingNote,
      exactMapping: trial.exactMapping,
      roundingFraction: trial.roundingFraction,
    },
    window: result.stateAtStart?.windowRect,
    dpi: result.stateAtStart?.dpi,
    scale: result.stateAtStart?.scale,
    coordinateMode: modeFromResult(result),
    eventLocationSource: result.firstScore?.locationSource ?? 'none',
    guardBefore: result.guard,
    guardObserved: result.stateAtStart?.guard,
    startupActivated: result.stateAtStart?.startupActivated,
    specified: result.specified,
    clickCalls: result.clickCalls,
    clickResults: result.clickResults,
    firstAttempt: result.firstScore,
    correctionAttempt: undefined,
    sameTurnExtraAttempt: result.secondScore,
    extraClickCount: Math.max(0, (result.clickCalls?.length ?? 0) - 1),
    hit: result.hit,
    recoveryHit: result.recoveryHit,
    duplicateDowns: result.firstScore?.checks?.duplicateDowns,
    missingUp: result.firstScore?.checks?.missingUp,
    duplicateActivations: result.firstScore?.checks?.duplicateActivations,
    environmentAbort: false,
    abortReason: undefined,
    forbiddenCalls: result.forbidden,
    beforeImage: before ?? result.beforeImage,
    afterImage: after ?? result.afterImage,
    afterImage2: after2 ?? result.afterImage2,
    elapsedMs: result.elapsedMs,
    turn: result.turn,
    turnEnd: result.turnEnd,
    noticeText: result.noticeText,
    fixtureEvents: result.fixtureEvents,
    savedAt: new Date().toISOString(),
  }
  writeJson(join(dir, 'result.json'), record)
  return record
}

function planSeedForTrial (trial) {
  return trial.seed ?? 20261021
}

function saveAbortEvidence (record, trial) {
  const dir = join(EVIDENCE_DIR, 'trials', trial.trialId)
  mkdirSync(dir, { recursive: true })
  const full = {
    runId: RUN_ID,
    trialId: trial.trialId,
    group: trial.group,
    layoutVersion: trial.layoutVersion,
    index: trial.index,
    seed: trial.seed ?? 20261021,
    scorerVersion: SCORER_VERSION,
    target: {
      id: trial.targetId,
      label: trial.targetLabel,
      rectClient: trial.targetRect,
      sizePhysical: trial.sizePhysical,
      sizeDip: trial.sizeDip,
      position: trial.position,
      sizeClass: trial.sizeClass,
      roundingNote: trial.roundingNote,
    },
    window: trial.window,
    environmentAbort: true,
    abortReason: record.abortReason ?? record.reason ?? 'aborted',
    stopSource: record.stopSource,
    stopReason: record.stopReason,
    guardBefore: record.guardBefore ?? record.guard,
    clickCalls: record.clickCalls ?? [],
    clickResults: record.clickResults ?? [],
    fixtureEvents: record.fixtureEvents ?? [],
    turnEnd: record.turnEnd ?? (record.turnResult
      ? {
          kind: record.turnResult.turnEndKind,
          reason: record.turnResult.end?.data?.reason,
          cancelled: record.turnResult.cancelled === true,
          stopObservedAt: record.turnResult.stopObservedAt,
          cancelRequestedAt: record.turnResult.cancelRequestedAt,
          cancelEndedAt: record.turnResult.cancelEndedAt,
          turnEndAt: eventTimeIso(record.turnResult.end),
        }
      : undefined),
    hit: false,
    firstAttempt: {
      hit: false,
      primaryFailure: record.abortReason ?? record.reason ?? 'aborted',
      locationSource: 'none',
      checks: {
        targetHit: false,
        targetActivation: false,
        parametersMatchSpecified: null,
        landingMatchesExpected: false,
        pressReleaseComplete: false,
        duplicateDowns: false,
        missingUp: false,
        duplicateActivations: false,
        allChecksPassed: false,
      },
    },
    savedAt: new Date().toISOString(),
  }
  writeJson(join(dir, 'result.json'), full)
  return full
}

function saveSessionEvidence (reader, sessionId, group) {
  const dir = join(EVIDENCE_DIR, 'sessions')
  mkdirSync(dir, { recursive: true })
  reader.refresh()
  const text = reader.events.map(e => JSON.stringify(e)).join('\n') + '\n'
  writeFileSync(join(dir, `${group}-${sessionId}.jsonl`), text)
  writeJson(join(dir, `${group}-${sessionId}.meta.json`), {
    sessionId,
    group,
    logPath: reader.file,
    events: reader.events.length,
    maxSeq: reader.maxSeq(),
  })
}

// ------------------------------------------------------------------ meta
const SUMMARY_PATH = join(REPO, 'packages', 'computer-use', 'tests', 'click-accuracy', 'summary.mjs')
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(DSH_HOME, 'profiles', 'desktop')

function readInstalledPackage () {
  const pkgPath = join(PROFILE_DIR, 'node_modules', 'dsh-orb', 'package.json')
  const pkg = readJson(pkgPath)
  return { version: pkg.version, installedPath: join(PROFILE_DIR, 'node_modules', 'dsh-orb') }
}

function measureDisplay () {
  const out = join(RUN_DIR, 'display-info.json')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', DISPLAY_SCRIPT, '-Out', out], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  })
  if (!existsSync(out)) {
    throw new Error(`display measurement failed (exit ${r.status}): ${r.stderr ?? ''}`)
  }
  const info = readJson(out)
  info.commandExit = r.status
  return info
}

function sessionConfig (readers) {
  for (const [group, reader] of Object.entries(readers)) {
    reader.refresh()
    const header = reader.events.find(e => e.type === 'request/header')
    const c = header?.data?.header?.config
    if (c) return {
      provider: c.provider,
      model: c.model,
      reasoningEffort: c.reasoningEffort,
      source: `session request/header (${group}, seq ${header.seq})`,
    }
  }
  return undefined
}

function inferCoordinateMode (records) {
  for (const r of records) {
    for (const cr of r.clickResults ?? []) {
      const text = cr.text ?? ''
      if (/0[–-]1000/u.test(text)) return { mode: 'millifraction', source: 'click result text', evidence: text.slice(0, 120) }
      if (/pixels?/iu.test(text)) return { mode: 'pixel', source: 'click result text', evidence: text.slice(0, 120) }
    }
    for (const e of r.sessionEvents ?? []) {
      if (e.type === 'computer-use/coordinate-mode' || e.type === 'plugin:computer-use/coordinate-mode') {
        return { mode: e.data?.mode ?? 'unknown', source: 'session event coordinate-mode' }
      }
    }
  }
  return { mode: 'unknown', source: 'no click result or coordinate-mode stamp' }
}

function makeEnvironment ({ installed, display, session, coordinateMode }) {
  const p = display?.primary
  const screen = p
    ? `${p.bounds.width}x${p.bounds.height} physical; working ${p.workingArea.width}x${p.workingArea.height} at (${p.workingArea.x},${p.workingArea.y}); ${display.screenCount} display(s); DPI ${p.dpiX}x${p.dpiY}; scale ${(p.scale * 100).toFixed(0)}%`
    : 'unknown (display measurement missing)'
  return {
    version: installed.version,
    installedPath: installed.installedPath,
    model: session ? `${session.model} (${session.provider}, reasoningEffort=${session.reasoningEffort})` : 'unknown (no session request/header)',
    modelSource: session?.source ?? 'unknown',
    screen,
    screenSource: display?.source ?? 'unknown',
    display,
    coordinateMode: coordinateMode
      ? `${coordinateMode.mode}${coordinateMode.source ? `; source: ${coordinateMode.source}` : ''}`
      : 'unknown',
    coordinateModeSource: coordinateMode?.source ?? 'unknown',
    harnessWebUrl: WEB_URL,
    profile: process.env.DSH_PROFILE ?? 'desktop',
    measuredAt: new Date().toISOString(),
  }
}

// --------------------------------------------------------------- score-only
function hashFile (path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function walkFiles (dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else if (entry.isFile()) out.push(full)
  }
  return out.sort()
}

function hashSourceTree (root) {
  return walkFiles(root).map(path => ({
    path: path.slice(root.length + 1).replaceAll('\\', '/'),
    bytes: statSync(path).size,
    sha256: hashFile(path),
  }))
}

function rescoreRecord (record) {
  const window = record.window ?? record.stateAtStart?.windowRect
  const targetRect = record.target?.rectScreen
  const events = record.fixtureEvents ?? []
  const click1 = record.clickCalls?.[0]
  const attempt1 = attemptFromEvents(events, 1)
  const score1 = scoreAttempt({
    click: click1,
    attempt: attempt1,
    targetRect,
    window,
    specified: record.specified,
  })
  const click2 = record.clickCalls?.[1]
  const attempt2 = attemptFromEvents(events, 2)
  const score2 = click2
    ? scoreAttempt({ click: click2, attempt: attempt2, targetRect, window })
    : undefined
  const feedbackCorrection = record.correctionTurn ? (score2 ?? record.correctionAttempt) : undefined
  const sameTurnExtra = record.correctionTurn ? undefined : (score2 ?? record.correctionAttempt)
  return {
    ...record,
    firstAttempt: score1,
    correctionAttempt: feedbackCorrection,
    sameTurnExtraAttempt: sameTurnExtra,
    extraClickCount: Math.max(0, (record.clickCalls?.length ?? 0) - 1),
    hit: score1.hit,
    recoveryHit: feedbackCorrection?.hit === true,
    locationSource: score1.locationSource,
  }
}

async function scoreOnly () {
  const sourceDir = EVIDENCE_DIR
  if (!existsSync(sourceDir)) throw new Error(`source run evidence not found: ${sourceDir}`)
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const analysisDir = join(EVIDENCE_ROOT, 'analysis', `${RUN_ID}-${ARGS.analysisId ?? stamp}`)
  if (existsSync(analysisDir)) throw new Error(`analysis directory already exists: ${analysisDir}`)
  mkdirSync(analysisDir, { recursive: true })

  const before = hashSourceTree(sourceDir)
  const plan = existsSync(join(sourceDir, 'plan.json')) ? readJson(join(sourceDir, 'plan.json')) : undefined
  const meta = existsSync(join(sourceDir, 'environment.json')) ? readJson(join(sourceDir, 'environment.json')) : undefined
  const sourceSummary = existsSync(join(sourceDir, 'summary.json')) ? readJson(join(sourceDir, 'summary.json')) : undefined
  let records
  if (existsSync(join(sourceDir, 'records.json'))) {
    records = readJson(join(sourceDir, 'records.json'))
  } else {
    records = readdirSync(join(sourceDir, 'trials'), { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => join(sourceDir, 'trials', d.name, 'result.json'))
      .filter(existsSync)
      .map(readJson)
  }
  const rescored = records.map(rescoreRecord)
  const durations = sourceSummary?.durations ?? {
    totalMs: undefined,
    perTrial: rescored.map(r => ({ trialId: r.trialId, ms: r.elapsedMs })),
  }
  const rescoredAt = new Date().toISOString()
  const summary = buildSummary({
    runId: RUN_ID,
    sourceRunId: RUN_ID,
    records: rescored,
    meta,
    plan,
    startedAt: sourceSummary?.startedAt ?? meta?.startedAt,
    finishedAt: sourceSummary?.finishedAt,
    sessionIds: sourceSummary?.sessionIds,
    durations,
    stopInfo: sourceSummary?.stopInfo,
    rescoredAt,
  })
  writeJson(join(analysisDir, 'summary.json'), summary)
  writeFileSync(join(analysisDir, 'summary.md'), summaryMarkdown(summary))
  writeJson(join(analysisDir, 'source-manifest-before.json'), before)
  const after = hashSourceTree(sourceDir)
  const unchanged = JSON.stringify(before) === JSON.stringify(after)
  const scorerHash = createHash('sha256').update(readFileSync(SCORER_PATH)).update(readFileSync(SUMMARY_PATH)).digest('hex')
  const provenance = {
    sourceRunId: RUN_ID,
    analysisDir,
    rescoredAt,
    scorerVersion: SCORER_VERSION,
    scorerHash,
    scorerPath: SCORER_PATH,
    sourceFileCount: before.length,
    sourceUnchanged: unchanged,
    sourceManifestBefore: join(analysisDir, 'source-manifest-before.json'),
    sourceManifestAfter: join(analysisDir, 'source-manifest-after.json'),
    note: 'score-only reads the saved plan, environment and records; it does not regenerate the plan, re-read current display/model settings, or write the source run.',
  }
  writeJson(join(analysisDir, 'source-manifest-after.json'), after)
  writeJson(join(analysisDir, 'provenance.json'), provenance)
  writeFileSync(join(analysisDir, 'analysis.log'), [
    `rescoredAt=${rescoredAt}`,
    `sourceRunId=${RUN_ID}`,
    `scorerVersion=${SCORER_VERSION}`,
    `scorerHash=${scorerHash}`,
    `records=${records.length}`,
    `sourceUnchanged=${unchanged}`,
  ].join('\n') + '\n')
  console.log(JSON.stringify({
    sourceRunId: RUN_ID,
    analysisDir,
    sourceUnchanged: unchanged,
    groups: Object.fromEntries(Object.entries(summary.groups).map(([k, v]) => [k, {
      planned: v.planned,
      executed: v.executed,
      firstHit: v.firstHit,
      firstAllChecks: v.firstAllChecks,
      aborts: v.aborts,
    }])),
  }, null, 2))
  if (!unchanged) process.exitCode = 2
}

// ------------------------------------------------------------- correction
async function runCorrection ({ fixture, reader, sessionId, trial, group, record, timeoutMs, postClickGraceMs }) {
  if (RUN_STATE.stopRequested) return { stop: true, reason: 'stop-before-correction' }
  const state = readFixtureState()
  if (!state) {
    requestStop('fixture', 'fixture-state-missing-before-correction', { trialId: trial.trialId })
    return { stop: true, reason: 'fixture-state-missing' }
  }
  if (state.stopped || state.stopLatched) {
    requestStop('fixture', 'stop-before-correction', { trialId: trial.trialId })
    return { stop: true, reason: 'stop-before-correction' }
  }
  const attemptNo = (state.attemptCount ?? 0) + 1
  if (attemptNo > 2) return { stop: false, skipped: 'attempt-limit' }
  const text = group === 'B2' ? b2CorrectionPrompt(trial) : bCorrectionPrompt(trial)
  controlEvent('feedback-correction-scheduled', { trialId: trial.trialId, attemptNo, promptKind: 'unified-miss-feedback' })
  const turn = await sendAndWait(reader, sessionId, text, {
    timeoutMs,
    postClickGraceMs,
    monitor: () => observeControl(trial),
    onFirstResult: () => {
      const ev = eventsForTrial(trial.trialId)
      if (attemptFromEvents(ev, attemptNo).downs.length === 0) return undefined
      return { cancel: true, reason: 'correction-click-recorded' }
    },
  })
  if (turn.stop) return { stop: true, reason: RUN_STATE.stopReason, turn }
  if (!turn.ok) return { stop: false, ok: false, reason: turn.reason, turn }
  reader.refresh()
  const calls = clickCallsInTurn(reader, turn.turn)
  const results = calls.map(c => ({ call: c, result: findClickResult(reader, turn.turn, c.callId) }))
  const events = eventsForTrial(trial.trialId)
  const attempt = attemptFromEvents(events, attemptNo)
  const targetRect = record.target?.rectScreen
  const window = record.window
  const score = results[0]
    ? scoreAttempt({ click: results[0].call, attempt, targetRect, window })
    : scoreAttempt({ click: undefined, attempt, targetRect, window })
  record.correctionAttempt = {
    ...score,
    attemptNo,
    feedback: 'unified-miss-feedback-after-first-failure',
  }
  record.recoveryHit = score.hit === true
  record.fixtureEvents = events
  record.correctionClickCalls = calls.map(c => ({
    seq: c.seq,
    callId: c.callId,
    args: c.args,
    expected: expectedLanding(record.window, c.args.position),
  }))
  record.correctionClickResults = results.map(x => ({
    callId: x.call.callId,
    seq: x.result?.seq,
    text: x.result?.text,
    image: attachmentMeta(x.result?.image),
  }))
  const corrResultEvent = results[0]?.result
    ? reader.events.find(e => e.seq === results[0].result.seq)
    : undefined
  record.correctionTurn = {
    kind: turn.turnEndKind,
    turn: turn.turn,
    clickResultAt: turn.clickResultIso,
    toolResultAt: eventTimeIso(corrResultEvent),
    turnEndAt: eventTimeIso(turn.end),
    cancelled: turn.cancelled === true,
    firstResultDecision: turn.firstResultDecision
      ? { cancel: turn.firstResultDecision.cancel === true, reason: turn.firstResultDecision.reason }
      : undefined,
  }
  const image = results[0]?.result?.image
  if (image) {
    const dir = join(EVIDENCE_DIR, 'trials', trial.trialId)
    const saved = copyAttachment(image.attachmentId, join(dir, `after-correction.${image.mediaType?.split('/')[1] ?? 'webp'}`))
    record.afterImageCorrection = saved ? { ...attachmentMeta(image), ...saved } : attachmentMeta(image)
  }
  writeJson(join(EVIDENCE_DIR, 'trials', trial.trialId, 'result.json'), record)
  controlEvent('feedback-correction-completed', {
    trialId: trial.trialId,
    attemptNo,
    targetHit: score.hit,
    allChecksPassed: score.checks.allChecksPassed,
    turnEndKind: turn.turnEndKind,
  })
  return { stop: false, ok: true, score, turn }
}

// -------------------------------------------------------------------- main
async function main () {
  if (ARGS.scoreOnly) {
    await scoreOnly()
    return
  }
  if (existsSync(RUN_DIR) || existsSync(EVIDENCE_DIR)) {
    throw new Error(`run id already exists: ${RUN_ID}; use a new run_id (old evidence is never overwritten)`)
  }
  mkdirSync(RUN_DIR, { recursive: true })
  mkdirSync(FIXTURE_DIR, { recursive: true })
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  logReady = true
  controlEvent('runner-start', { runId: RUN_ID, groups: ARGS.groups, pid: process.pid, startedAt: STARTED_AT })

  const modern = ARGS.groups.some(g => ['A2', 'B2'].includes(g))
  const legacy = ARGS.groups.some(g => ['A', 'B'].includes(g))
  if (modern && legacy) throw new Error('do not mix A/B with A2/B2 in one run')
  const plan = modern ? buildPlan2() : buildPlan()
  const selectedTrials = plan.trials.filter(t => ARGS.groups.includes(t.group))
  const summaryPlan = { ...plan, trials: selectedTrials }
  const installed = readInstalledPackage()
  const display = measureDisplay()
  const initialMeta = makeEnvironment({ installed, display })
  writeJson(join(RUN_DIR, 'plan.json'), plan)
  writeJson(join(EVIDENCE_DIR, 'plan.json'), plan)
  writeJson(join(RUN_DIR, 'environment.json'), { ...initialMeta, runId: RUN_ID, startedAt: STARTED_AT, planSeed: plan.seed })
  writeJson(join(EVIDENCE_DIR, 'environment.json'), { ...initialMeta, runId: RUN_ID, startedAt: STARTED_AT, planSeed: plan.seed })
  log('environment', { version: installed.version, screen: initialMeta.screen, groups: ARGS.groups })

  const fixture = new Fixture()
  const readers = {}
  const sessions = {}
  const records = []
  let probeScheduled = false
  try {
    if (!ARGS.noFixtureStart) await fixture.start()
    else {
      const s = await fixture.waitState(15000, x => x && x.status === 'ready')
      if (!s) throw new Error('existing fixture not ready')
    }
    const fixtureStart = readFixtureState()
    if (!fixtureStart?.startupActivated) {
      requestStop('fixture', 'startup-not-activated')
      throw new Error('fixture did not report a single startup activation')
    }

    const groups = ARGS.groups.filter(g => plan.trials.some(t => t.group === g))
    for (const group of groups) {
      if (RUN_STATE.stopRequested) break
      const cwd = join(tmpdir(), `orb-click-${group.toLowerCase()}-${RUN_ID}`)
      mkdirSync(cwd, { recursive: true })
      const sessionId = await createSession(cwd)
      if (RUN_STATE.stopRequested) break
      sessions[group] = sessionId
      const reader = new SessionReader(sessionId, await waitForSessionLog(sessionId))
      reader.refresh()
      readers[group] = reader
      log(`${group} session`, sessionId)
      const limit = group === 'A' ? ARGS.limitA : group === 'B' ? ARGS.limitB : group === 'A2' ? ARGS.limitA2 : ARGS.limitB2
      let first = true
      let count = 0
      const groupTrials = plan.trials.filter(t => t.group === group)
      for (const trial of groupTrials) {
        if (RUN_STATE.stopRequested) break
        if (count >= limit) break
        count += 1
        log(`${group} trial`, trial.trialId, 'start')
        if (ARGS.controlProbe && !probeScheduled) {
          probeScheduled = true
          scheduleControlProbe(ARGS.controlProbe, fixture, ARGS.controlDelayMs)
        }
        let result
        try {
          result = await runOneTrial({
            fixture,
            reader,
            sessionId,
            trial,
            group,
            firstPrompt: first,
            timeoutMs: ARGS.timeoutMs,
            postClickGraceMs: ARGS.postClickGraceMs,
          })
        } catch (e) {
          log(`${group} trial error`, trial.trialId, e.message)
          result = { trialId: trial.trialId, group, ok: false, abort: true, reason: 'runner-error', error: e.message }
        }
        first = false
        if (!result.ok) {
          const abortRecord = saveAbortEvidence(result, trial)
          records.push(abortRecord)
          log(`${group} trial abort`, trial.trialId, result.reason)
          if (result.stopSource || RUN_STATE.stopRequested) break
          // A guard/fixture failure is a run-level abort; do not continue to later groups.
          if (String(result.reason).startsWith('guard-failed') || String(result.reason).includes('prepare')) break
          continue
        }
        let record = saveTrialEvidence(result, trial)
        records.push(record)
        log(`${group} trial done`, trial.trialId, {
          hit: record.hit,
          allChecks: record.firstAttempt?.checks?.allChecksPassed,
          primaryFailure: record.firstAttempt?.primaryFailure,
          locationSource: record.firstAttempt?.locationSource,
          turnEnd: record.turnEnd?.kind,
          calls: record.clickCalls.length,
          events: record.fixtureEvents.length,
        })
        if (RUN_STATE.stopRequested) break
        if (['B', 'B2'].includes(group) && record.hit !== true && record.clickCalls.length < 2) {
          const corr = await runCorrection({ fixture, reader, sessionId, trial, group, record, timeoutMs: ARGS.timeoutMs, postClickGraceMs: ARGS.postClickGraceMs })
          if (corr.stop) break
          if (corr.ok) log(`${group} correction done`, trial.trialId, { hit: record.recoveryHit, failure: record.correctionAttempt?.primaryFailure })
        }
        if (RUN_STATE.stopRequested) break
      }
      saveSessionEvidence(reader, sessionId, group)
      if (RUN_STATE.stopRequested) break
    }
    if (ARGS.controlProbe === 'stop-late-prepare' && RUN_STATE.stopRequested) {
      const before = readFixtureState()
      const lateSeq = await fixture.send('prepare', plan.trials[0])
      await sleep(700)
      const after = readFixtureState()
      RUN_STATE.latePrepare = {
        requestedSeq: lateSeq,
        beforePreparedSeq: before?.preparedSeq,
        afterPreparedSeq: after?.preparedSeq,
        beforeTrialId: before?.trial?.trialId,
        afterTrialId: after?.trial?.trialId,
        stopLatched: after?.stopLatched,
        lastResult: after?.lastResult,
        rejected: after?.lastResult === 'prepare-rejected-after-stop' && after?.preparedSeq === before?.preparedSeq,
      }
      controlEvent('probe-late-prepare-result', RUN_STATE.latePrepare)
    }
  } finally {
    try { await fixture.close() } catch { }
    for (const aux of PROBE_AUX) {
      try {
        writeJsonAtomic(join(aux.dir, 'command.json'), { seq: 999, command: 'exit' })
        await sleep(300)
      } catch { }
      if (aux.proc && aux.proc.exitCode === null) {
        try { aux.proc.kill() } catch { }
      }
    }
  }

  const finalMeta = makeEnvironment({
    installed,
    display,
    session: sessionConfig(readers),
    coordinateMode: inferCoordinateMode(records),
  })
  const finishedAt = new Date().toISOString()
  const summary = buildSummary({
    runId: RUN_ID,
    records,
    meta: finalMeta,
    plan: summaryPlan,
    startedAt: STARTED_AT,
    finishedAt,
    sessionIds: sessions,
    durations: {
      totalMs: Date.now() - new Date(STARTED_AT).getTime(),
      perTrial: records.map(r => ({ trialId: r.trialId, ms: r.elapsedMs })),
    },
    stopInfo: {
      stopRequested: RUN_STATE.stopRequested,
      stopSource: RUN_STATE.stopSource,
      stopReason: RUN_STATE.stopReason,
      stopAt: RUN_STATE.stopAt,
      turnCancels: RUN_STATE.turnCancels,
      foregroundLosses: RUN_STATE.foregroundLosses,
      latePrepare: RUN_STATE.latePrepare,
    },
  })
  writeJson(join(EVIDENCE_DIR, 'summary.json'), summary)
  writeFileSync(join(EVIDENCE_DIR, 'summary.md'), summaryMarkdown(summary))
  writeJson(join(EVIDENCE_DIR, 'environment.json'), { ...finalMeta, runId: RUN_ID, startedAt: STARTED_AT, finishedAt, planSeed: plan.seed })
  writeJson(join(RUN_DIR, 'environment.json'), { ...finalMeta, runId: RUN_ID, startedAt: STARTED_AT, finishedAt, planSeed: plan.seed })
  writeJson(join(EVIDENCE_DIR, 'records.json'), records)
  writeJson(join(RUN_DIR, 'records.json'), records)
  controlEvent('runner-complete', {
    recorded: records.length,
    aborts: records.filter(r => r.environmentAbort).length,
    stopRequested: RUN_STATE.stopRequested,
    stopReason: RUN_STATE.stopReason,
    finishedAt,
  })
  log('run complete', {
    planned: summary.planned,
    recorded: summary.recorded,
    executed: summary.executed,
    aborts: summary.aborts.total,
    notExecuted: summary.notExecuted,
    stop: RUN_STATE.stopReason,
    groups: Object.fromEntries(Object.entries(summary.groups).map(([k, v]) => [k, { hit: v.firstHit, allChecks: v.firstAllChecks, executed: v.executed }])),
  })
  for (const f of ['plan.json', 'display-info.json', 'control.jsonl', 'runner.log']) {
    const src = join(RUN_DIR, f)
    if (existsSync(src)) copyFileSync(src, join(EVIDENCE_DIR, f))
  }
  for (const f of ['events.jsonl', 'state.json', 'fixture.log']) {
    const src = join(FIXTURE_DIR, f)
    if (existsSync(src)) {
      mkdirSync(join(EVIDENCE_DIR, 'fixture'), { recursive: true })
      copyFileSync(src, join(EVIDENCE_DIR, 'fixture', f))
    }
  }
  console.log(JSON.stringify({
    runId: RUN_ID,
    evidenceDir: EVIDENCE_DIR,
    stop: RUN_STATE.stopReason ?? null,
    planned: summary.planned,
    recorded: summary.recorded,
    notExecuted: summary.notExecuted,
    groups: summary.groups,
  }, null, 2))
  if (RUN_STATE.stopRequested) process.exitCode = 20
}

main().catch(error => {
  try { log('fatal', error.stack ?? error.message) } catch { console.error(error) }
  console.error(error)
  process.exitCode = 1
})
