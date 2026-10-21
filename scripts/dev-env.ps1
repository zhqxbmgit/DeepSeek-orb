#requires -Version 5.1
# Locate the Node/pnpm pair shipped with DeepSeek Harness and put it on PATH.
# Dot-source this file; do not execute it in a child process:
#   . .\scripts\dev-env.ps1
# The shim lives under .zcode/dev-bin so running the tests never edits a
# tracked file or the user's profile.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

function Find-FirstFile([string[]]$candidates) {
  foreach ($candidate in $candidates) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return [System.IO.Path]::GetFullPath($candidate)
    }
  }
  return $null
}

$node = Find-FirstFile @(
  $env:DSH_DESKTOP_NODE_EXECUTABLE,
  (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'),
  (Join-Path $env:ProgramFiles 'nodejs\node.exe')
)
if ($null -eq $node) {
  $command = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $command) { $node = [string]$command.Source }
}
if ($null -eq $node) {
  throw 'dev-env: Node was not found. Set DSH_DESKTOP_NODE_EXECUTABLE or install Node 22.19+.'
}

$nodeDir = Split-Path -Parent $node
$dependencies = Split-Path -Parent (Split-Path -Parent $nodeDir)
$pnpm = Find-FirstFile @(
  $env:DSH_PNPM,
  (Join-Path $dependencies 'pnpm\bin\pnpm.cjs'),
  (Join-Path (Split-Path -Parent $nodeDir) 'pnpm\bin\pnpm.cjs')
)
if ($null -eq $pnpm) {
  throw 'dev-env: pnpm.cjs was not found next to the bundled Node runtime. Set DSH_PNPM.'
}

$bin = Join-Path $repo '.zcode\dev-bin'
New-Item -ItemType Directory -Path $bin -Force | Out-Null
$nodeShim = Join-Path $bin 'node.cmd'
$pnpmShim = Join-Path $bin 'pnpm.cmd'
$nodeLines = @(
  '@echo off',
  ('"' + $node + '" %*')
)
$pnpmLines = @(
  '@echo off',
  ('"' + $node + '" "' + $pnpm + '" %*')
)
Set-Content -LiteralPath $nodeShim -Value $nodeLines -Encoding Ascii
Set-Content -LiteralPath $pnpmShim -Value $pnpmLines -Encoding Ascii

$npm = Find-FirstFile @(
  $env:DSH_NPM,
  (Join-Path $repo '.zcode\tools\npm\package\bin\npm-cli.js')
)
if ($null -ne $npm) {
  $npmShim = Join-Path $bin 'npm.cmd'
  $npmLines = @(
    '@echo off',
    ('"' + $node + '" "' + $npm + '" %*')
  )
  Set-Content -LiteralPath $npmShim -Value $npmLines -Encoding Ascii
  $env:DSH_NPM = $npm
}

$env:PATH = $bin + ';' + $nodeDir + ';' + $env:PATH
$env:DSH_NODE = $node
$env:DSH_PNPM = $pnpm
$env:DSH_DEV_BIN = $bin

Write-Output "node: $(& $node --version) at $node"
Write-Output "pnpm: $(& $node $pnpm --version) at $pnpm"
if ($null -ne $npm) { Write-Output "npm: $(& $node $npm --version) at $npm" }
Write-Output "pwsh: $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))"
Write-Output "cwd: $((Get-Location).Path)"
