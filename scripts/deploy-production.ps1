param(
  [int]$Port = 8765,
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$ProductionHostScript = Join-Path $PSScriptRoot 'production-host.ps1'
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

Write-Host '3/4 Installing the independent Windows production host...'
& $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $ProductionHostScript -Action install -Port $Port -Root $Root
if ($LASTEXITCODE -ne 0) {
  throw 'Independent production host installation failed.'
}

Write-Host '4/4 Starting production and checking health...'
& $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $ProductionHostScript -Action start -Port $Port -Root $Root
if ($LASTEXITCODE -ne 0) {
  throw 'Production process failed to start.'
}

& $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $ProductionHostScript -Action status -Port $Port -Root $Root

Write-Host ''
Write-Host 'Production deployment complete.'
Write-Host "URL:  http://127.0.0.1:$Port"
Write-Host "Logs: $Root\logs"
Write-Host 'Hosting: Windows Task Scheduler (single hidden logon bootstrap; no periodic probe)'
