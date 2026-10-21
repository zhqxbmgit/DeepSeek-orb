# Test-controller fault injection: click the dedicated fixture's STOP button.
# This is a controller/self-check action, not a model click and not part of the
# 57 real-plugin samples. It only operates on this run's fixture state.
param(
  [Parameter(Mandatory = $true)][string]$StatePath,
  [string]$Action = 'stop'
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OrbFaultWin32 {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")]
  public static extern bool SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
try { [void][OrbFaultWin32]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }
try { [void][OrbFaultWin32]::SetThreadDpiAwarenessContext([IntPtr](-4)) } catch { }
$utf8 = New-Object System.Text.UTF8Encoding($false)
$state = [System.IO.File]::ReadAllText($StatePath, $utf8) | ConvertFrom-Json

if ($Action -eq 'stop') {
  $x = [int]$state.windowRect.x + [int]$state.stopRect.x + [int]($state.stopRect.width / 2)
  $y = [int]$state.windowRect.y + [int]$state.stopRect.y + [int]($state.stopRect.height / 2)
  [void][OrbFaultWin32]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 100
  [OrbFaultWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 100
  [OrbFaultWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  [ordered]@{ action = 'stop'; x = $x; y = $y; sentAt = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
} elseif ($Action -eq 'foreground' -and $state.hwnd) {
  $ok = [OrbFaultWin32]::SetForegroundWindow([IntPtr][int64]$state.hwnd)
  [ordered]@{ action = 'foreground'; hwnd = $state.hwnd; ok = [bool]$ok; at = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
} else {
  throw "unsupported action: $Action"
}
