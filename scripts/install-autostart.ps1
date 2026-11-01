param(
  [int]$Port = 8765,
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
  $Root = Split-Path -Parent $PSScriptRoot
}

$hostScript = Join-Path $PSScriptRoot 'production-host.ps1'
& (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
  -NoProfile `
  -ExecutionPolicy Bypass `
  -File $hostScript `
  -Action install `
  -Port $Port `
  -Root $Root
exit $LASTEXITCODE
