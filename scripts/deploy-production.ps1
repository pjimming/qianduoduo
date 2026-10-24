param(
  [int]$Port = 8765,
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$DaemonScript = Join-Path $PSScriptRoot 'daemon.ps1'
$AutoStartScript = Join-Path $PSScriptRoot 'install-autostart.ps1'
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

Set-Location -LiteralPath $Root

function Get-NpmExe {
  $command = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }
  $fallback = Join-Path $env:ProgramFiles 'nodejs\npm.cmd'
  if (Test-Path -LiteralPath $fallback) {
    return $fallback
  }
  throw 'npm was not found.'
}

$npm = Get-NpmExe

Write-Host '1/4 Building the production bundle...'
& $npm run build
if ($LASTEXITCODE -ne 0) {
  throw 'Production build failed.'
}

if (-not $SkipTests) {
  Write-Host '2/4 Running the regression tests...'
  & $npm test
  if ($LASTEXITCODE -ne 0) {
    throw 'Tests failed. Production deployment aborted.'
  }
} else {
  Write-Host '2/4 Tests skipped.'
}

Write-Host '3/4 Stopping the previous supervisor and installing login auto-start...'
& $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $DaemonScript -Action stop -Port $Port -Root $Root
& $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $AutoStartScript -Port $Port -Root $Root
if ($LASTEXITCODE -ne 0) {
  throw 'Login auto-start installation failed.'
}

Write-Host '4/4 Starting production and checking health...'
& $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $DaemonScript -Action start -Port $Port -Root $Root
if ($LASTEXITCODE -ne 0) {
  throw 'Production process failed to start.'
}

& $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $DaemonScript -Action status -Port $Port -Root $Root

Write-Host ''
Write-Host 'Production deployment complete.'
Write-Host "URL:  http://127.0.0.1:$Port"
Write-Host "Logs: $Root\logs"
Write-Host 'Login auto-start: configured (one trigger, no periodic watchdog)'
