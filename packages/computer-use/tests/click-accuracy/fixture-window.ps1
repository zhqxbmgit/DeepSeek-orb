# ORB click-accuracy fixture window (Windows PowerShell 5.1 / WinForms).
#
# A deliberately inert test surface: every control only changes counters, the
# displayed result, and this run's local JSONL log. It never opens a link,
# touches a file outside -RunDir, or calls a business API.
#
# Control protocol (polled, no network, no global hook):
#   <RunDir>\command.json  { "seq": 1, "command": "prepare", "trial": {...} }
#   <RunDir>\state.json    latest fixture/trial geometry and counters
#   <RunDir>\events.jsonl  every mouse down/up and activation in this window
#
# The controller owns trial truth. The fixture only renders the rectangles it
# is given and reports what Windows actually delivered.
param(
  [Parameter(Mandatory = $true)][string]$RunDir,
  [Parameter(Mandatory = $true)][string]$RunId
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class OrbFixtureWin32 {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")]
  public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")]
  public static extern int GetWindowLong(IntPtr hWnd, int index);

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@

$dpiProcessResult = $false
$dpiThreadResult = [IntPtr]::Zero
try {
  $dpiProcessResult = [OrbFixtureWin32]::SetProcessDpiAwarenessContext([IntPtr](-4))
} catch { }
try {
  # powershell.exe may already be a DPI-unaware process. A per-thread
  # PerMonitorV2 context must be set before WinForms creates its first window;
  # then every rect stays in real physical pixels instead of virtualized ones.
  $dpiThreadResult = [OrbFixtureWin32]::SetThreadDpiAwarenessContext([IntPtr](-4))
} catch { }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$utf8 = New-Object System.Text.UTF8Encoding($false)
$statePath = Join-Path $RunDir 'state.json'
$eventsPath = Join-Path $RunDir 'events.jsonl'
$logPath = Join-Path $RunDir 'fixture.log'
$commandPath = Join-Path $RunDir 'command.json'

function Now-Ms { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Write-FixtureLog {
  param([string]$Text)
  try {
    $line = ('{0} {1}' -f ([DateTimeOffset]::Now.ToString('o')), $Text)
    [System.IO.File]::AppendAllText($logPath, $line + "`n", $utf8)
  } catch { }
}

Write-FixtureLog ('dpi: process-aware=' + [bool]$dpiProcessResult + ' thread-previous=' + $dpiThreadResult.ToString())

function Write-JsonAtomic {
  param([string]$Path, $Value)
  $tmp = "$Path.tmp"
  $json = $Value | ConvertTo-Json -Depth 14 -Compress
  [System.IO.File]::WriteAllText($tmp, $json, $utf8)
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Append-Event {
  param($Value)
  try {
    $line = ($Value | ConvertTo-Json -Depth 10 -Compress) + "`n"
    [System.IO.File]::AppendAllText($eventsPath, $line, $utf8)
  } catch {
    Write-FixtureLog ("append-event-error: " + $_.Exception.Message)
  }
}

function Get-ControlId {
  param($Control)
  if ($null -eq $Control) { return 'none' }
  if ($Control -eq $script:form) { return 'form' }
  if ($null -ne $Control.Tag) { return [string]$Control.Tag }
  if (-not [string]::IsNullOrEmpty($Control.Name)) { return [string]$Control.Name }
  return $Control.GetType().Name
}

function Point-InRect {
  param([int]$X, [int]$Y, $Rect)
  return ($X -ge [int]$Rect.x -and $X -lt ([int]$Rect.x + [int]$Rect.width) -and
          $Y -ge [int]$Rect.y -and $Y -lt ([int]$Rect.y + [int]$Rect.height))
}

function Find-ButtonAt {
  param([int]$X, [int]$Y)
  foreach ($entry in $script:buttonEntries) {
    if (Point-InRect $X $Y $entry.rect) { return $entry }
  }
  return $null
}

function Get-WindowSnapshot {
  $rect = New-Object OrbFixtureWin32+RECT
  [void][OrbFixtureWin32]::GetWindowRect($script:form.Handle, [ref]$rect)
  $origin = $script:form.PointToScreen([System.Drawing.Point]::new(0, 0))
  $dpi = 96
  try { $dpi = [int][OrbFixtureWin32]::GetDpiForWindow($script:form.Handle) } catch { }
  return [ordered]@{
    x = [int]$rect.Left
    y = [int]$rect.Top
    width = [int]($rect.Right - $rect.Left)
    height = [int]($rect.Bottom - $rect.Top)
    clientOriginX = [int]$origin.X
    clientOriginY = [int]$origin.Y
    dpi = [int]$dpi
    scale = [math]::Round($dpi / 96.0, 3)
    foregroundHwnd = [int64][OrbFixtureWin32]::GetForegroundWindow()
    visible = [bool][OrbFixtureWin32]::IsWindowVisible($script:form.Handle)
  }
}

function Get-ButtonStates {
  $list = @()
  foreach ($entry in $script:buttonEntries) {
    $c = $entry.control
    $origin = $c.PointToScreen([System.Drawing.Point]::new(0, 0))
    $list += [ordered]@{
      id = [string]$entry.id
      label = [string]$entry.label
      isTarget = [bool]$entry.isTarget
      rect = $entry.rect
      screenRect = [ordered]@{
        x = [int]$origin.X
        y = [int]$origin.Y
        width = [int]$c.Width
        height = [int]$c.Height
      }
      enabled = [bool]$c.Enabled
      visible = [bool]$c.Visible
    }
  }
  return $list
}

function Get-PointGuard {
  param([int]$X, [int]$Y)
  $point = New-Object OrbFixtureWin32+POINT
  $point.X = $X
  $point.Y = $Y
  $h = [OrbFixtureWin32]::WindowFromPoint($point)
  $ownerPid = [uint32]0
  [void][OrbFixtureWin32]::GetWindowThreadProcessId($h, [ref]$ownerPid)
  $exStyle = 0
  try { $exStyle = [OrbFixtureWin32]::GetWindowLong($h, -20) } catch { }
  $fg = [OrbFixtureWin32]::GetForegroundWindow()
  $fgPid = [uint32]0
  [void][OrbFixtureWin32]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  return [ordered]@{
    x = $X
    y = $Y
    windowHwnd = [int64]$h
    windowPid = [int64]$ownerPid
    windowIsSelf = ([int64]$ownerPid -eq [int64]$PID)
    windowTransparent = (($exStyle -band 0x20) -ne 0)
    windowExStyle = [int64]$exStyle
    foregroundHwnd = [int64]$fg
    foregroundPid = [int64]$fgPid
    foregroundIsSelf = ([int64]$fgPid -eq [int64]$PID)
  }
}

function Write-State {
  param([string]$Status)
  if ($null -eq $script:form) { return }
  $snap = Get-WindowSnapshot
  $buttonStates = @(Get-ButtonStates)
  $target = $buttonStates | Where-Object { $_.isTarget -eq $true } | Select-Object -First 1
  $guard = $null
  $targetCenter = $null
  if ($null -ne $target) {
    $cx = [int]($target.screenRect.x + [math]::Floor($target.screenRect.width / 2))
    $cy = [int]($target.screenRect.y + [math]::Floor($target.screenRect.height / 2))
    $targetCenter = [ordered]@{ x = $cx; y = $cy }
    $guard = Get-PointGuard $cx $cy
  }
  $state = [ordered]@{
    runId = $RunId
    pid = $PID
    hwnd = [int64]$script:form.Handle
    status = $Status
    startedAt = $script:startedAt
    updatedAt = (Now-Ms)
    windowRect = [ordered]@{ x = $snap.x; y = $snap.y; width = $snap.width; height = $snap.height }
    clientOrigin = [ordered]@{ x = $snap.clientOriginX; y = $snap.clientOriginY }
    clientSize = [ordered]@{ width = [int]$script:form.ClientSize.Width; height = [int]$script:form.ClientSize.Height }
    dpi = $snap.dpi
    scale = $snap.scale
    foregroundHwnd = $snap.foregroundHwnd
    visible = $snap.visible
    headerHeight = $script:headerHeight
    stopRect = $script:stopRect
    stopped = [bool]$script:stopped
    stopLatched = [bool]$script:stopLatched
    startupActivated = [bool]$script:startupActivated
    accepting = [bool]$script:accepting
    attemptCount = [int]$script:attemptCount
    maxAttempts = [int]$script:maxAttempts
    lastResult = [string]$script:lastResult
    trial = $script:activeTrial
    targetCenter = $targetCenter
    guard = $guard
    buttons = $buttonStates
    preparedSeq = [int]$script:preparedSeq
    commandSeq = [int]$script:lastCommandSeq
  }
  Write-JsonAtomic $statePath $state
}

function Set-Result {
  param([string]$Text, [bool]$Hit)
  $script:lastResult = $Text
  if ($null -ne $script:lblResult) {
    $script:lblResult.Text = ('第 {0} 次：{1}' -f [math]::Max(1, $script:attemptCount), $Text)
    if ($Hit) { $script:lblResult.ForeColor = [System.Drawing.Color]::FromArgb(80, 220, 130) }
    else { $script:lblResult.ForeColor = [System.Drawing.Color]::FromArgb(255, 170, 80) }
  }
  if ($script:attemptCount -ge $script:maxAttempts) {
    $script:accepting = $false
    foreach ($entry in $script:buttonEntries) { $entry.control.Enabled = $false }
  }
}

function Stop-Test {
  param([string]$Reason)
  if ($script:stopLatched) { return }
  $script:stopLatched = $true
  $script:stopped = $true
  $script:accepting = $false
  $script:lastResult = 'stopped'
  if ($null -ne $script:lblStatus) {
    $script:lblStatus.Text = '已停止测试：不再接受测试点击'
    $script:lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(255, 190, 90)
  }
  if ($null -ne $script:lblResult) {
    $script:lblResult.Text = '已停止；已有结果保存在本轮证据中'
    $script:lblResult.ForeColor = [System.Drawing.Color]::FromArgb(255, 190, 90)
  }
  foreach ($entry in $script:buttonEntries) { $entry.control.Enabled = $false }
  if ($null -ne $script:stopButton) { $script:stopButton.Enabled = $false }
  Append-Event ([ordered]@{
    type = 'stop'
    time = (Now-Ms)
    runId = $RunId
    trialId = $script:activeTrial.trialId
    reason = $Reason
    attemptCount = [int]$script:attemptCount
  })
  Write-State 'stopped'
}

function Bring-ToFront {
  try {
    $h = $script:form.Handle
    [void][OrbFixtureWin32]::ShowWindow($h, 5)
    [void][OrbFixtureWin32]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003) # TOPMOST | NOSIZE | NOMOVE
    [void][OrbFixtureWin32]::SetForegroundWindow($h)
    $script:form.Activate()
  } catch {
    Write-FixtureLog ("bring-front-error: " + $_.Exception.Message)
  }
}

function New-TestButton {
  param($Spec)
  $c = New-Object System.Windows.Forms.Button
  $c.Name = [string]$Spec.id
  $c.Tag = [string]$Spec.id
  $c.Text = [string]$Spec.label
  $c.Bounds = New-Object System.Drawing.Rectangle(
    [int]$Spec.rect.x, [int]$Spec.rect.y, [int]$Spec.rect.width, [int]$Spec.rect.height)
  $c.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
  $c.FlatAppearance.BorderSize = 2
  $c.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(90, 120, 170)
  $c.FlatAppearance.MouseOverBackColor = [System.Drawing.Color]::FromArgb(48, 64, 92)
  $c.FlatAppearance.MouseDownBackColor = [System.Drawing.Color]::FromArgb(35, 80, 120)
  $c.BackColor = [System.Drawing.Color]::FromArgb(38, 46, 62)
  $c.ForeColor = [System.Drawing.Color]::FromArgb(235, 240, 250)
  $c.UseVisualStyleBackColor = $false
  $c.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
  $family = if ($null -ne $Spec.fontFamily -and [string]$Spec.fontFamily -ne '') { [string]$Spec.fontFamily } else { 'Microsoft YaHei UI' }
  $c.Font = New-Object System.Drawing.Font($family, [single]$Spec.fontPt, [System.Drawing.FontStyle]::Bold)
  $c.Add_MouseDown({ param($sender, $e) On-MouseEvent 'down' $sender $e })
  $c.Add_MouseUp({ param($sender, $e) On-MouseEvent 'up' $sender $e })
  $c.Add_Click({
    param($sender, $e)
    try {
      $id = [string]$sender.Tag
      $entry = $script:buttonEntries | Where-Object { $_.id -eq $id } | Select-Object -First 1
      if ($null -eq $entry) { return }
      $hit = [bool]$entry.isTarget
      $text = if ($hit) { '命中' } else { ('未命中：点到「' + $entry.label + '」') }
      Set-Result $text $hit
      Append-Event ([ordered]@{
        type = 'activation'
        time = (Now-Ms)
        runId = $RunId
        trialId = $script:activeTrial.trialId
        controlId = $id
        label = $entry.label
        isTarget = $hit
        attemptCount = [int]$script:attemptCount
        lastEventScreenX = if ($null -ne $script:lastEventScreen) { [int]$script:lastEventScreen.x } else { $null }
        lastEventScreenY = if ($null -ne $script:lastEventScreen) { [int]$script:lastEventScreen.y } else { $null }
        stopped = [bool]$script:stopped
        stopLatched = [bool]$script:stopLatched
      })
      Write-State 'ready'
    } catch {
      Write-FixtureLog ("activation-error: " + $_.Exception.ToString())
    }
  })
  $script:form.Controls.Add($c)
  return $c
}

function New-ContextLabel {
  param($Spec)
  $l = New-Object System.Windows.Forms.Label
  $l.Name = [string]$Spec.id
  $l.Tag = [string]$Spec.id
  $l.Bounds = New-Object System.Drawing.Rectangle(
    [int]$Spec.x, [int]$Spec.y, [int]$Spec.width, [int]$Spec.height)
  $l.Text = [string]$Spec.text
  $l.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Regular)
  $l.ForeColor = [System.Drawing.Color]::FromArgb(120, 138, 162)
  $l.BackColor = [System.Drawing.Color]::Transparent
  $l.Enabled = $false
  $script:form.Controls.Add($l)
  return $l
}

function On-MouseEvent {
  param([string]$Kind, $Sender, $Event)
  try {
    if ($null -eq $script:activeTrial) { return }
    # The event's own location is the primary landing. The cursor snapshot is
    # recorded separately; it is never substituted for the event position.
    $eventScreen = $Sender.PointToScreen($Event.Location)
    $snapshot = [System.Windows.Forms.Cursor]::Position
    $eventClient = $script:form.PointToClient($eventScreen)
    $snapshotClient = $script:form.PointToClient($snapshot)
    $controlId = Get-ControlId $Sender
    $inTestArea = ($eventClient.X -ge 0 -and $eventClient.Y -ge $script:headerHeight -and
                   $eventClient.X -lt $script:form.ClientSize.Width -and $eventClient.Y -lt $script:form.ClientSize.Height)
    $attempt = [int]$script:attemptCount
    $ignored = $false
    if ($Kind -eq 'down' -and $Event.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
      if ($script:stopLatched -or $script:stopped -or -not $script:accepting) {
        $ignored = $true
      } elseif ($inTestArea) {
        $script:attemptCount = $script:attemptCount + 1
        $attempt = [int]$script:attemptCount
        $script:currentAttempt = $attempt
      }
    } elseif ($Kind -eq 'up' -and $Event.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
      $attempt = [int]$script:currentAttempt
    }
    $hit = Find-ButtonAt ([int]$eventClient.X) ([int]$eventClient.Y)
    $hitId = if ($null -eq $hit) { 'none' } else { [string]$hit.id }
    $isTarget = if ($null -eq $hit) { $false } else { [bool]$hit.isTarget }
    $script:lastEventScreen = [ordered]@{ x = [int]$eventScreen.X; y = [int]$eventScreen.Y }
    Append-Event ([ordered]@{
      type = 'mouse'
      time = (Now-Ms)
      runId = $RunId
      trialId = $script:activeTrial.trialId
      msg = $Kind
      button = 'left'
      controlId = $controlId
      eventScreenX = [int]$eventScreen.X
      eventScreenY = [int]$eventScreen.Y
      eventClientX = [int]$eventClient.X
      eventClientY = [int]$eventClient.Y
      snapshotScreenX = [int]$snapshot.X
      snapshotScreenY = [int]$snapshot.Y
      snapshotClientX = [int]$snapshotClient.X
      snapshotClientY = [int]$snapshotClient.Y
      eventMatchesSnapshot = ([int]$eventScreen.X -eq [int]$snapshot.X -and [int]$eventScreen.Y -eq [int]$snapshot.Y)
      inTestArea = [bool]$inTestArea
      hitId = $hitId
      isTarget = [bool]$isTarget
      attempt = [int]$attempt
      ignored = [bool]$ignored
      stopped = [bool]$script:stopped
      stopLatched = [bool]$script:stopLatched
      foregroundHwnd = [int64][OrbFixtureWin32]::GetForegroundWindow()
    })
    if ($Kind -eq 'up' -and $Event.Button -eq [System.Windows.Forms.MouseButtons]::Left -and
        $null -eq $hit -and $inTestArea -and -not $script:stopped -and -not $script:stopLatched -and $script:accepting) {
      Set-Result '未命中：空白区域' $false
      Write-State 'ready'
    }
    if ($Kind -eq 'down' -and $Event.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
      Write-State 'ready'
    }
  } catch {
    Write-FixtureLog ("mouse-error: " + $_.Exception.ToString())
  }
}

function Apply-Trial {
  param($Spec)
  if ($script:stopLatched -or $script:stopped) {
    $script:lastResult = 'prepare-rejected-after-stop'
    Append-Event ([ordered]@{
      type = 'prepare-rejected'
      time = (Now-Ms)
      runId = $RunId
      trialId = if ($null -ne $script:activeTrial) { [string]$script:activeTrial.trialId } else { 'none' }
      requestedTrialId = if ($null -ne $Spec) { [string]$Spec.trialId } else { 'none' }
      reason = 'stop-latched'
      seq = [int]$script:lastCommandSeq
    })
    Write-State 'stopped'
    return
  }
  $script:activeTrial = $Spec
  $script:attemptCount = 0
  $script:currentAttempt = 0
  $script:maxAttempts = [int]$Spec.maxAttempts
  if ($script:maxAttempts -lt 1) { $script:maxAttempts = 1 }
  $script:accepting = $true
  $script:stopped = $false
  $script:lastResult = '等待点击'

  foreach ($old in @($script:testButtons)) {
    if ($null -ne $old) {
      $script:form.Controls.Remove($old)
      $old.Dispose()
    }
  }
  $script:testButtons = @()
  $script:buttonEntries = @()
  foreach ($oldLabel in @($script:contextLabels)) {
    if ($null -ne $oldLabel) {
      $script:form.Controls.Remove($oldLabel)
      $oldLabel.Dispose()
    }
  }
  $script:contextLabels = @()
  if ($null -ne $Spec.contextLabels) {
    foreach ($cl in @($Spec.contextLabels)) {
      $script:contextLabels += New-ContextLabel $cl
    }
  }

  $w = [int]$Spec.window.width
  $h = [int]$Spec.window.height
  # NOZORDER + NOACTIVATE + SHOWWINDOW: change geometry, never raise or activate.
  [void][OrbFixtureWin32]::SetWindowPos($script:form.Handle, [IntPtr]::Zero,
    [int]$Spec.window.x, [int]$Spec.window.y, $w, $h, 0x0054)
  $script:form.Refresh()

  $script:lblTitle.Text = 'ORB CLICK BASELINE 0.2.17'
  $script:lblInstruction.Text = [string]$Spec.instruction
  $script:lblTrial.Text = ('{0}  |  {1}  |  第 {2} 题  |  {3}' -f $Spec.group, $Spec.trialId, [int]$Spec.index, $RunId)
  $script:lblStatus.Text = '等待点击（目标位置固定，不会在思考时移动）'
  $script:lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(170, 190, 220)
  $script:lblResult.Text = '尚未点击'
  $script:lblResult.ForeColor = [System.Drawing.Color]::FromArgb(200, 210, 230)

  foreach ($bs in @($Spec.buttons)) {
    $c = New-TestButton $bs
    $script:testButtons += $c
    $script:buttonEntries += [pscustomobject]@{
      id = [string]$bs.id
      label = [string]$bs.label
      isTarget = [bool]$bs.isTarget
      rect = [pscustomobject]@{
        x = [int]$bs.rect.x; y = [int]$bs.rect.y
        width = [int]$bs.rect.width; height = [int]$bs.rect.height
      }
      control = $c
    }
  }

  $script:lblStatus.Text = ('等待点击：{0}' -f [string]$Spec.targetLabel)
  $script:preparedSeq = [int]$script:lastCommandSeq
  Append-Event ([ordered]@{
    type = 'prepare'
    time = (Now-Ms)
    runId = $RunId
    trialId = [string]$Spec.trialId
    group = [string]$Spec.group
    layoutVersion = [string]$Spec.layoutVersion
    seq = [int]$script:lastCommandSeq
    window = $Spec.window
    buttons = @($Spec.buttons)
  })
  Write-State 'ready'
}

function Read-Command {
  if (-not (Test-Path -LiteralPath $commandPath)) { return $null }
  try {
    $raw = [System.IO.File]::ReadAllText($commandPath, $utf8)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return ($raw | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Handle-Command {
  $cmd = Read-Command
  if ($null -eq $cmd) { return }
  $seq = 0
  try { $seq = [int]$cmd.seq } catch { return }
  if ($seq -le $script:lastCommandSeq) { return }
  $script:lastCommandSeq = $seq
  switch ([string]$cmd.command) {
    'prepare' {
      try { Apply-Trial $cmd.trial }
      catch {
        Write-FixtureLog ("prepare-error: " + $_.Exception.ToString())
        Write-State 'error'
      }
    }
    'stop' { Stop-Test 'controller' }
    'raise' {
      # Deliberately refused: after startup, the fixture never takes focus back.
      Append-Event ([ordered]@{
        type = 'raise-rejected'
        time = (Now-Ms)
        runId = $RunId
        reason = 'post-startup-raise-is-not-allowed'
        seq = $seq
        foregroundHwnd = [int64][OrbFixtureWin32]::GetForegroundWindow()
      })
      Write-State 'ready'
    }
    'ping' { Write-State 'ready' }
    'exit' {
      $script:status = 'exiting'
      Write-State 'exiting'
      $script:form.Close()
    }
    default {
      Append-Event ([ordered]@{ type = 'unknown-command'; time = (Now-Ms); command = [string]$cmd.command; seq = $seq })
    }
  }
}

# ---------------------------------------------------------------- form setup
$script:startedAt = Now-Ms
$script:status = 'starting'
$script:stopped = $false
$script:stopLatched = $false
$script:startupActivated = $false
$script:lastEventScreen = $null
$script:accepting = $false
$script:attemptCount = 0
$script:currentAttempt = 0
$script:maxAttempts = 1
$script:lastResult = ''
$script:lastCommandSeq = 0
$script:preparedSeq = 0
$script:testButtons = @()
$script:buttonEntries = @()
$script:contextLabels = @()
$script:activeTrial = $null
$script:headerHeight = 176
$script:stopRect = [pscustomobject]@{ x = 20; y = 126; width = 240; height = 44 }

$form = New-Object System.Windows.Forms.Form
$script:form = $form
$form.Text = ('ORB CLICK BASELINE 0.2.17 - ' + $RunId)
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$form.TopMost = $true
$form.ShowInTaskbar = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(24, 28, 36)
$form.MinimizeBox = $false
$form.MaximizeBox = $false
$form.ControlBox = $false
$form.Bounds = New-Object System.Drawing.Rectangle(1100, 300, 1600, 1000)

$titleFont = New-Object System.Drawing.Font('Microsoft YaHei UI', 15, [System.Drawing.FontStyle]::Bold)
$bodyFont = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Regular)
$smallFont = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Regular)

$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Name = 'header-title'; $lblTitle.Tag = 'header-title'
$lblTitle.Bounds = New-Object System.Drawing.Rectangle(20, 8, 1000, 44)
$lblTitle.Font = $titleFont
$lblTitle.ForeColor = [System.Drawing.Color]::FromArgb(240, 245, 255)
$lblTitle.BackColor = [System.Drawing.Color]::Transparent
$lblTitle.Text = 'ORB CLICK BASELINE 0.2.17'
$form.Controls.Add($lblTitle)

$lblInstruction = New-Object System.Windows.Forms.Label
$lblInstruction.Name = 'header-instruction'; $lblInstruction.Tag = 'header-instruction'
$lblInstruction.Bounds = New-Object System.Drawing.Rectangle(20, 56, 1540, 40)
$lblInstruction.Font = $bodyFont
$lblInstruction.ForeColor = [System.Drawing.Color]::FromArgb(220, 230, 245)
$lblInstruction.BackColor = [System.Drawing.Color]::Transparent
$lblInstruction.Text = '等待测试控制器准备题目'
$form.Controls.Add($lblInstruction)

$lblTrial = New-Object System.Windows.Forms.Label
$lblTrial.Name = 'header-trial'; $lblTrial.Tag = 'header-trial'
$lblTrial.Bounds = New-Object System.Drawing.Rectangle(20, 100, 900, 24)
$lblTrial.Font = $smallFont
$lblTrial.ForeColor = [System.Drawing.Color]::FromArgb(150, 170, 200)
$lblTrial.BackColor = [System.Drawing.Color]::Transparent
$lblTrial.Text = 'trial: none'
$form.Controls.Add($lblTrial)

$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Name = 'header-status'; $lblStatus.Tag = 'header-status'
$lblStatus.Bounds = New-Object System.Drawing.Rectangle(280, 130, 1280, 38)
$lblStatus.Font = $bodyFont
$lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(170, 190, 220)
$lblStatus.BackColor = [System.Drawing.Color]::Transparent
$lblStatus.Text = '启动中'
$form.Controls.Add($lblStatus)

$lblResult = New-Object System.Windows.Forms.Label
$lblResult.Name = 'header-result'; $lblResult.Tag = 'header-result'
$lblResult.Bounds = New-Object System.Drawing.Rectangle(1040, 8, 520, 84)
$lblResult.Font = $bodyFont
$lblResult.ForeColor = [System.Drawing.Color]::FromArgb(200, 210, 230)
$lblResult.BackColor = [System.Drawing.Color]::FromArgb(20, 24, 32)
$lblResult.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
$lblResult.Text = '尚未点击'
$form.Controls.Add($lblResult)
$script:lblTitle = $lblTitle
$script:lblInstruction = $lblInstruction
$script:lblTrial = $lblTrial
$script:lblStatus = $lblStatus
$script:lblResult = $lblResult

$stopButton = New-Object System.Windows.Forms.Button
$stopButton.Name = 'stop-test'; $stopButton.Tag = 'stop-test'
$stopButton.Bounds = New-Object System.Drawing.Rectangle(
  $script:stopRect.x, $script:stopRect.y, $script:stopRect.width, $script:stopRect.height)
$stopButton.Text = '停止测试 (STOP)'
$stopButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$stopButton.FlatAppearance.BorderSize = 2
$stopButton.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(230, 100, 100)
$stopButton.BackColor = [System.Drawing.Color]::FromArgb(90, 36, 42)
$stopButton.ForeColor = [System.Drawing.Color]::FromArgb(255, 225, 225)
$stopButton.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
$stopButton.UseVisualStyleBackColor = $false
$stopButton.Add_MouseDown({ param($sender, $e) On-MouseEvent 'down' $sender $e })
$stopButton.Add_MouseUp({ param($sender, $e) On-MouseEvent 'up' $sender $e })
$stopButton.Add_Click({ try { Stop-Test 'user-button' } catch { Write-FixtureLog ("stop-error: " + $_.Exception.Message) } })
$form.Controls.Add($stopButton)
$script:stopButton = $stopButton

# Log clicks on the header and empty form too, so misses are not silent.
foreach ($c in @($form, $lblTitle, $lblInstruction, $lblTrial, $lblStatus, $lblResult)) {
  $c.Add_MouseDown({ param($sender, $e) On-MouseEvent 'down' $sender $e })
  $c.Add_MouseUp({ param($sender, $e) On-MouseEvent 'up' $sender $e })
}

$form.Add_FormClosing({
  param($sender, $e)
  try {
    Append-Event ([ordered]@{ type = 'exit'; time = (Now-Ms); runId = $RunId; reason = 'form-closing' })
  } catch { }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({
  try { Handle-Command } catch { Write-FixtureLog ("timer-error: " + $_.Exception.ToString()) }
})
$timer.Start()

# Heartbeat: refresh guard/foreground facts while the model is thinking, so
# the controller can notice a foreground change without a click or prepare.
$heartbeat = New-Object System.Windows.Forms.Timer
$heartbeat.Interval = 250
$heartbeat.Add_Tick({
  try {
    if ($null -ne $script:activeTrial -and -not $script:stopLatched) { Write-State 'ready' }
  } catch { }
})
$heartbeat.Start()

$form.Add_Shown({
  try {
    # The only activation in this process. Later prepares never raise or
    # reactivate the fixture; a foreground change is evidence, not a race to win.
    Bring-ToFront
    $script:startupActivated = $true
    Write-State 'ready'
    Append-Event ([ordered]@{
      type = 'startup-activated'
      time = (Now-Ms)
      runId = $RunId
      pid = $PID
      hwnd = [int64]$form.Handle
      foregroundHwnd = [int64][OrbFixtureWin32]::GetForegroundWindow()
      startupActivated = $true
    })
  } catch { Write-FixtureLog ("shown-error: " + $_.Exception.Message) }
})

Write-FixtureLog ("fixture starting runId=$RunId pid=$PID runDir=$RunDir")
[System.Windows.Forms.Application]::Run($form)
$timer.Stop()
Write-FixtureLog 'fixture exited'
