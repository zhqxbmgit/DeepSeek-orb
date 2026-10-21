import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

const isWindows = process.platform === 'win32'
const bundle = new URL('..', import.meta.url).pathname
const runtime = join(decodeURIComponent(bundle.replace(/^\/([A-Za-z]:)/u, '$1')), 'runtime')
const runner = join(runtime, 'run-with-evidence.ps1')
const reader = join(runtime, 'read-evidence.ps1')
const scratch = isWindows ? mkdtempSync(join(tmpdir(), 'dsh-orb-evidence-test-')) : ''
const powershell = 'powershell.exe'

after(() => {
  if (isWindows) rmSync(scratch, { recursive: true, force: true })
})

function runEvidence(options = {}) {
  const {
    taskId = 'test-task',
    phase = 'phase',
    command,
    nativeProgram,
    nativeArgs,
    root = scratch,
    rootEnv,
    noteEnv,
    env = {},
    extra = [],
  } = options
  const args = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', runner,
    '-TaskId', taskId,
    '-Phase', phase,
  ]
  if (nativeProgram !== undefined) {
    args.push('-NativeProgram', nativeProgram)
    args.push('-NativeArgsEnv', 'DSH_EVIDENCE_ARGS')
  } else {
    args.push('-CommandEnv', 'DSH_EVIDENCE_COMMAND')
  }
  if (rootEnv !== undefined) args.push('-EvidenceRootEnv', rootEnv)
  else args.push('-EvidenceRoot', root)
  if (noteEnv !== undefined) args.push('-NoteEnv', noteEnv)
  args.push(...extra)
  return spawnSync(powershell, args, {
    cwd: scratch,
    env: {
      ...process.env,
      ...(command === undefined ? {} : { DSH_EVIDENCE_COMMAND: command }),
      ...(nativeArgs === undefined ? {} : { DSH_EVIDENCE_ARGS: JSON.stringify(nativeArgs) }),
      ...env,
    },
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  })
}

function parseRun(result) {
  assert.notEqual(result.status, null, result.error?.message)
  assert.ok(result.stdout.trim().length > 0, `no JSON output; stderr=${result.stderr}`)
  const output = JSON.parse(result.stdout.trim())
  assert.equal(existsSync(output.summary_path), true)
  const summary = JSON.parse(readFileSync(output.summary_path, 'utf8'))
  assert.equal(statSync(output.summary_path).size, output.summary_bytes)
  return { output, summary }
}

function runReader(args, env = {}) {
  return spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', reader,
    ...args,
  ], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } })
}

describe('run-with-evidence', { skip: !isWindows }, () => {
  it('saves raw stdout and stderr separately and returns a small JSON summary', () => {
    const result = runEvidence({
      command: 'Write-Output "hello"; [Console]::Error.WriteLine("warn"); exit 0',
      extra: ['-ChecksPassed', '2', '-ChecksFailed', '0', '-ChecksSkipped', '1'],
    })
    const { output, summary } = parseRun(result)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(summary.schema, 'dsh-orb-evidence/v2')
    assert.equal(summary.status, 'exited_zero')
    assert.equal(summary.command_status, 'exited_zero')
    assert.equal(summary.evidence_status, 'complete')
    assert.equal(summary.exit_code, 0)
    assert.equal(summary.command_exit_code, 0)
    assert.equal(summary.shell_exit_code, 0)
    assert.equal(summary.tool_exit_code, 0)
    assert.deepEqual(summary.counts, { passed: 2, failed: 0, skipped: 1, total: 3 })
    assert.equal(summary.claims.tests, 'counts-recorded-not-independently-verified')
    assert.equal(summary.command.mode, 'powershell-script')
    assert.equal(summary.command.source, 'environment:DSH_EVIDENCE_COMMAND')
    assert.equal(summary.environment.powershell_edition, 'Desktop')
    assert.match(summary.environment.powershell_version, /^5\.1\./u)
    assert.equal(readFileSync(summary.logs[0].path, 'utf8').trim(), 'hello')
    assert.match(readFileSync(summary.logs[1].path, 'utf8'), /warn/u)
    assert.equal(summary.logs[0].sha256.length, 64)
    assert.equal(summary.logs[0].encoding, 'utf-8')
    assert.equal(output.summary_bytes < 65536, true)
    assert.equal(output.stdout.truncated, false)
    assert.equal(output.stderr.truncated, false)
    assert.equal(JSON.stringify(summary).includes('System.Diagnostics'), false)
    assert.equal(JSON.stringify(summary).includes('Exception'), false)
  })

  it('preserves a native program exit code without a handwritten exit statement', () => {
    const result = runEvidence({
      phase: 'native-failure',
      nativeProgram: process.execPath,
      nativeArgs: ['-e', 'process.exit(7)'],
    })
    assert.equal(result.status, 7, result.stderr)
    const { output, summary } = parseRun(result)
    assert.equal(output.tool_exit_code, 7)
    assert.equal(summary.status, 'exited_nonzero')
    assert.equal(summary.command_status, 'exited_nonzero')
    assert.equal(summary.evidence_status, 'complete')
    assert.equal(summary.exit_code, 7)
    assert.equal(summary.command_exit_code, 7)
    assert.equal(summary.shell_exit_code, null)
    assert.equal(summary.tool_exit_code, 7)
    assert.equal(summary.command.mode, 'native-program')
    assert.equal(summary.command.exit_code_scope, 'native-program')
  })

  it('documents that PowerShell script mode does not infer a nested native exit code', () => {
    const result = runEvidence({
      phase: 'script-native-contract',
      command: "& $env:DSH_TEST_NODE -e 'process.exit(7)'",
      env: { DSH_TEST_NODE: process.execPath },
    })
    assert.equal(result.status, 0, result.stderr)
    const { summary } = parseRun(result)
    assert.equal(summary.command.mode, 'powershell-script')
    assert.equal(summary.command.exit_code_scope, 'powershell-script')
    assert.equal(summary.exit_code, 0)
    assert.equal(summary.shell_exit_code, 0)
    assert.match(summary.warnings.join('\n'), /does not infer|PowerShell script mode/u)
  })

  it('marks truncated evidence incomplete and returns the truncation exit code while preserving command 0', () => {
    const command = "Write-Output ('x' * 4096); exit 0"
    const result = runEvidence({
      command,
      phase: 'overflow',
      extra: ['-MaxLogBytes', '1024'],
    })
    assert.equal(result.status, 74, result.stderr)
    const { output, summary } = parseRun(result)
    assert.equal(output.stdout.bytes, 4098)
    assert.equal(output.stdout.written_bytes, 1024)
    assert.equal(output.stdout.truncated, true)
    assert.equal(statSync(output.stdout.path).size, 1024)
    assert.equal(summary.status, 'exited_zero_evidence_truncated')
    assert.equal(summary.command_status, 'exited_zero')
    assert.equal(summary.evidence_status, 'truncated')
    assert.equal(summary.evidence_complete, false)
    assert.equal(summary.exit_code, 0)
    assert.equal(summary.command_exit_code, 0)
    assert.equal(summary.tool_exit_code, 74)
    assert.equal(summary.logs[0].dropped_bytes, 3074)
    assert.equal(summary.logs[0].truncated, true)
    assert.equal(summary.logs[0].complete, false)
    assert.equal(output.summary_bytes < 65536, true)
    assert.match(summary.warnings.join('\n'), /stdout exceeded 1024 bytes/u)
  })

  it('kills the owned child tree on timeout and leaves no late marker', async () => {
    const child = join(scratch, 'delayed-child.mjs')
    const startFile = join(scratch, 'child-start.json')
    const marker = join(scratch, 'child-continued.json')
    writeFileSync(child, [
      "import { writeFileSync } from 'node:fs'",
      'writeFileSync(process.env.DSH_TEST_START, JSON.stringify({ pid: process.pid, at: Date.now() }))',
      'setTimeout(() => writeFileSync(process.env.DSH_TEST_MARKER, JSON.stringify({ pid: process.pid, at: Date.now(), late: true })), 5000)',
      '',
    ].join('\n'))
    const result = runEvidence({
      phase: 'timeout-child',
      nativeProgram: process.execPath,
      nativeArgs: [child],
      env: { DSH_TEST_START: startFile, DSH_TEST_MARKER: marker },
      extra: ['-TimeoutSeconds', '1'],
    })
    assert.equal(result.status, 124, result.stderr)
    const { summary } = parseRun(result)
    assert.equal(summary.status, 'timed_out')
    assert.equal(summary.command_status, 'timed_out')
    assert.equal(summary.evidence_status, 'timed_out')
    assert.equal(summary.exit_code, 124)
    assert.equal(summary.command_exit_code, 124)
    assert.equal(summary.shell_exit_code, null)
    assert.equal(summary.tool_exit_code, 124)
    assert.equal(existsSync(startFile), true)
    const pid = JSON.parse(readFileSync(startFile, 'utf8')).pid
    await new Promise(resolve => setTimeout(resolve, 5500))
    assert.equal(existsSync(marker), false, 'the timed-out child wrote a late marker')
    assert.throws(() => process.kill(pid, 0), /ESRCH|not found|no such process/iu)
  })

  it('detects UTF-8 and GB18030 logs and returns the same Chinese text through the reader', () => {
    const chineseRoot = join(scratch, '证据目录')
    const noteEnv = 'DSH_EVIDENCE_NOTE'
    const rootEnv = 'DSH_EVIDENCE_ROOT'
    const utf8 = runEvidence({
      phase: 'unicode-script',
      command: "Write-Output '正常：大肥鱼'; [Console]::Error.WriteLine('错误：大肥鱼'); exit 0",
      rootEnv,
      noteEnv,
      env: { DSH_EVIDENCE_ROOT: chineseRoot, DSH_EVIDENCE_NOTE: '中文备注：大肥鱼' },
    })
    const { summary } = parseRun(utf8)
    assert.equal(utf8.status, 0, utf8.stderr)
    assert.equal(summary.note, '中文备注：大肥鱼')
    assert.equal(summary.logs[0].encoding, 'utf-8')
    assert.equal(summary.logs[1].encoding, 'utf-8')
    const stdoutRead = runReader(['-LogEnv', 'DSH_EVIDENCE_LOG'], { DSH_EVIDENCE_LOG: summary.logs[0].path })
    assert.equal(stdoutRead.status, 0, stdoutRead.stderr)
    const stdout = JSON.parse(stdoutRead.stdout.trim())
    assert.equal(stdout.encoding, 'utf-8')
    assert.equal(stdout.head, '正常：大肥鱼\r\n')
    const stderrRead = runReader(['-LogEnv', 'DSH_EVIDENCE_LOG'], { DSH_EVIDENCE_LOG: summary.logs[1].path })
    assert.equal(stderrRead.status, 0, stderrRead.stderr)
    assert.equal(JSON.parse(stderrRead.stdout.trim()).head, '错误：大肥鱼\r\n')

    const gbk = runEvidence({
      phase: 'unicode-native-gbk',
      nativeProgram: process.env.ComSpec ?? 'cmd.exe',
      nativeArgs: ['/d', '/s', '/c', 'echo 正常：大肥鱼'],
    })
    const gbkRun = parseRun(gbk)
    assert.equal(gbk.status, 0, gbk.stderr)
    assert.equal(gbkRun.summary.logs[0].encoding, 'gb18030')
    const gbkRead = runReader(['-Log', gbkRun.summary.logs[0].path])
    assert.equal(gbkRead.status, 0, gbkRead.stderr)
    const gbkLog = JSON.parse(gbkRead.stdout.trim())
    assert.equal(gbkLog.encoding, 'gb18030')
    assert.equal(gbkLog.encoding_valid, true)
    assert.equal(gbkLog.head.trim(), '正常：大肥鱼')
  })

  it('keeps a long UTF-8 log UTF-8 across the sample and preview boundaries', () => {
    const result = runEvidence({
      phase: 'long-utf8',
      nativeProgram: process.execPath,
      nativeArgs: ['-e', "process.stdout.write('大肥鱼'.repeat(10000))"],
    })
    const { summary } = parseRun(result)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(summary.logs[0].bytes, 90000)
    assert.equal(summary.logs[0].encoding, 'utf-8')
    assert.equal(summary.logs[0].encoding_valid, true)
    assert.equal(summary.logs[0].encoding_verified, 'sample-prefix')
    assert.equal(summary.logs[0].encoding_sample_bytes, 65536)

    const preview = runReader(['-Log', summary.logs[0].path, '-HeadBytes', '4', '-TailBytes', '4'])
    assert.equal(preview.status, 0, preview.stderr)
    const log = JSON.parse(preview.stdout.trim())
    assert.equal(log.encoding, 'utf-8')
    assert.equal(log.encoding_valid, true)
    assert.equal(log.encoding_verified, 'sample-prefix')
    assert.equal(log.head, '大')
    assert.equal(log.tail, '鱼')
    assert.ok(log.boundary_trimmed_head_bytes >= 1)
    assert.ok(log.boundary_trimmed_tail_bytes >= 1)
  })

  it('preserves direct executable arguments exactly', () => {
    const printer = join(scratch, 'print-args.mjs')
    writeFileSync(printer, 'console.log(JSON.stringify(process.argv.slice(2)))')
    const args = ['plain', 'two words', '中文路径', '', 'a"b', 'x^y', '%DSH_REVIEW_EXPAND%', 'a"b^c']
    const result = runEvidence({
      phase: 'native-argv',
      nativeProgram: process.execPath,
      nativeArgs: [printer, ...args],
    })
    assert.equal(result.status, 0, result.stderr)
    const { output, summary } = parseRun(result)
    assert.equal(summary.command.mode, 'native-program')
    assert.deepEqual(JSON.parse(readFileSync(output.stdout.path, 'utf8').trim()), args)
  })

  it('rejects unsafe .cmd arguments before executing the shim', () => {
    const printer = join(scratch, 'cmd-print-args.mjs')
    const marker = join(scratch, 'cmd-executed.txt')
    const shim = join(scratch, 'arg-shim.cmd')
    writeFileSync(printer, 'console.log(JSON.stringify(process.argv.slice(2)))')
    writeFileSync(shim, `@echo off\r\necho executed>"${marker}"\r\n"${process.execPath}" "${printer}" %*\r\nexit /b %ERRORLEVEL%\r\n`)
    const unsafe = 'abc"&echo REVIEW_ONLY_UNEXPECTED&rem xyz'
    const rejected = runEvidence({
      phase: 'cmd-unsafe',
      nativeProgram: shim,
      nativeArgs: [unsafe],
    })
    assert.equal(rejected.status, 2)
    assert.match(rejected.stderr, /native-cmd-shim/u)
    assert.equal(existsSync(marker), false)

    const stillRejected = runEvidence({
      phase: 'cmd-unsafe-allowed',
      nativeProgram: shim,
      nativeArgs: ['%DSH_REVIEW_EXPAND%'],
      extra: ['-AllowCmdShim'],
    })
    assert.equal(stillRejected.status, 2)
    assert.match(stillRejected.stderr, /metacharacter/u)
    assert.equal(existsSync(marker), false)

    const safe = runEvidence({
      phase: 'cmd-safe',
      nativeProgram: shim,
      nativeArgs: ['plain', 'two words'],
      extra: ['-AllowCmdShim'],
    })
    assert.equal(safe.status, 0, safe.stderr)
    const safeRun = parseRun(safe)
    assert.equal(safeRun.summary.command.mode, 'native-cmd-shim')
    assert.deepEqual(JSON.parse(readFileSync(safeRun.output.stdout.path, 'utf8').trim()), ['plain', 'two words'])
  })

  it('does not accept an illegal UTF-8 prefix at the sample boundary', () => {
    const invalid = Buffer.concat([
      Buffer.from([0xEF, 0xBB, 0xBF]),
      Buffer.alloc(65531, 0x61),
      Buffer.from([0xE0, 0x80, 0x80]),
      Buffer.alloc(5000, 0x61),
    ])
    const path = join(scratch, 'invalid-utf8-prefix.log')
    writeFileSync(path, invalid)
    const read = JSON.parse(runReader(['-Log', path]).stdout.trim())
    assert.equal(read.encoding, 'utf-8')
    assert.equal(read.encoding_verified, 'sample-prefix')
    assert.equal(read.encoding_valid, false)
    assert.equal(read.boundary_trimmed_head_bytes, 0)
    assert.equal(read.head_hex.startsWith('efbbbf'), true)

    const run = runEvidence({
      phase: 'invalid-utf8-sample',
      nativeProgram: process.execPath,
      nativeArgs: ['-e', "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))", path],
    })
    assert.equal(run.status, 0, run.stderr)
    const { summary } = parseRun(run)
    assert.equal(summary.logs[0].bytes, 70537)
    assert.equal(summary.logs[0].encoding, 'utf-8')
    assert.equal(summary.logs[0].encoding_verified, 'sample-prefix')
    assert.equal(summary.logs[0].encoding_valid, false)
  })

  it('does not hide an illegal UTF-8 prefix at a preview edge', () => {
    const path = join(scratch, 'invalid-utf8-preview.log')
    writeFileSync(path, Buffer.concat([
      Buffer.from([0xEF, 0xBB, 0xBF]),
      Buffer.alloc(100, 0x61),
      Buffer.from([0xE0, 0x80, 0x80]),
      Buffer.alloc(100, 0x61),
    ]))
    const read = JSON.parse(runReader(['-Log', path, '-HeadBytes', '105']).stdout.trim())
    assert.equal(read.encoding, 'utf-8')
    assert.equal(read.encoding_valid, false)
    assert.equal(read.boundary_trimmed_head_bytes, 0)
    assert.equal(read.head_bytes, 105)
    assert.equal(read.head_hex.startsWith('efbbbf'), true)
  })

  it('accepts a valid UTF-16 surrogate pair split by the sample boundary', () => {
    const text = 'a'.repeat(32766) + '😀' + 'b'.repeat(3000)
    const path = join(scratch, 'valid-utf16-surrogate.log')
    writeFileSync(path, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]))
    const read = JSON.parse(runReader(['-Log', path]).stdout.trim())
    assert.equal(read.encoding, 'utf-16le')
    assert.equal(read.encoding_verified, 'sample-prefix')
    assert.equal(read.encoding_valid, true)
    assert.equal(read.boundary_trimmed_head_bytes, 0)
    assert.equal(read.boundary_trimmed_tail_bytes, 0)

    const run = runEvidence({
      phase: 'valid-utf16-sample',
      nativeProgram: process.execPath,
      nativeArgs: ['-e', "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))", path],
    })
    assert.equal(run.status, 0, run.stderr)
    const { summary } = parseRun(run)
    assert.equal(summary.logs[0].encoding, 'utf-16le')
    assert.equal(summary.logs[0].encoding_verified, 'sample-prefix')
    assert.equal(summary.logs[0].encoding_valid, true)
  })

  it('handles UTF-16 surrogate preview boundaries but keeps isolated surrogates invalid', () => {
    const le = join(scratch, 'utf16-preview.log')
    writeFileSync(le, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('a😀b', 'utf16le')]))
    const leRead = JSON.parse(runReader(['-Log', le, '-HeadBytes', '6', '-TailBytes', '4']).stdout.trim())
    assert.equal(leRead.encoding, 'utf-16le')
    assert.equal(leRead.encoding_valid, true)
    assert.equal(leRead.head, 'a')
    assert.equal(leRead.tail, 'b')
    assert.equal(leRead.boundary_trimmed_head_bytes, 2)
    assert.equal(leRead.boundary_trimmed_tail_bytes, 2)

    const beBytes = Buffer.from('a😀b', 'utf16le')
    for (let index = 0; index < beBytes.length; index += 2) {
      const high = beBytes[index]
      beBytes[index] = beBytes[index + 1]
      beBytes[index + 1] = high
    }
    const be = join(scratch, 'utf16be-preview.log')
    writeFileSync(be, Buffer.concat([Buffer.from([0xFE, 0xFF]), beBytes]))
    const beRead = JSON.parse(runReader(['-Log', be, '-HeadBytes', '6', '-TailBytes', '4']).stdout.trim())
    assert.equal(beRead.encoding, 'utf-16be')
    assert.equal(beRead.encoding_valid, true)
    assert.equal(beRead.head, 'a')
    assert.equal(beRead.tail, 'b')

    const beSampleBytes = Buffer.from('a'.repeat(32766) + '😀' + 'b'.repeat(3000), 'utf16le')
    for (let index = 0; index < beSampleBytes.length; index += 2) {
      const high = beSampleBytes[index]
      beSampleBytes[index] = beSampleBytes[index + 1]
      beSampleBytes[index + 1] = high
    }
    const beSample = join(scratch, 'utf16be-surrogate-sample.log')
    writeFileSync(beSample, Buffer.concat([Buffer.from([0xFE, 0xFF]), beSampleBytes]))
    const beSampleRead = JSON.parse(runReader(['-Log', beSample]).stdout.trim())
    assert.equal(beSampleRead.encoding, 'utf-16be')
    assert.equal(beSampleRead.encoding_verified, 'sample-prefix')
    assert.equal(beSampleRead.encoding_valid, true)
    const beRun = runEvidence({
      phase: 'valid-utf16be-sample',
      nativeProgram: process.execPath,
      nativeArgs: ['-e', "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))", beSample],
    })
    assert.equal(beRun.status, 0, beRun.stderr)
    assert.equal(parseRun(beRun).summary.logs[0].encoding_valid, true)

    const isolated = join(scratch, 'utf16-isolated-surrogate.log')
    writeFileSync(isolated, Buffer.concat([
      Buffer.from([0xFF, 0xFE]),
      Buffer.from('a', 'utf16le'),
      Buffer.from([0x3D, 0xD8]),
    ]))
    const isolatedRead = JSON.parse(runReader(['-Log', isolated]).stdout.trim())
    assert.equal(isolatedRead.encoding, 'utf-16le')
    assert.equal(isolatedRead.encoding_valid, false)
    assert.equal(isolatedRead.boundary_trimmed_head_bytes, 0)
    assert.equal(isolatedRead.head_hex, 'fffe61003dd8')
  })

  it('does not claim an invalid byte stream is verified text', () => {
    const invalid = join(scratch, 'invalid.bin')
    writeFileSync(invalid, Buffer.from([0xFF, 0xFF, 0x0A]))
    const read = runReader(['-Log', invalid])
    assert.equal(read.status, 0, read.stderr)
    const result = JSON.parse(read.stdout.trim())
    assert.equal(result.encoding, 'unknown')
    assert.equal(result.encoding_valid, false)
    assert.equal(result.head, '')
    assert.equal(result.head_hex, 'ffff0a')
  })

  it('does not use EOF trimming to hide a damaged BOM file', () => {
    const invalid = join(scratch, 'bom-invalid-eof.log')
    writeFileSync(invalid, Buffer.from([0xEF, 0xBB, 0xBF, 0x61, 0x62, 0x63, 0xFF]))
    const read = runReader(['-Log', invalid])
    assert.equal(read.status, 0, read.stderr)
    const result = JSON.parse(read.stdout.trim())
    assert.equal(result.encoding, 'utf-8')
    assert.equal(result.encoding_source, 'detected-bom')
    assert.equal(result.encoding_verified, 'whole')
    assert.equal(result.encoding_valid, false)
    assert.equal(result.boundary_trimmed_head_bytes, 0)
    assert.equal(result.head_bytes, 7)
    assert.equal(result.truncated, false)
    assert.equal(result.head_hex, 'efbbbf616263ff')
    const damagedInterior = join(scratch, 'bom-invalid-interior.log')
    writeFileSync(damagedInterior, Buffer.from([0xEF, 0xBB, 0xBF, 0x61, 0x62, 0x63, 0xFF, 0x64]))
    const interior = JSON.parse(runReader(['-Log', damagedInterior, '-HeadBytes', '7']).stdout.trim())
    assert.equal(interior.encoding_valid, false)
    assert.equal(interior.boundary_trimmed_head_bytes, 0)
    assert.equal(interior.head_hex.startsWith('efbbbf616263ff'), true)
  })

  it('does not mark an incomplete UTF-16 EOF as a preview boundary', () => {
    const invalid = join(scratch, 'utf16-invalid-eof.log')
    writeFileSync(invalid, Buffer.from([0xFF, 0xFE, 0x41, 0x00, 0x42]))
    const read = runReader(['-Log', invalid])
    assert.equal(read.status, 0, read.stderr)
    const result = JSON.parse(read.stdout.trim())
    assert.equal(result.encoding, 'utf-16le')
    assert.equal(result.encoding_valid, false)
    assert.equal(result.boundary_trimmed_head_bytes, 0)
    assert.ok(result.head_hex.length > 0)
  })

  it('keeps runner and reader invalid-BOM semantics aligned', () => {
    const result = runEvidence({
      phase: 'invalid-bom-runner',
      nativeProgram: process.execPath,
      nativeArgs: ['-e', 'process.stdout.write(Buffer.from([0xEF,0xBB,0xBF,0x61,0x62,0x63,0xFF]))'],
    })
    assert.equal(result.status, 0, result.stderr)
    const { summary } = parseRun(result)
    assert.equal(summary.logs[0].bytes, 7)
    assert.equal(summary.logs[0].encoding, 'utf-8')
    assert.equal(summary.logs[0].encoding_source, 'detected-bom')
    assert.equal(summary.logs[0].encoding_verified, 'whole')
    assert.equal(summary.logs[0].encoding_valid, false)
  })

  it('reports a save failure and leaves the previous valid evidence untouched', () => {
    const first = runEvidence({ command: 'exit 0', phase: 'kept' })
    const { output } = parseRun(first)
    const previous = readFileSync(output.summary_path)
    const blocker = join(scratch, 'not-a-directory')
    writeFileSync(blocker, 'file')
    const failed = runEvidence({
      command: 'exit 0',
      phase: 'save-failure',
      root: join(blocker, 'child'),
    })
    assert.equal(failed.status, 2)
    assert.match(failed.stderr, /evidence:/u)
    assert.deepEqual(readFileSync(output.summary_path), previous)
  })

  it('reads summaries and log previews only within the byte limits', () => {
    const first = runEvidence({ command: 'Write-Output "0123456789"; exit 0', phase: 'read' })
    const { output } = parseRun(first)
    const summaryRead = runReader(['-Summary', output.summary_path])
    assert.equal(summaryRead.status, 0, summaryRead.stderr)
    const summary = JSON.parse(summaryRead.stdout.trim())
    assert.equal(summary.status, 'exited_zero')
    assert.equal(summary.bytes < 65536, true)

    const logRead = runReader(['-Log', output.stdout.path, '-HeadBytes', '4', '-TailBytes', '6'])
    assert.equal(logRead.status, 0, logRead.stderr)
    const log = JSON.parse(logRead.stdout.trim())
    assert.equal(log.head, '0123')
    assert.equal(log.tail.trim(), '6789')
    assert.equal(log.truncated, true)
    assert.equal(log.sha256.length, 64)

    const huge = join(scratch, 'huge-summary.json')
    writeFileSync(huge, 'x'.repeat(70_000))
    const refused = runReader(['-Summary', huge])
    assert.equal(refused.status, 2)
    assert.match(refused.stderr, /above the 65536-byte read limit/u)
  })
})
