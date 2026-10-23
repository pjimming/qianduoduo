param(
  [int]$Port = 8765,
  [string]$TaskName = 'QianDuoDuo-Production',
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$DaemonScript = Join-Path $PSScriptRoot 'daemon.ps1'
$WatchdogScript = Join-Path $PSScriptRoot 'install-watchdog.ps1'
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

Write-Host '3/4 Stopping the previous supervisor and installing the watchdog...'
& $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $DaemonScript -Action stop -Port $Port -Root $Root -TaskName $TaskName

$taskInstalled = $false
try {
  & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $WatchdogScript -Port $Port -Root $Root -TaskName $TaskName
  if ($LASTEXITCODE -ne 0) {
    throw 'Watchdog installer returned a non-zero exit code.'
  }
  $taskInstalled = $true
} catch {
  Write-Warning "Scheduled task installation failed: $($_.Exception.Message)"
  $startupDir = [Environment]::GetFolderPath('Startup')
  $shortcutPath = Join-Path $startupDir 'QianDuoDuo Production.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $PowerShellExe
  $taskArgument = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ".\scripts\daemon.ps1" -Action start -Port {0} -Root "." -TaskName "{1}"' -f $Port, $TaskName
  $shortcut.Arguments = $taskArgument
  $shortcut.WorkingDirectory = $Root
  $shortcut.WindowStyle = 7
  $shortcut.Save()
  $disabledShortcut = "$shortcutPath.disabled"
  if (Test-Path -LiteralPath $disabledShortcut) {
    Remove-Item -LiteralPath $disabledShortcut -Force -ErrorAction SilentlyContinue
  }
  Write-Warning "Fallback Startup shortcut installed: $shortcutPath"
}

Write-Host '4/4 Starting production and checking health...'
& $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $DaemonScript -Action start -Port $Port -Root $Root -TaskName $TaskName
if ($LASTEXITCODE -ne 0) {
  throw 'Production process failed to start.'
}

& $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $DaemonScript -Action status -Port $Port -Root $Root -TaskName $TaskName

Write-Host ''
Write-Host 'Production deployment complete.'
Write-Host "URL:  http://127.0.0.1:$Port"
Write-Host "Logs: $Root\logs"
if ($taskInstalled) {
  Write-Host "Auto-start/watchdog task: $TaskName"
} else {
  Write-Host 'Auto-start installed through the current user Startup folder.'
}
