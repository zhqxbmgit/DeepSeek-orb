# Measure the real display geometry from a DPI-aware process.
# Writes JSON to -Out; no window, no input.
param([Parameter(Mandatory = $true)][string]$Out)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OrbDisplayWin32 {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")]
  public static extern IntPtr MonitorFromPoint(POINT p, uint flags);
  [DllImport("shcore.dll")]
  public static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
'@
try { [void][OrbDisplayWin32]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }
try { [void][OrbDisplayWin32]::SetThreadDpiAwarenessContext([IntPtr](-4)) } catch { }

Add-Type -AssemblyName System.Windows.Forms
$screens = @()
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  $p = New-Object OrbDisplayWin32+POINT
  $p.X = [int]$s.Bounds.X + 1
  $p.Y = [int]$s.Bounds.Y + 1
  $mon = [OrbDisplayWin32]::MonitorFromPoint($p, 2)
  $dx = [uint32]0
  $dy = [uint32]0
  try { [void][OrbDisplayWin32]::GetDpiForMonitor($mon, 0, [ref]$dx, [ref]$dy) } catch { }
  if ($dx -eq 0) { $dx = 96; $dy = 96 }
  $screens += [ordered]@{
    deviceName = [string]$s.DeviceName
    primary = [bool]$s.Primary
    bounds = [ordered]@{ x = [int]$s.Bounds.X; y = [int]$s.Bounds.Y; width = [int]$s.Bounds.Width; height = [int]$s.Bounds.Height }
    workingArea = [ordered]@{ x = [int]$s.WorkingArea.X; y = [int]$s.WorkingArea.Y; width = [int]$s.WorkingArea.Width; height = [int]$s.WorkingArea.Height }
    dpiX = [int]$dx
    dpiY = [int]$dy
    scale = [math]::Round([double]$dx / 96.0, 4)
  }
}
$primary = $screens | Where-Object { $_.primary } | Select-Object -First 1
$result = [ordered]@{
  measuredAt = (Get-Date).ToString('o')
  source = 'display-info.ps1 / DPI-aware System.Windows.Forms.Screen + GetDpiForMonitor'
  screenCount = $screens.Count
  primary = $primary
  screens = $screens
}
$json = $result | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output $json
