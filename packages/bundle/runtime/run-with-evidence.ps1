#requires -Version 5.1
<#
.SYNOPSIS
Run a child command under the official pwsh tool and keep bounded evidence.

.DESCRIPTION
This is a companion to the official `pwsh` tool, not a replacement shell. It
starts one owned child process tree, writes stdout and stderr to separate files
while enforcing a streaming byte cap, then writes a small JSON summary with only
scalar fields, counts, and evidence paths.

Two execution modes are explicit:

* `-NativeProgram/-NativeArguments` starts one program directly. The program's
  real exit code is preserved. `.cmd`/`.bat` files are started through the
  Windows command processor because CreateProcess cannot execute them directly;
  that wrapper is recorded as `native-cmd-shim`.
* `-CommandText`/`-CommandEnv` writes a PowerShell script. The reported exit code
  is the PowerShell process exit code; this mode does not infer a native command's
  exit code. Use a native mode for build/test commands whose status matters.

The child tree is owned through a Windows job object. On timeout the job is
terminated and the job handle is closed, so descendants of this one command are
handled without looking up process names. On a normal command exit the job is
closed too, which prevents leftover descendants from keeping the log pipes open.

The command's output is not echoed. The caller receives one compact JSON line
with summary path, byte size, command/evidence status, command exit code, tool
exit code, and log metadata.

.EXAMPLE
$env:DSH_EVIDENCE_ARGS = '["C:\\path\\to\\pnpm.cjs","run","typecheck"]'
& "$HOME\.dsh\profiles\desktop\node_modules\dsh-orb\runtime\run-with-evidence.ps1" `
  -TaskId 'reliability-028' -Phase 'typecheck' `
  -NativeProgram 'node.exe' -NativeArgsEnv 'DSH_EVIDENCE_ARGS'

A .cmd/.bat program is rejected by default because CMD changes metacharacters
and can execute extra commands. Pass -AllowCmdShim only for safe ASCII arguments
(no quotes, percent, caret, ampersand, pipe, redirection, parentheses, or empty
arguments). Prefer a direct .exe entry such as node.exe + pnpm.cjs.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')]
  [string]$TaskId,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')]
  [string]$Phase,

  [string]$CommandText = '',

  [ValidatePattern('^[A-Za-z_][A-Za-z0-9_]{0,63}$')]
  [string]$CommandEnv = '',

  [string]$NativeProgram = '',

  [ValidatePattern('^[A-Za-z_][A-Za-z0-9_]{0,63}$')]
  [string]$NativeProgramEnv = '',

  [switch]$AllowCmdShim,

  [string[]]$NativeArguments = @(),

  [ValidatePattern('^[A-Za-z_][A-Za-z0-9_]{0,63}$')]
  [string]$NativeArgsEnv = '',

  [string]$EvidenceRoot = '',

  [ValidatePattern('^[A-Za-z_][A-Za-z0-9_]{0,63}$')]
  [string]$EvidenceRootEnv = '',

  [ValidatePattern('^[A-Za-z_][A-Za-z0-9_]{0,63}$')]
  [string]$NoteEnv = '',

  [ValidateRange(1, 86400)]
  [int]$TimeoutSeconds = 1800,

  [ValidateRange(1024, 268435456)]
  [int]$MaxLogBytes = 16777216,

  [int]$ChecksPassed = -1,

  [int]$ChecksFailed = -1,

  [int]$ChecksSkipped = -1,

  [string]$Note = ''
)

$ErrorActionPreference = 'Stop'
# The runner's own JSON must be UTF-8 regardless of the system code page. This
# only changes this process; it does not touch the user or machine code page.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$schema = 'dsh-orb-evidence/v2'
$summaryLimit = 65536
$stringLimit = 4096
$noteLimit = 4096
$maxCommandBytes = 131072
$truncationExitCode = 74
$timeoutExitCode = 124
$internalExitCode = 2

$typeDefinition = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace DshOrbEvidence
{
    public sealed class RunResult
    {
        public int ExitCode;
        public bool TimedOut;
        public bool Drained;
        public bool TreeAssigned;
        public long StdoutBytes;
        public long StderrBytes;
        public long StdoutWritten;
        public long StderrWritten;
        public long StdoutDropped;
        public long StderrDropped;
        public bool StdoutTruncated;
        public bool StderrTruncated;
    }

    public static class Runner
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;

        private sealed class PumpState
        {
            public long Written;
            public long Total;
            public bool Truncated;
            public long Dropped;
        }

        public static RunResult Run(
            string fileName,
            string arguments,
            string workingDirectory,
            string stdoutPath,
            string stderrPath,
            int timeoutMs,
            long maxBytes)
        {
            var result = new RunResult();
            var startInfo = new ProcessStartInfo(fileName, arguments);
            startInfo.WorkingDirectory = workingDirectory;
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.RedirectStandardOutput = true;
            startInfo.RedirectStandardError = true;

            IntPtr job = IntPtr.Zero;
            try
            {
                job = CreateJobObject(IntPtr.Zero, null);
                if (job != IntPtr.Zero)
                {
                    var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                    information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
                    SetInformationJobObject(
                        job,
                        JobObjectExtendedLimitInformation,
                        ref information,
                        (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
                }

                using (var process = new Process())
                using (var stdout = new FileStream(stdoutPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
                using (var stderr = new FileStream(stderrPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
                {
                    process.StartInfo = startInfo;
                    var outState = new PumpState();
                    var errState = new PumpState();
                    process.Start();
                    if (job != IntPtr.Zero)
                    {
                        result.TreeAssigned = AssignProcessToJobObject(job, process.Handle);
                    }

                    var outThread = new Thread(delegate() { Pump(process.StandardOutput.BaseStream, stdout, maxBytes, outState); });
                    var errThread = new Thread(delegate() { Pump(process.StandardError.BaseStream, stderr, maxBytes, errState); });
                    outThread.IsBackground = true;
                    errThread.IsBackground = true;
                    outThread.Start();
                    errThread.Start();

                    result.TimedOut = !process.WaitForExit(timeoutMs);
                    if (result.TimedOut)
                    {
                        // Kill the observed tree first so a descendant that raced
                        // the job assignment is still covered. The job termination
                        // then covers anything else created after assignment.
                        KillTreeByPid(process.Id);
                        if (job != IntPtr.Zero && result.TreeAssigned)
                        {
                            TerminateJobObject(job, 124);
                        }
                        try { process.WaitForExit(10000); } catch { }
                        if (!process.HasExited)
                        {
                            try { process.Kill(); } catch { }
                        }
                    }
                    process.WaitForExit();

                    // Closing the job closes every descendant that still holds the
                    // stdout/stderr handles, which lets the pump threads reach EOF.
                    if (job != IntPtr.Zero)
                    {
                        CloseHandle(job);
                        job = IntPtr.Zero;
                    }
                    var outJoined = outThread.Join(15000);
                    var errJoined = errThread.Join(15000);
                    result.Drained = outJoined && errJoined;

                    result.ExitCode = result.TimedOut ? 124 : process.ExitCode;
                    result.StdoutBytes = outState.Total;
                    result.StderrBytes = errState.Total;
                    result.StdoutWritten = outState.Written;
                    result.StderrWritten = errState.Written;
                    result.StdoutDropped = outState.Dropped;
                    result.StderrDropped = errState.Dropped;
                    result.StdoutTruncated = outState.Truncated;
                    result.StderrTruncated = errState.Truncated;
                }
            }
            finally
            {
                if (job != IntPtr.Zero) CloseHandle(job);
            }
            return result;
        }

        private static void KillTreeByPid(int pid)
        {
            try
            {
                var startInfo = new ProcessStartInfo("taskkill.exe", "/PID " + pid.ToString() + " /T /F");
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                startInfo.RedirectStandardOutput = true;
                startInfo.RedirectStandardError = true;
                using (var killer = Process.Start(startInfo))
                {
                    if (killer != null)
                    {
                        killer.StandardOutput.ReadToEnd();
                        killer.StandardError.ReadToEnd();
                        killer.WaitForExit(10000);
                    }
                }
            }
            catch
            {
                // Best effort. The summary still reports that the tree was not owned.
            }
        }

        private static void Pump(Stream input, Stream output, long maxBytes, PumpState state)
        {
            var buffer = new byte[16384];
            long written = 0;
            try
            {
                int read;
                while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    state.Total += read;
                    if (written < maxBytes)
                    {
                        int take = (int)Math.Min((long)read, maxBytes - written);
                        output.Write(buffer, 0, take);
                        written += take;
                    }
                }
            }
            finally
            {
                try { output.Flush(); } catch { }
                state.Written = written;
                state.Truncated = state.Total > written;
                state.Dropped = state.Total - written;
            }
        }

        public static string Sha256(string path)
        {
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var hash = SHA256.Create())
            {
                return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            }
        }
    }
}
'@

function Clip-Text([string]$value, [int]$limit) {
  if ($null -eq $value) { return '' }
  if ($value.Length -le $limit) { return $value }
  return $value.Substring(0, $limit - 1) + [char]0x2026
}

function Command-Source([string]$name) {
  $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $command) { return 'not-on-path' }
  return [string]$command.Source
}

function Quote-WindowsArgument([string]$value) {
  if ($null -eq $value) { return '""' }
  if ($value.Length -eq 0) { return '""' }
  if ($value -notmatch '[\s"]') { return $value }
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $value.ToCharArray()) {
    if ($character -eq [char]'\') {
      $backslashes += 1
      continue
    }
    if ($character -eq [char]'"') {
      [void]$builder.Append(('\' * (2 * $backslashes + 1)))
      [void]$builder.Append('"')
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) {
      [void]$builder.Append(('\' * $backslashes))
      $backslashes = 0
    }
    [void]$builder.Append($character)
  }
  if ($backslashes -gt 0) { [void]$builder.Append(('\' * (2 * $backslashes))) }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Quote-CmdArgument([string]$value) {
  if ($null -eq $value -or $value.Length -eq 0) { return '""' }
  if ($value -notmatch '[\s"&|<>^]') { return $value }
  return '"' + $value.Replace('"', '\"') + '"'
}

function Assert-CmdShimArguments([string]$program, [string[]]$arguments) {
  if ($program -match '[%!"^&|<>()\r\n]') {
    throw "native-cmd-shim program path contains unsupported CMD metacharacters: $program"
  }
  for ($index = 0; $index -lt $arguments.Count; $index += 1) {
    $argument = $arguments[$index]
    if ($null -eq $argument -or $argument.Length -eq 0) {
      throw "native-cmd-shim rejects empty argument at index $index; use a direct .exe entry"
    }
    if ($argument -match '[^\x20-\x7E]') {
      throw "native-cmd-shim rejects non-ASCII argument at index $index; use a direct .exe entry"
    }
    if ($argument -match '[%!"^&|<>()\r\n]') {
      throw "native-cmd-shim rejects CMD metacharacter argument at index $index; use a direct .exe entry"
    }
  }
}

function Resolve-NativeProgram([string]$program) {
  if (Test-Path -LiteralPath $program -PathType Leaf) {
    return [System.IO.Path]::GetFullPath($program)
  }
  $command = Get-Command $program -ErrorAction Stop | Select-Object -First 1
  if ($null -eq $command -or [string]::IsNullOrWhiteSpace([string]$command.Source)) {
    throw "native program not found: $program"
  }
  return [System.IO.Path]::GetFullPath([string]$command.Source)
}

function Test-StrictDecode([byte[]]$bytes, [System.Text.Encoding]$encoding, [int]$trim) {
  if ($bytes.Length -le $trim) { return $true }
  try {
    $decoder = $encoding.GetDecoder()
    $chars = New-Object char[] ($encoding.GetMaxCharCount($bytes.Length))
    [void]$decoder.GetChars($bytes, 0, $bytes.Length - $trim, $chars, 0, $true)
    return $true
  } catch {
    return $false
  }
}

function Test-Utf8Continuation([byte]$lead, [int]$index, [byte]$value) {
  if ($index -eq 1) {
    if ($lead -eq 0xE0) { return $value -ge 0xA0 -and $value -le 0xBF }
    if ($lead -eq 0xED) { return $value -ge 0x80 -and $value -le 0x9F }
    if ($lead -eq 0xF0) { return $value -ge 0x90 -and $value -le 0xBF }
    if ($lead -eq 0xF4) { return $value -ge 0x80 -and $value -le 0x8F }
  }
  return $value -ge 0x80 -and $value -le 0xBF
}

function Get-Utf8IncompleteTail([byte[]]$bytes) {
  $continuations = 0
  for ($index = $bytes.Length - 1; $index -ge 0 -and $continuations -lt 3; $index -= 1) {
    if ($bytes[$index] -ge 0x80 -and $bytes[$index] -le 0xBF) {
      $continuations += 1
      continue
    }
    break
  }
  $leadIndex = $bytes.Length - $continuations - 1
  if ($leadIndex -lt 0) { return 0 }
  $lead = $bytes[$leadIndex]
  $expected = if ($lead -ge 0xC2 -and $lead -le 0xDF) { 1 } elseif ($lead -ge 0xE0 -and $lead -le 0xEF) { 2 } elseif ($lead -ge 0xF0 -and $lead -le 0xF4) { 3 } else { 0 }
  if ($expected -eq 0 -or $continuations -ge $expected) { return 0 }
  for ($index = 1; $index -le $continuations; $index += 1) {
    if (-not (Test-Utf8Continuation $lead $index $bytes[$leadIndex + $index])) { return 0 }
  }
  return $continuations + 1
}

function Get-Gb18030IncompleteTail([byte[]]$bytes) {
  if ($bytes.Length -eq 0) { return 0 }
  $last = $bytes[$bytes.Length - 1]
  return [int]$(if ($last -ge 0x81 -and $last -le 0xFE) { 1 } else { 0 })
}

function Get-Utf16CodeUnit([byte[]]$bytes, [string]$name, [int]$offset) {
  if ($offset + 1 -ge $bytes.Length) { return -1 }
  if ($name -eq 'utf-16le') { return [int]$bytes[$offset] -bor ([int]$bytes[$offset + 1] -shl 8) }
  if ($name -eq 'utf-16be') { return [int]$bytes[$offset + 1] -bor ([int]$bytes[$offset] -shl 8) }
  return -1
}

function Test-Utf16HighSurrogateLast([byte[]]$bytes, [string]$name) {
  if ($bytes.Length -lt 2 -or ($bytes.Length % 2) -ne 0) { return $false }
  $unit = Get-Utf16CodeUnit $bytes $name ($bytes.Length - 2)
  return $unit -ge 0xD800 -and $unit -le 0xDBFF
}

function Test-Utf16HighSurrogateBeforeExtra([byte[]]$bytes, [string]$name) {
  if ($bytes.Length -lt 3 -or ($bytes.Length % 2) -ne 1) { return $false }
  $unit = Get-Utf16CodeUnit $bytes $name ($bytes.Length - 3)
  return $unit -ge 0xD800 -and $unit -le 0xDBFF
}

function Test-BomBody([byte[]]$bytes, [int]$offset, [System.Text.Encoding]$encoding, [string]$name, [bool]$allowTrim) {
  if ($bytes.Length -le $offset) { return $true }
  $body = [byte[]]::new([int]($bytes.Length - $offset))
  [Array]::Copy($bytes, $offset, $body, 0, $body.Length)
  if (Test-StrictDecode $body $encoding 0) { return $true }
  if (-not $allowTrim) { return $false }
  if ($name -eq 'utf-8') {
    $adjust = Get-Utf8IncompleteTail $body
    return $adjust -gt 0 -and (Test-StrictDecode $body $encoding $adjust)
  }
  if ($name -eq 'utf-16le' -or $name -eq 'utf-16be') {
    if (($body.Length % 2) -eq 1) {
      if (Test-Utf16HighSurrogateBeforeExtra $body $name) { return Test-StrictDecode $body $encoding 3 }
      return Test-StrictDecode $body $encoding 1
    }
    if (Test-Utf16HighSurrogateLast $body $name) { return Test-StrictDecode $body $encoding 2 }
  }
  return $false
}

function Detect-LogEncoding([string]$path) {
  $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  try {
    $fileLength = $stream.Length
    $sampleSize = [int][Math]::Min([long]65536, $fileLength)
    $sample = New-Object byte[] $sampleSize
    if ($sampleSize -gt 0) { [void]$stream.Read($sample, 0, $sampleSize) }
  } finally {
    $stream.Dispose()
  }
  $sampleScope = if ($fileLength -le $sampleSize) { 'whole' } else { 'sample-prefix' }
  $allowTrim = $sampleScope -eq 'sample-prefix'
  if ($sample.Length -ge 3 -and $sample[0] -eq 0xEF -and $sample[1] -eq 0xBB -and $sample[2] -eq 0xBF) {
    $valid = Test-BomBody $sample 3 (New-Object System.Text.UTF8Encoding($false, $true)) 'utf-8' $allowTrim
    return [ordered]@{ name = 'utf-8'; source = 'detected-bom'; valid = $valid; sample_bytes = $sampleSize; verified = $sampleScope }
  }
  if ($sample.Length -ge 2 -and $sample[0] -eq 0xFF -and $sample[1] -eq 0xFE) {
    $valid = Test-BomBody $sample 2 (New-Object System.Text.UnicodeEncoding($false, $false, $true)) 'utf-16le' $allowTrim
    return [ordered]@{ name = 'utf-16le'; source = 'detected-bom'; valid = $valid; sample_bytes = $sampleSize; verified = $sampleScope }
  }
  if ($sample.Length -ge 2 -and $sample[0] -eq 0xFE -and $sample[1] -eq 0xFF) {
    $valid = Test-BomBody $sample 2 (New-Object System.Text.UnicodeEncoding($true, $false, $true)) 'utf-16be' $allowTrim
    return [ordered]@{ name = 'utf-16be'; source = 'detected-bom'; valid = $valid; sample_bytes = $sampleSize; verified = $sampleScope }
  }
  if ($sample.Length -eq 0) { return [ordered]@{ name = 'utf-8'; source = 'empty'; valid = $true; sample_bytes = 0; verified = 'whole' } }
  $nulCount = 0
  foreach ($byte in $sample) { if ($byte -eq 0) { $nulCount += 1 } }
  if ($nulCount -gt ($sample.Length / 3)) {
    return [ordered]@{ name = 'utf-16le'; source = 'detected-nul'; valid = $true; sample_bytes = $sampleSize; verified = $sampleScope }
  }
  $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
  $utf8Valid = Test-StrictDecode $sample $utf8 0
  if (-not $utf8Valid -and $sampleScope -eq 'sample-prefix') {
    $utf8Adjust = Get-Utf8IncompleteTail $sample
    $utf8Valid = $utf8Adjust -gt 0 -and (Test-StrictDecode $sample $utf8 $utf8Adjust)
  }
  if ($utf8Valid) {
    return [ordered]@{ name = 'utf-8'; source = 'detected'; valid = $true; sample_bytes = $sampleSize; verified = $sampleScope }
  }
  $gb = [System.Text.Encoding]::GetEncoding(54936, [System.Text.EncoderFallback]::ExceptionFallback, [System.Text.DecoderFallback]::ExceptionFallback)
  $gbValid = Test-StrictDecode $sample $gb 0
  if (-not $gbValid -and $sampleScope -eq 'sample-prefix') {
    $gbAdjust = Get-Gb18030IncompleteTail $sample
    $gbValid = $gbAdjust -gt 0 -and (Test-StrictDecode $sample $gb $gbAdjust)
  }
  if ($gbValid) {
    return [ordered]@{ name = 'gb18030'; source = 'detected'; valid = $true; sample_bytes = $sampleSize; verified = $sampleScope }
  }
  return [ordered]@{ name = 'unknown'; source = 'detected'; valid = $false; sample_bytes = $sampleSize; verified = $sampleScope }
}

function Wait-StableFile([string]$path) {
  $previous = -1
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    $length = (Get-Item -LiteralPath $path).Length
    if ($length -eq $previous) { return }
    $previous = $length
    Start-Sleep -Milliseconds 100
  }
  throw "log did not stop growing: $path"
}

function Write-Summary([string]$path, $summary) {
  $json = $summary | ConvertTo-Json -Depth 6
  $bytes = $utf8NoBom.GetBytes($json)
  if ($bytes.Length -gt $summaryLimit) {
    throw "summary would be $($bytes.Length) bytes, above the $summaryLimit-byte limit"
  }
  $temporary = $path + '.tmp'
  [System.IO.File]::WriteAllBytes($temporary, $bytes)
  [System.IO.File]::Move($temporary, $path)
  return $bytes.Length
}

if (-not [string]::IsNullOrWhiteSpace($NativeProgramEnv)) {
  $NativeProgram = [System.Environment]::GetEnvironmentVariable($NativeProgramEnv, 'Process')
  if ([string]::IsNullOrWhiteSpace($NativeProgram)) {
    [Console]::Error.WriteLine("evidence: native program environment variable is empty: $NativeProgramEnv")
    exit $internalExitCode
  }
}
if (-not [string]::IsNullOrWhiteSpace($EvidenceRootEnv)) {
  $EvidenceRoot = [System.Environment]::GetEnvironmentVariable($EvidenceRootEnv, 'Process')
  if ([string]::IsNullOrWhiteSpace($EvidenceRoot)) {
    [Console]::Error.WriteLine("evidence: evidence root environment variable is empty: $EvidenceRootEnv")
    exit $internalExitCode
  }
}
if (-not [string]::IsNullOrWhiteSpace($NoteEnv)) {
  $Note = [System.Environment]::GetEnvironmentVariable($NoteEnv, 'Process')
}

$hasScript = -not [string]::IsNullOrWhiteSpace($CommandText) -or -not [string]::IsNullOrWhiteSpace($CommandEnv)
$hasNative = -not [string]::IsNullOrWhiteSpace($NativeProgram)
if (-not [string]::IsNullOrWhiteSpace($NativeArgsEnv)) {
  if ($NativeArguments.Count -gt 0) {
    [Console]::Error.WriteLine('evidence: use -NativeArgsEnv or -NativeArguments, not both')
    exit $internalExitCode
  }
  $rawNativeArguments = [System.Environment]::GetEnvironmentVariable($NativeArgsEnv, 'Process')
  if ([string]::IsNullOrWhiteSpace($rawNativeArguments)) {
    [Console]::Error.WriteLine("evidence: native argument environment variable is empty: $NativeArgsEnv")
    exit $internalExitCode
  }
  try {
    $parsedArguments = ConvertFrom-Json $rawNativeArguments
  } catch {
    [Console]::Error.WriteLine("evidence: native argument environment variable is not valid JSON: $NativeArgsEnv")
    exit $internalExitCode
  }
  if ($parsedArguments -is [string]) {
    $NativeArguments = @([string]$parsedArguments)
  } elseif ($parsedArguments -is [System.Array]) {
    $NativeArguments = @($parsedArguments | ForEach-Object { [string]$_ })
  } else {
    [Console]::Error.WriteLine("evidence: native argument environment variable must be a JSON string or array: $NativeArgsEnv")
    exit $internalExitCode
  }
}
if ($hasScript -and $hasNative) {
  [Console]::Error.WriteLine('evidence: choose PowerShell script mode or native mode, not both')
  exit $internalExitCode
}
if (-not $hasScript -and -not $hasNative) {
  [Console]::Error.WriteLine('evidence: pass -NativeProgram, -CommandText, or -CommandEnv')
  exit $internalExitCode
}

$commandSource = 'argument'
$scriptText = ''
if ($hasScript) {
  if (-not [string]::IsNullOrWhiteSpace($CommandEnv)) {
    $CommandText = [System.Environment]::GetEnvironmentVariable($CommandEnv, 'Process')
    $commandSource = "environment:$CommandEnv"
  }
  if ([string]::IsNullOrWhiteSpace($CommandText)) {
    [Console]::Error.WriteLine('evidence: the selected command environment variable is empty')
    exit $internalExitCode
  }
  $commandBytes = $utf8NoBom.GetByteCount($CommandText)
  if ($commandBytes -gt $maxCommandBytes) {
    [Console]::Error.WriteLine("evidence: command text is $commandBytes bytes, above the $maxCommandBytes-byte limit")
    exit $internalExitCode
  }
  $encodingPrefix = @'
$__dshUtf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $__dshUtf8
$OutputEncoding = $__dshUtf8
'@
  $scriptText = $encodingPrefix + "`r`n" + $CommandText
} else {
  $commandBytes = $utf8NoBom.GetByteCount(($NativeArguments -join "`n"))
  if ($commandBytes -gt $maxCommandBytes) {
    [Console]::Error.WriteLine("evidence: native arguments are $commandBytes bytes, above the $maxCommandBytes-byte limit")
    exit $internalExitCode
  }
}

$root = $EvidenceRoot
if ([string]::IsNullOrWhiteSpace($root)) {
  if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
    $root = Join-Path $env:DSH_HOME 'dsh-orb-evidence'
  } else {
    $root = Join-Path $env:USERPROFILE '.dsh\dsh-orb-evidence'
  }
}
$root = [System.IO.Path]::GetFullPath($root)

$runDirectory = $null
$startedAt = Get-Date
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
try {
  if (-not (Test-Path -LiteralPath $root)) {
    New-Item -ItemType Directory -Path $root -Force | Out-Null
  }
  $stamp = $startedAt.ToString('yyyyMMdd-HHmmss')
  $baseName = "$stamp-$TaskId-$Phase"
  $runDirectory = Join-Path $root $baseName
  $suffix = 1
  while (Test-Path -LiteralPath $runDirectory) {
    $runDirectory = Join-Path $root ("$baseName-$suffix")
    $suffix += 1
  }
  New-Item -ItemType Directory -Path $runDirectory -ErrorAction Stop | Out-Null

  $commandPath = Join-Path $runDirectory 'command.ps1'
  $commandTextPath = Join-Path $runDirectory 'command.txt'
  $stdoutPath = Join-Path $runDirectory 'stdout.log'
  $stderrPath = Join-Path $runDirectory 'stderr.log'
  $summaryPath = Join-Path $runDirectory 'summary.json'

  $mode = 'powershell-script'
  $fileName = $null
  $arguments = $null
  $displayArguments = @()
  if ($hasScript) {
    [System.IO.File]::WriteAllText($commandPath, $scriptText, (New-Object System.Text.UTF8Encoding($true)))
    [System.IO.File]::WriteAllText($commandTextPath, $CommandText, $utf8NoBom)
    $fileName = Join-Path $PSHOME 'powershell.exe'
    $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $commandPath + '"'
    $displayArguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $commandPath)
  } else {
    $resolved = Resolve-NativeProgram $NativeProgram
    [System.IO.File]::WriteAllText($commandTextPath, (($NativeProgram + ' ' + ($NativeArguments -join ' ')).Trim()), $utf8NoBom)
    $extension = [System.IO.Path]::GetExtension($resolved).ToLowerInvariant()
    if ($extension -eq '.cmd' -or $extension -eq '.bat') {
      if (-not $AllowCmdShim) {
        throw 'native-cmd-shim is disabled because CMD cannot preserve arbitrary JSON arguments; use a direct .exe entry (for pnpm: node.exe + pnpm.cjs) or pass -AllowCmdShim with safe ASCII arguments'
      }
      Assert-CmdShimArguments $resolved @($NativeArguments)
      $mode = 'native-cmd-shim'
      $fileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
      $quoted = @((Quote-CmdArgument $resolved))
      foreach ($argument in $NativeArguments) { $quoted += (Quote-CmdArgument $argument) }
      $arguments = '/d /s /c "' + ($quoted -join ' ') + '"'
      $displayArguments = @('/d', '/s', '/c', $resolved) + $NativeArguments
    } else {
      $mode = 'native-program'
      $fileName = $resolved
      $quoted = @()
      foreach ($argument in $NativeArguments) { $quoted += (Quote-WindowsArgument $argument) }
      $arguments = $quoted -join ' '
      $displayArguments = @($resolved) + $NativeArguments
    }
  }

  if (-not ('DshOrbEvidence.Runner' -as [type])) {
    Add-Type -TypeDefinition $typeDefinition -Language CSharp
  }

  $result = [DshOrbEvidence.Runner]::Run(
    $fileName,
    $arguments,
    (Get-Location).Path,
    $stdoutPath,
    $stderrPath,
    ($TimeoutSeconds * 1000),
    [long]$MaxLogBytes
  )
  if (-not $result.Drained) {
    throw 'child output did not drain after the command ended; evidence is not final'
  }
  Wait-StableFile $stdoutPath
  Wait-StableFile $stderrPath
  $stopwatch.Stop()
  $finishedAt = Get-Date

  $stdoutInfo = Detect-LogEncoding $stdoutPath
  $stderrInfo = Detect-LogEncoding $stderrPath
  $stdoutHash = [DshOrbEvidence.Runner]::Sha256($stdoutPath)
  $stderrHash = [DshOrbEvidence.Runner]::Sha256($stderrPath)
  $truncated = $result.StdoutTruncated -or $result.StderrTruncated
  $commandStatus = if ($result.TimedOut) { 'timed_out' } elseif ($result.ExitCode -eq 0) { 'exited_zero' } else { 'exited_nonzero' }
  $evidenceStatus = if ($result.TimedOut) { 'timed_out' } elseif ($truncated) { 'truncated' } else { 'complete' }
  $status = if ($result.TimedOut) { 'timed_out' } elseif ($truncated) {
    if ($result.ExitCode -eq 0) { 'exited_zero_evidence_truncated' } else { 'exited_nonzero_evidence_truncated' }
  } else { $commandStatus }
  $shellExitCode = if ($hasScript) { [int]$result.ExitCode } else { $null }
  $toolExitCode = if ($result.TimedOut) { $timeoutExitCode } elseif ($result.ExitCode -lt 0) { 1 } elseif ($truncated -and $result.ExitCode -eq 0) { $truncationExitCode } else { [int]$result.ExitCode }

  $counts = [ordered]@{}
  if ($ChecksPassed -ge 0) { $counts['passed'] = $ChecksPassed }
  if ($ChecksFailed -ge 0) { $counts['failed'] = $ChecksFailed }
  if ($ChecksSkipped -ge 0) { $counts['skipped'] = $ChecksSkipped }
  if ($counts.Count -gt 0) {
    $total = 0
    foreach ($value in $counts.Values) { $total += [int]$value }
    $counts['total'] = $total
  }

  $warnings = New-Object System.Collections.Generic.List[string]
  if ($result.TimedOut) { $warnings.Add("timed out after $TimeoutSeconds seconds") }
  if (-not $result.TreeAssigned) { $warnings.Add('the child process could not be assigned to the runner job; timeout cleanup may not cover descendants') }
  if ($result.StdoutTruncated) { $warnings.Add("stdout exceeded $MaxLogBytes bytes; the log keeps the prefix and reports dropped bytes") }
  if ($result.StderrTruncated) { $warnings.Add("stderr exceeded $MaxLogBytes bytes; the log keeps the prefix and reports dropped bytes") }
  if ($hasScript) { $warnings.Add('PowerShell script mode reports the PowerShell process exit code; use native mode for reliable native command exit codes') }
  if (-not $stdoutInfo.valid) { $warnings.Add('stdout encoding could not be verified; raw bytes are retained') }
  if (-not $stderrInfo.valid) { $warnings.Add('stderr encoding could not be verified; raw bytes are retained') }
  $warningItems = @($warnings | Select-Object -First 32)
  if ($warnings.Count -gt 32) { $warningItems += "additional warnings omitted" }

  $summary = [ordered]@{
    schema = $schema
    task_id = Clip-Text $TaskId 128
    phase = Clip-Text $Phase 128
    status = $status
    command_status = $commandStatus
    evidence_status = $evidenceStatus
    evidence_complete = ($evidenceStatus -eq 'complete')
    exit_code = [int]$result.ExitCode
    command_exit_code = [int]$result.ExitCode
    shell_exit_code = $shellExitCode
    tool_exit_code = [int]$toolExitCode
    started_at = $startedAt.ToString('o')
    finished_at = $finishedAt.ToString('o')
    duration_ms = [long]$stopwatch.ElapsedMilliseconds
    command = [ordered]@{
      mode = $mode
      exit_code_scope = if ($hasScript) { 'powershell-script' } else { 'native-program' }
      file = Clip-Text $fileName $stringLimit
      arguments = @($displayArguments | ForEach-Object { Clip-Text ([string]$_) $stringLimit })
      source = Clip-Text $commandSource $stringLimit
      script = if ($hasScript) { 'command.ps1' } else { $null }
      script_bytes = if ($hasScript) { [int]$utf8NoBom.GetByteCount($scriptText) } else { 0 }
      command_bytes = [int]$commandBytes
      working_directory = Clip-Text (Get-Location).Path $stringLimit
    }
    environment = [ordered]@{
      powershell_version = Clip-Text $PSVersionTable.PSVersion.ToString() 128
      powershell_edition = Clip-Text ([string]$PSVersionTable.PSEdition) 64
      pshome = Clip-Text $PSHOME $stringLimit
      os = Clip-Text ([System.Environment]::OSVersion.VersionString) 256
      architecture = Clip-Text ([string]$env:PROCESSOR_ARCHITECTURE) 64
      cwd = Clip-Text (Get-Location).Path $stringLimit
      encoding_policy = 'runner JSON is utf-8; stdout/stderr are raw bytes with per-stream detected encoding'
      log_encoding = 'detected per stream: utf-8, gb18030, utf-16le, utf-16be, or unknown'
      node = Clip-Text (Command-Source 'node') $stringLimit
      pnpm = Clip-Text (Command-Source 'pnpm') $stringLimit
    }
    counts = $counts
    claims = [ordered]@{
      command = $commandStatus
      evidence = $evidenceStatus
      tests = if ($counts.Count -gt 0) { 'counts-recorded-not-independently-verified' } else { 'not-recorded' }
      deployment = 'not-recorded'
      production = 'not-recorded'
    }
    logs = @(
      [ordered]@{
        stream = 'stdout'
        path = Clip-Text $stdoutPath $stringLimit
        bytes = [long]$result.StdoutBytes
        written_bytes = [long]$result.StdoutWritten
        dropped_bytes = [long]$result.StdoutDropped
        truncated = [bool]$result.StdoutTruncated
        complete = -not [bool]$result.StdoutTruncated
        encoding = $stdoutInfo.name
        encoding_source = $stdoutInfo.source
        encoding_valid = [bool]$stdoutInfo.valid
        encoding_verified = $stdoutInfo.verified
        encoding_sample_bytes = [int]$stdoutInfo.sample_bytes
        sha256 = $stdoutHash
        limit_bytes = [long]$MaxLogBytes
      },
      [ordered]@{
        stream = 'stderr'
        path = Clip-Text $stderrPath $stringLimit
        bytes = [long]$result.StderrBytes
        written_bytes = [long]$result.StderrWritten
        dropped_bytes = [long]$result.StderrDropped
        truncated = [bool]$result.StderrTruncated
        complete = -not [bool]$result.StderrTruncated
        encoding = $stderrInfo.name
        encoding_source = $stderrInfo.source
        encoding_valid = [bool]$stderrInfo.valid
        encoding_verified = $stderrInfo.verified
        encoding_sample_bytes = [int]$stderrInfo.sample_bytes
        sha256 = $stderrHash
        limit_bytes = [long]$MaxLogBytes
      }
    )
    evidence = @(
      (Clip-Text $commandTextPath $stringLimit),
      (Clip-Text $stdoutPath $stringLimit),
      (Clip-Text $stderrPath $stringLimit)
    )
    note = Clip-Text $Note $noteLimit
    warnings = @($warningItems)
    limits = [ordered]@{
      max_log_bytes = [long]$MaxLogBytes
      max_summary_bytes = $summaryLimit
      max_string_chars = $stringLimit
      max_command_bytes = $maxCommandBytes
      max_array_items = 32
      json_depth = 6
    }
  }
  if ($hasScript) { $summary.evidence = @((Clip-Text $commandPath $stringLimit)) + $summary.evidence }

  $summaryBytes = Write-Summary $summaryPath $summary
  $return = [ordered]@{
    summary_path = $summaryPath
    summary_bytes = [int]$summaryBytes
    run_directory = $runDirectory
    status = $status
    command_status = $commandStatus
    evidence_status = $evidenceStatus
    evidence_complete = ($evidenceStatus -eq 'complete')
    exit_code = [int]$result.ExitCode
    command_exit_code = [int]$result.ExitCode
    shell_exit_code = $shellExitCode
    tool_exit_code = [int]$toolExitCode
    stdout = [ordered]@{ path = $stdoutPath; bytes = [long]$result.StdoutBytes; written_bytes = [long]$result.StdoutWritten; truncated = [bool]$result.StdoutTruncated; encoding = $stdoutInfo.name }
    stderr = [ordered]@{ path = $stderrPath; bytes = [long]$result.StderrBytes; written_bytes = [long]$result.StderrWritten; truncated = [bool]$result.StderrTruncated; encoding = $stderrInfo.name }
  }
  $return | ConvertTo-Json -Depth 4 -Compress
  exit $toolExitCode
}
catch {
  $stopwatch.Stop()
  $message = Clip-Text ([string]$_.Exception.Message) $stringLimit
  [Console]::Error.WriteLine("evidence: $message")
  if ($null -ne $runDirectory -and (Test-Path -LiteralPath $runDirectory)) {
    [Console]::Error.WriteLine("evidence: retained directory $runDirectory")
  }
  exit $internalExitCode
}
