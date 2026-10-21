# Fixture self-check. This script uses direct SendInput, not the dsh-orb click
# tool, so its results are NOT part of the real-plugin accuracy counts.
#
# It verifies the fixture itself:
#   1. a real Windows left click on the target produces down, up and activation;
#   2. a click on empty test area is logged with no activation;
#   3. preparing a new trial resets counters and re-enables the target;
#   4. the left "停止测试" button stops further test input;
#   5. the fixture records real physical DPI-192 coordinates.
param(
  [string]$RunId = ''
)

$ErrorActionPreference = 'Stop'
if ($RunId -eq '') { $RunId = 'selfcheck-' + (Get-Date -Format 'HHmmss') }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$runDir = Join-Path $repo ".zcode\clicktest\$RunId"
$fixtureScript = Join-Path $PSScriptRoot 'fixture-window.ps1'
$evidenceDir = Join-Path $repo ".zcode\evidence\click-accuracy-0217\$RunId"
New-Item -ItemType Directory -Force -Path $runDir, $evidenceDir | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OrbSelfWin32 {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")]
  public static extern bool SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")]
  public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@
try { [void][OrbSelfWin32]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }
try { [void][OrbSelfWin32]::SetThreadDpiAwarenessContext([IntPtr](-4)) } catch { }

Add-Type -AssemblyName System.Drawing
$utf8 = New-Object System.Text.UTF8Encoding($false)
$statePath = Join-Path $runDir 'state.json'
$eventsPath = Join-Path $runDir 'events.jsonl'
$commandPath = Join-Path $runDir 'command.json'

function Read-State {
  if (-not (Test-Path -LiteralPath $statePath)) { return $null }
  return ([System.IO.File]::ReadAllText($statePath, $utf8) | ConvertFrom-Json)
}
function Wait-State {
  param([scriptblock]$Condition, [int]$TimeoutMs = 15000)
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  while ((Get-Date) -lt $deadline) {
    $s = Read-State
    if ($null -ne $s -and (& $Condition $s)) { return $s }
    Start-Sleep -Milliseconds 120
  }
  throw 'timed out waiting for fixture state'
}
function Write-Command {
  param([int]$Seq, [string]$Command, $Trial = $null)
  $body = [ordered]@{ seq = $Seq; command = $Command }
  if ($null -ne $Trial) { $body.trial = $Trial }
  [System.IO.File]::WriteAllText($commandPath, ($body | ConvertTo-Json -Depth 12 -Compress), $utf8)
}
function Read-Events {
  if (-not (Test-Path -LiteralPath $eventsPath)) { return @() }
  return @(Get-Content -LiteralPath $eventsPath -Encoding UTF8 | ForEach-Object {
    try { $_ | ConvertFrom-Json } catch { }
  })
}
function Click-At {
  param([int]$X, [int]$Y)
  [void][OrbSelfWin32]::SetCursorPos($X, $Y)
  Start-Sleep -Milliseconds 120
  [OrbSelfWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 120
  [OrbSelfWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 450
}
function Capture-Window {
  param([int64]$Hwnd, [string]$Path)
  $r = New-Object OrbSelfWin32+RECT
  [void][OrbSelfWin32]::GetWindowRect([IntPtr]$Hwnd, [ref]$r)
  $w = $r.Right - $r.Left
  $h = $r.Bottom - $r.Top
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $g.Dispose()
    $bmp.Dispose()
  }
}

$trial1 = [ordered]@{
  trialId = 'SELF-01'; group = 'SELF'; layoutVersion = 'SELF'; index = 1; maxAttempts = 2
  instruction = '自检：点击目标，再点一次空白区域'; targetLabel = 'SELF TARGET'
  window = [ordered]@{ x = 1100; y = 300; width = 1400; height = 900 }
  buttons = @([ordered]@{
    id = 'target'; label = 'SELF TARGET'; isTarget = $true; fontPt = 18
    rect = [ordered]@{ x = 500; y = 400; width = 300; height = 160 }
  })
}
$trial2 = [ordered]@{
  trialId = 'SELF-02'; group = 'SELF'; layoutVersion = 'SELF'; index = 2; maxAttempts = 1
  instruction = '自检：新题重置'; targetLabel = 'SELF SECOND'
  window = [ordered]@{ x = 1300; y = 360; width = 1400; height = 900 }
  buttons = @([ordered]@{
    id = 'target'; label = 'SELF SECOND'; isTarget = $true; fontPt = 18
    rect = [ordered]@{ x = 500; y = 400; width = 300; height = 160 }
  })
}

$proc = $null
$checks = [ordered]@{}
try {
  $args = '-NoProfile -STA -ExecutionPolicy Bypass -File "' + $fixtureScript + '" -RunDir "' + $runDir + '" -RunId "' + $RunId + '"'
  $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $args -PassThru
  $state = Wait-State { param($s) $s.status -eq 'ready' } 15000
  $checks.fixtureStarted = $true
  $checks.fixturePid = $state.pid
  $checks.fixtureHwnd = $state.hwnd
  $checks.window = $state.windowRect
  $checks.dpi = $state.dpi
  $checks.scale = $state.scale
  $checks.physicalDpi192 = ($state.dpi -eq 192)

  Write-Command 1 'prepare' $trial1
  $state = Wait-State { param($s) $s.preparedSeq -eq 1 -and $s.trial.trialId -eq 'SELF-01' } 15000
  $checks.windowAfterPrepare = $state.windowRect
  $checks.physicalWindow = ($state.windowRect.width -eq 1400 -and $state.windowRect.height -eq 900)
  [void][OrbSelfWin32]::SetForegroundWindow([IntPtr][int64]$state.hwnd)
  Start-Sleep -Milliseconds 400
  $checks.foregroundIsFixture = ([int64][OrbSelfWin32]::GetForegroundWindow() -eq [int64]$state.hwnd)
  $target = $state.buttons | Where-Object { $_.isTarget } | Select-Object -First 1
  $tx = [int]$state.windowRect.x + [int]$target.rect.x + [int]($target.rect.width / 2)
  $ty = [int]$state.windowRect.y + [int]$target.rect.y + [int]($target.rect.height / 2)
  Capture-Window -Hwnd $state.hwnd -Path (Join-Path $evidenceDir 'selfcheck-before-target.png')
  Click-At $tx $ty
  $afterTarget = Read-State
  $events = Read-Events
  $activation = @($events | Where-Object { $_.type -eq 'activation' -and $_.trialId -eq 'SELF-01' })
  $down = @($events | Where-Object { $_.type -eq 'mouse' -and $_.msg -eq 'down' -and $_.trialId -eq 'SELF-01' })
  $up = @($events | Where-Object { $_.type -eq 'mouse' -and $_.msg -eq 'up' -and $_.trialId -eq 'SELF-01' })
  $checks.targetDown = ($down.Count -eq 1)
  $checks.targetUp = ($up.Count -eq 1)
  $checks.targetActivation = ($activation.Count -eq 1 -and $activation[0].isTarget -eq $true)
  $eventX = if ($down.Count -gt 0 -and $null -ne $down[0].eventScreenX) { [int]$down[0].eventScreenX } else { $null }
  $eventY = if ($down.Count -gt 0 -and $null -ne $down[0].eventScreenY) { [int]$down[0].eventScreenY } else { $null }
  $snapshotX = if ($down.Count -gt 0 -and $null -ne $down[0].snapshotScreenX) { [int]$down[0].snapshotScreenX } else { $null }
  $snapshotY = if ($down.Count -gt 0 -and $null -ne $down[0].snapshotScreenY) { [int]$down[0].snapshotScreenY } else { $null }
  $checks.targetEventLocationSource = if ($null -ne $eventX) { 'event' } elseif ($null -ne $snapshotX) { 'snapshot' } else { 'none' }
  $checks.targetDownScreen = if ($null -ne $eventX) { [ordered]@{ x = $eventX; y = $eventY } } else { $null }
  $checks.targetSnapshotScreen = if ($null -ne $snapshotX) { [ordered]@{ x = $snapshotX; y = $snapshotY } } else { $null }
  $checks.targetDownClient = if ($down.Count -gt 0 -and $null -ne $down[0].eventClientX) { [ordered]@{ x = [int]$down[0].eventClientX; y = [int]$down[0].eventClientY } } else { $null }
  $checks.expectedScreen = [ordered]@{ x = $tx; y = $ty }
  $checks.clickPositionExact = ($null -ne $eventX -and $eventX -eq $tx -and $eventY -eq $ty)
  $checks.eventAndSnapshotFieldsPresent = ($null -ne $eventX -and $null -ne $snapshotX)
  $checks.eventMatchesSnapshot = ($down.Count -gt 0 -and $down[0].eventMatchesSnapshot -eq $true)
  Capture-Window -Hwnd $state.hwnd -Path (Join-Path $evidenceDir 'selfcheck-after-target.png')

  # Empty area inside the test surface, far from the single target button.
  $ex = [int]$state.windowRect.x + [int]$state.windowRect.width - 100
  $ey = [int]$state.windowRect.y + [int]$state.windowRect.height - 100
  Click-At $ex $ey
  $afterEmpty = Read-State
  $events = Read-Events
  $emptyDown = @($events | Where-Object { $_.type -eq 'mouse' -and $_.msg -eq 'down' -and $_.trialId -eq 'SELF-01' -and $_.attempt -eq 2 })
  $emptyActivation = @($events | Where-Object { $_.type -eq 'activation' -and $_.trialId -eq 'SELF-01' -and $_.attemptCount -eq 2 })
  $checks.emptyDownLogged = ($emptyDown.Count -eq 1)
  $checks.emptyNoActivation = ($emptyActivation.Count -eq 0)
  $checks.emptyRecordedAsMiss = ($afterEmpty.lastResult -like '*未命中*')
  $checks.secondAttemptCount = ($afterEmpty.attemptCount -eq 2)

  Write-Command 2 'prepare' $trial2
  $state2 = Wait-State { param($s) $s.preparedSeq -eq 2 -and $s.trial.trialId -eq 'SELF-02' } 15000
  $target2 = $state2.buttons | Where-Object { $_.isTarget } | Select-Object -First 1
  $checks.newTrialResetsAttempts = ($state2.attemptCount -eq 0)
  $checks.newTrialTargetEnabled = ($target2.enabled -eq $true)
  $checks.newTrialWindowMoved = ($state2.windowRect.x -eq 1300 -and $state2.windowRect.y -eq 360)
  $checks.newTrialTargetCenter = $state2.targetCenter

  # Left "stop test" button (client rect in state).
  $stop = $state2.stopRect
  $sx = [int]$state2.windowRect.x + [int]$stop.x + [int]($stop.width / 2)
  $sy = [int]$state2.windowRect.y + [int]$stop.y + [int]($stop.height / 2)
  Click-At $sx $sy
  $stopped = Wait-State { param($s) $s.stopped -eq $true } 5000
  $events = Read-Events
  $checks.stopButtonStopped = ($stopped.stopped -eq $true)
  $checks.stopEventLogged = (@($events | Where-Object { $_.type -eq 'stop' }).Count -eq 1)
  $checks.stopDisablesTarget = (@($stopped.buttons | Where-Object { $_.isTarget -and $_.enabled -eq $false }).Count -eq 1)
  Capture-Window -Hwnd $stopped.hwnd -Path (Join-Path $evidenceDir 'selfcheck-stopped.png')

  $checks.passed = ($checks.targetDown -and $checks.targetUp -and $checks.targetActivation -and
    $checks.clickPositionExact -and $checks.emptyDownLogged -and $checks.emptyNoActivation -and
    $checks.emptyRecordedAsMiss -and $checks.newTrialResetsAttempts -and $checks.newTrialTargetEnabled -and
    $checks.stopButtonStopped -and $checks.stopEventLogged -and $checks.stopDisablesTarget -and
    $checks.physicalDpi192 -and $checks.physicalWindow -and $checks.eventAndSnapshotFieldsPresent -and
    $checks.eventMatchesSnapshot -and $checks.targetEventLocationSource -eq 'event')
  $checks.note = 'Self-check uses direct DPI-aware SendInput, not the dsh-orb click tool; not part of the real-plugin samples.'
  $result = [ordered]@{
    runId = $RunId
    kind = 'fixture-selfcheck'
    startedAt = (Get-Date).ToString('o')
    checks = $checks
    rawEvents = Join-Path $runDir 'events.jsonl'
    rawState = Join-Path $runDir 'state.json'
    evidence = $evidenceDir
  }
  [System.IO.File]::WriteAllText((Join-Path $evidenceDir 'selfcheck.json'), ($result | ConvertTo-Json -Depth 12), $utf8)
  Write-Output ($result | ConvertTo-Json -Depth 12)
  if (-not $checks.passed) { exit 1 }
} finally {
  try { Write-Command 3 'exit' } catch { }
  Start-Sleep -Milliseconds 400
  if ($null -ne $proc -and -not $proc.HasExited) { try { $proc.Kill() } catch { } }
}
