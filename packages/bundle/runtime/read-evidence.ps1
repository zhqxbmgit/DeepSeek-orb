#requires -Version 5.1
<#
.SYNOPSIS
Read a bounded evidence summary or log preview with explicit text decoding.

.DESCRIPTION
Checks the file size before reading. A summary is capped at 64 KiB. A log is
never returned whole: only a requested head and tail plus its size and SHA-256.
The log's encoding is detected from its bytes (or supplied with -Encoding) and
the result states that encoding; unknown bytes are returned as a hex preview
instead of being mislabeled UTF-8.

Use -SummaryEnv/-LogEnv when the path or a note contains non-ASCII characters:
PowerShell 5.1 can mangle non-ASCII arguments passed through powershell.exe
-File, while environment values are inherited exactly.
#>
[CmdletBinding(DefaultParameterSetName = 'Summary')]
param(
  [Parameter(Mandatory = $true, ParameterSetName = 'Summary')]
  [string]$Summary,

  [Parameter(Mandatory = $true, ParameterSetName = 'SummaryEnv')]
  [ValidatePattern('^[A-Za-z_][A-Za-z0-9_]{0,63}$')]
  [string]$SummaryEnv,

  [Parameter(Mandatory = $true, ParameterSetName = 'Log')]
  [string]$Log,

  [Parameter(Mandatory = $true, ParameterSetName = 'LogEnv')]
  [ValidatePattern('^[A-Za-z_][A-Za-z0-9_]{0,63}$')]
  [string]$LogEnv,

  [ValidateSet('auto', 'utf-8', 'gb18030', 'utf-16le', 'utf-16be')]
  [string]$Encoding = 'auto',

  [ValidateRange(1024, 65536)]
  [int]$MaxSummaryBytes = 65536,

  [ValidateRange(0, 32768)]
  [int]$HeadBytes = 8192,

  [ValidateRange(0, 16384)]
  [int]$TailBytes = 2048
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

function Get-EncodingObject([string]$name) {
  switch ($name) {
    'utf-8' { return New-Object System.Text.UTF8Encoding($false, $true) }
    'gb18030' { return [System.Text.Encoding]::GetEncoding(54936, [System.Text.EncoderFallback]::ExceptionFallback, [System.Text.DecoderFallback]::ExceptionFallback) }
    'utf-16le' { return New-Object System.Text.UnicodeEncoding($false, $false, $true) }
    'utf-16be' { return New-Object System.Text.UnicodeEncoding($true, $false, $true) }
    default { return $null }
  }
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

function Test-Utf16LowSurrogateFirst([byte[]]$bytes, [string]$name) {
  if ($bytes.Length -lt 2) { return $false }
  $unit = Get-Utf16CodeUnit $bytes $name 0
  return $unit -ge 0xDC00 -and $unit -le 0xDFFF
}

function Test-Utf16HighSurrogateLastBefore([byte[]]$before, [string]$name) {
  if ($before.Length -lt 2) { return $false }
  $unit = Get-Utf16CodeUnit $before $name ($before.Length - 2)
  return $unit -ge 0xD800 -and $unit -le 0xDBFF
}

function Test-BodyDecode([byte[]]$bytes, [int]$offset, [System.Text.Encoding]$encoding, [string]$name, [bool]$allowTrim) {
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

function Detect-Encoding([string]$path) {
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
    $valid = Test-BodyDecode $sample 3 (Get-EncodingObject 'utf-8') 'utf-8' $allowTrim
    return [ordered]@{ name = 'utf-8'; source = 'detected-bom'; valid = $valid; bom = 3; sample_bytes = $sampleSize; verified = $sampleScope }
  }
  if ($sample.Length -ge 2 -and $sample[0] -eq 0xFF -and $sample[1] -eq 0xFE) {
    $valid = Test-BodyDecode $sample 2 (Get-EncodingObject 'utf-16le') 'utf-16le' $allowTrim
    return [ordered]@{ name = 'utf-16le'; source = 'detected-bom'; valid = $valid; bom = 2; sample_bytes = $sampleSize; verified = $sampleScope }
  }
  if ($sample.Length -ge 2 -and $sample[0] -eq 0xFE -and $sample[1] -eq 0xFF) {
    $valid = Test-BodyDecode $sample 2 (Get-EncodingObject 'utf-16be') 'utf-16be' $allowTrim
    return [ordered]@{ name = 'utf-16be'; source = 'detected-bom'; valid = $valid; bom = 2; sample_bytes = $sampleSize; verified = $sampleScope }
  }
  if ($sample.Length -eq 0) {
    return [ordered]@{ name = 'utf-8'; source = 'empty'; valid = $true; bom = 0; sample_bytes = 0; verified = 'whole' }
  }
  $nulCount = 0
  foreach ($byte in $sample) { if ($byte -eq 0) { $nulCount += 1 } }
  if ($nulCount -gt ($sample.Length / 3)) {
    return [ordered]@{ name = 'utf-16le'; source = 'detected-nul'; valid = $true; bom = 0; sample_bytes = $sampleSize; verified = $sampleScope }
  }
  $utf8 = Get-EncodingObject 'utf-8'
  $utf8Valid = Test-StrictDecode $sample $utf8 0
  if (-not $utf8Valid -and $sampleScope -eq 'sample-prefix') {
    $utf8Adjust = Get-Utf8IncompleteTail $sample
    $utf8Valid = $utf8Adjust -gt 0 -and (Test-StrictDecode $sample $utf8 $utf8Adjust)
  }
  if ($utf8Valid) {
    return [ordered]@{ name = 'utf-8'; source = 'detected'; valid = $true; bom = 0; sample_bytes = $sampleSize; verified = $sampleScope }
  }
  $gb = Get-EncodingObject 'gb18030'
  $gbValid = Test-StrictDecode $sample $gb 0
  if (-not $gbValid -and $sampleScope -eq 'sample-prefix') {
    $gbAdjust = Get-Gb18030IncompleteTail $sample
    $gbValid = $gbAdjust -gt 0 -and (Test-StrictDecode $sample $gb $gbAdjust)
  }
  if ($gbValid) {
    return [ordered]@{ name = 'gb18030'; source = 'detected'; valid = $true; bom = 0; sample_bytes = $sampleSize; verified = $sampleScope }
  }
  return [ordered]@{ name = 'unknown'; source = 'detected'; valid = $false; bom = 0; sample_bytes = $sampleSize; verified = $sampleScope }
}

function Decode-Bytes([byte[]]$bytes, [string]$name, [int]$bomLength) {
  if ($bytes.Length -eq 0) { return [ordered]@{ text = ''; valid = $true } }
  if ($name -eq 'unknown') {
    return [ordered]@{ text = ''; valid = $false }
  }
  $encoding = Get-EncodingObject $name
  if ($null -eq $encoding) {
    return [ordered]@{ text = ''; valid = $false }
  }
  $start = 0
  if ($bomLength -gt 0 -and $bytes.Length -ge $bomLength) {
    if ($name -eq 'utf-8' -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { $start = 3 }
    if (($name -eq 'utf-16le' -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) -or
        ($name -eq 'utf-16be' -and $bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF)) { $start = 2 }
  }
  try {
    $decoder = $encoding.GetDecoder()
    $chars = New-Object char[] ($encoding.GetMaxCharCount($bytes.Length))
    $count = $decoder.GetChars($bytes, $start, $bytes.Length - $start, $chars, 0, $true)
    return [ordered]@{ text = (New-Object System.String($chars, 0, $count)); valid = $true }
  } catch {
    $fallback = [System.Text.Encoding]::GetEncoding(54936)
    if ($name -eq 'utf-8') { $fallback = New-Object System.Text.UTF8Encoding($false, $false) }
    if ($name -eq 'utf-16le') { $fallback = New-Object System.Text.UnicodeEncoding($false, $false, $false) }
    if ($name -eq 'utf-16be') { $fallback = New-Object System.Text.UnicodeEncoding($true, $false, $false) }
    return [ordered]@{ text = $fallback.GetString($bytes, $start, $bytes.Length - $start); valid = $false }
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

function Get-Utf8LeadingContinuationSkip([byte[]]$bytes, [byte[]]$before) {
  $continuations = 0
  while ($continuations -lt $bytes.Length -and $continuations -lt 3 -and $bytes[$continuations] -ge 0x80 -and $bytes[$continuations] -le 0xBF) {
    $continuations += 1
  }
  if ($continuations -eq 0 -or $before.Length -eq 0) { return 0 }
  $leadIndex = $before.Length - 1
  while ($leadIndex -ge 0 -and $before[$leadIndex] -ge 0x80 -and $before[$leadIndex] -le 0xBF) { $leadIndex -= 1 }
  if ($leadIndex -lt 0) { return 0 }
  $lead = $before[$leadIndex]
  $expected = if ($lead -ge 0xC2 -and $lead -le 0xDF) { 1 } elseif ($lead -ge 0xE0 -and $lead -le 0xEF) { 2 } elseif ($lead -ge 0xF0 -and $lead -le 0xF4) { 3 } else { 0 }
  if ($expected -eq 0) { return 0 }
  $offset = $before.Length - $leadIndex
  if ($offset -ge ($expected + 1)) { return 0 }
  $beforeContinuations = $offset - 1
  for ($index = 1; $index -le ($beforeContinuations + $continuations); $index += 1) {
    $value = if ($index -le $beforeContinuations) {
      $before[$leadIndex + $index]
    } else {
      $bytes[$index - $beforeContinuations - 1]
    }
    if (-not (Test-Utf8Continuation $lead $index $value)) { return 0 }
  }
  return $continuations
}

function Decode-Boundary([byte[]]$bytes, [string]$name, [int]$bomLength, [bool]$fromStart, [bool]$allowAdjust, [byte[]]$before) {
  $bom = if ($fromStart) { $bomLength } else { 0 }
  $exact = Decode-Bytes $bytes $name $bom
  if ($exact.valid -or -not $allowAdjust) {
    return [ordered]@{ text = $exact.text; valid = $exact.valid; used = $bytes.Length; trim_end = 0; skip_start = 0 }
  }

  $adjust = 0
  if ($fromStart) {
    if ($name -eq 'utf-8') {
      $adjust = Get-Utf8IncompleteTail $bytes
    } elseif ($name -eq 'gb18030') {
      if ($bytes.Length -gt 0 -and $bytes[$bytes.Length - 1] -ge 0x81 -and $bytes[$bytes.Length - 1] -le 0xFE) { $adjust = 1 }
    } elseif ($name -eq 'utf-16le' -or $name -eq 'utf-16be') {
      if (($bytes.Length % 2) -eq 1) {
        $adjust = if (Test-Utf16HighSurrogateBeforeExtra $bytes $name) { 3 } else { 1 }
      } elseif (Test-Utf16HighSurrogateLast $bytes $name) {
        $adjust = 2
      }
    }
  } else {
    if ($name -eq 'utf-8') {
      $adjust = Get-Utf8LeadingContinuationSkip $bytes $before
    } elseif ($name -eq 'gb18030') {
      if ($bytes.Length -gt 0 -and $before.Length -gt 0 -and
          $bytes[0] -ge 0x40 -and $bytes[0] -le 0xFE -and
          $before[$before.Length - 1] -ge 0x81 -and $before[$before.Length - 1] -le 0xFE) {
        $adjust = 1
      }
    } elseif (($name -eq 'utf-16le' -or $name -eq 'utf-16be') -and
        (Test-Utf16LowSurrogateFirst $bytes $name) -and (Test-Utf16HighSurrogateLastBefore $before $name)) {
      $adjust = 2
    }
  }
  if ($adjust -le 0 -or $bytes.Length -lt $adjust) {
    return [ordered]@{ text = $exact.text; valid = $false; used = $bytes.Length; trim_end = 0; skip_start = 0 }
  }

  $start = if ($fromStart) { 0 } else { $adjust }
  $used = $bytes.Length - $adjust
  $slice = [byte[]]::new([int]$used)
  [Array]::Copy($bytes, $start, $slice, 0, [int]$used)
  $decoded = Decode-Bytes $slice $name $bom
  if ($decoded.valid) {
    return [ordered]@{
      text = $decoded.text
      valid = $true
      used = [int]$used
      trim_end = [int]$(if ($fromStart) { $adjust } else { 0 })
      skip_start = [int]$(if ($fromStart) { 0 } else { $adjust })
    }
  }
  return [ordered]@{ text = $exact.text; valid = $false; used = $bytes.Length; trim_end = 0; skip_start = 0 }
}

function Get-Sha256([string]$path) {
  $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

try {
  $isSummary = $PSCmdlet.ParameterSetName -eq 'Summary' -or $PSCmdlet.ParameterSetName -eq 'SummaryEnv'
  if ($isSummary) {
    $target = $Summary
    if ($PSCmdlet.ParameterSetName -eq 'SummaryEnv') {
      $target = [System.Environment]::GetEnvironmentVariable($SummaryEnv, 'Process')
      if ([string]::IsNullOrWhiteSpace($target)) { throw "summary environment variable is empty: $SummaryEnv" }
    }
    $path = [System.IO.Path]::GetFullPath($target)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "summary not found: $path" }
    $info = Get-Item -LiteralPath $path
    if ($info.Length -gt $MaxSummaryBytes) {
      throw "summary is $($info.Length) bytes, above the $MaxSummaryBytes-byte read limit"
    }
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $decoded = Decode-Bytes $bytes 'utf-8' 3
    if (-not $decoded.valid) { throw 'summary is not valid UTF-8' }
    $summaryObject = $decoded.text | ConvertFrom-Json
    $result = [ordered]@{
      path = $path
      bytes = [long]$info.Length
      sha256 = Get-Sha256 $path
      schema = [string]$summaryObject.schema
      task_id = [string]$summaryObject.task_id
      phase = [string]$summaryObject.phase
      status = [string]$summaryObject.status
      command_status = [string]$summaryObject.command_status
      evidence_status = [string]$summaryObject.evidence_status
      evidence_complete = $summaryObject.evidence_complete
      exit_code = $summaryObject.exit_code
      command_exit_code = $summaryObject.command_exit_code
      shell_exit_code = $summaryObject.shell_exit_code
      tool_exit_code = $summaryObject.tool_exit_code
      duration_ms = $summaryObject.duration_ms
      counts = $summaryObject.counts
      claims = $summaryObject.claims
      logs = $summaryObject.logs
      note = [string]$summaryObject.note
      warnings = $summaryObject.warnings
    }
    $result | ConvertTo-Json -Depth 6 -Compress
    exit 0
  }

  $target = $Log
  if ($PSCmdlet.ParameterSetName -eq 'LogEnv') {
    $target = [System.Environment]::GetEnvironmentVariable($LogEnv, 'Process')
    if ([string]::IsNullOrWhiteSpace($target)) { throw "log environment variable is empty: $LogEnv" }
  }
  $path = [System.IO.Path]::GetFullPath($target)
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "log not found: $path" }
  $info = Get-Item -LiteralPath $path
  $detected = if ($Encoding -eq 'auto') { Detect-Encoding $path } else { [ordered]@{ name = $Encoding; source = 'argument'; valid = $true; bom = 0; sample_bytes = 0; verified = 'argument' } }
  $headCount = [int]([Math]::Min([long]$HeadBytes, [long]$info.Length))
  $tailCount = [int]([Math]::Min([long]$TailBytes, [long]([Math]::Max(0, $info.Length - $headCount))))
  $tailStart = [long]$info.Length - [long]$tailCount
  if (($detected.name -eq 'utf-16le' -or $detected.name -eq 'utf-16be') -and ($tailStart % 2) -ne 0) {
    $tailStart -= 1
    $tailCount += 1
  }
  if ($headCount -le 3) { $headCount = [int][Math]::Min([long]$headCount, [long]$info.Length) }
  $headBuffer = [byte[]]::new([int]$headCount)
  if ($headCount -gt 0) {
    $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      $read = $stream.Read($headBuffer, 0, $headCount)
      if ($read -ne $headCount) {
        $trimmed = [byte[]]::new([int]$read)
        [Array]::Copy($headBuffer, $trimmed, $read)
        $headBuffer = $trimmed
      }
    } finally { $stream.Dispose() }
  }
  $tailBuffer = [byte[]]::new([int]$tailCount)
  if ($tailCount -gt 0) {
    $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      $stream.Seek($tailStart, [System.IO.SeekOrigin]::Begin) | Out-Null
      $read = $stream.Read($tailBuffer, 0, $tailCount)
      if ($read -ne $tailCount) {
        $trimmed = [byte[]]::new([int]$read)
        [Array]::Copy($tailBuffer, $trimmed, $read)
        $tailBuffer = $trimmed
      }
    } finally { $stream.Dispose() }
  }
  $beforeCount = [int][Math]::Min([long]4, $tailStart)
  $tailBefore = [byte[]]::new($beforeCount)
  if ($beforeCount -gt 0) {
    $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      $stream.Seek([long]$tailStart - [long]$beforeCount, [System.IO.SeekOrigin]::Begin) | Out-Null
      [void]$stream.Read($tailBefore, 0, $beforeCount)
    } finally { $stream.Dispose() }
  }
  $head = Decode-Boundary $headBuffer $detected.name $detected.bom $true ($headCount -lt $info.Length) ([byte[]]::new(0))
  $tail = Decode-Boundary $tailBuffer $detected.name 0 $false ($tailStart -gt 0) $tailBefore
  $hex = ''
  if (-not $head.valid -or -not $detected.valid -or $detected.name -eq 'unknown') {
    $hexLength = [int][Math]::Min(64, $headBuffer.Length)
    if ($hexLength -gt 0) {
      $hexBytes = New-Object byte[] $hexLength
      [Array]::Copy($headBuffer, $hexBytes, $hexLength)
      $hex = ([System.BitConverter]::ToString($hexBytes)).Replace('-', '').ToLowerInvariant()
    }
  }
  $result = [ordered]@{
    path = $path
    bytes = [long]$info.Length
    sha256 = Get-Sha256 $path
    encoding = $detected.name
    encoding_source = $detected.source
    encoding_verified = $detected.verified
    encoding_sample_bytes = [int]$detected.sample_bytes
    encoding_valid = [bool]($detected.valid -and $head.valid -and $tail.valid)
    boundary_trimmed_head_bytes = [int]$head.trim_end
    boundary_trimmed_tail_bytes = [int]$tail.skip_start
    head_bytes = [int]$head.used
    tail_bytes = [int]$tail.used
    truncated = (([int]$head.used + [int]$tail.used) -lt $info.Length)
    head = $head.text
    tail = $tail.text
    head_hex = $hex
  }
  $result | ConvertTo-Json -Depth 4 -Compress
  exit 0
}
catch {
  [Console]::Error.WriteLine("read-evidence: $([string]$_.Exception.Message)")
  [Console]::Error.WriteLine([string]$_.InvocationInfo.PositionMessage)
  exit 2
}


