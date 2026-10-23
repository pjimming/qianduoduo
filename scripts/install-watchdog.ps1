param(
  [int]$Port = 8765,
  [string]$Root = '',
  [string]$TaskName = 'QianDuoDuo-Production'
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
  $Root = Split-Path -Parent $PSScriptRoot
}
$Root = [System.IO.Path]::GetFullPath($Root)
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$taskArgument = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ".\scripts\daemon.ps1" -Action start -Port {0} -Root "." -TaskName "{1}"' -f $Port, $TaskName
$taskAction = New-ScheduledTaskAction `
  -Execute $PowerShellExe `
  -Argument $taskArgument `
  -WorkingDirectory $Root
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$watchdogTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At ((Get-Date).AddMinutes(1)) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal `
  -UserId $currentUser `
  -LogonType Interactive `
  -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
  $existingAction = @($existingTask.Actions)[0]
  $matchesExisting =
    $existingAction -and
    $existingAction.Execute -eq $PowerShellExe -and
    $existingAction.Arguments -eq $taskArgument -and
    $existingAction.WorkingDirectory -eq $Root
  if (-not $matchesExisting) {
    throw 'Existing Watchdog task differs from the current definition. Run this installer elevated to replace it.'
  }
  Enable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null
  Write-Host "Watchdog already installed: $TaskName"
  exit 0
}

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $taskAction `
  -Trigger @($logonTrigger, $watchdogTrigger) `
  -Principal $principal `
  -Settings $settings `
  -Description 'QianDuoDuo production supervisor watchdog' `
  -Force | Out-Null
Enable-ScheduledTask -TaskName $TaskName | Out-Null

$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
$registered = $folder.GetTask($TaskName)
$securityDescriptor = $registered.GetSecurityDescriptor(7)
$rawSecurity = New-Object System.Security.AccessControl.RawSecurityDescriptor($securityDescriptor)
$fullControl = $false
foreach ($ace in $rawSecurity.DiscretionaryAcl) {
  if (
    $ace -is [System.Security.AccessControl.CommonAce] -and
    $ace.AceQualifier -eq [System.Security.AccessControl.AceQualifier]::AccessAllowed -and
    $ace.SecurityIdentifier -eq $sid -and
    (($ace.AccessMask -band 0xF01FF) -eq 0xF01FF)
  ) {
    $fullControl = $true
    break
  }
}
if (-not $fullControl) {
  $ace = New-Object System.Security.AccessControl.CommonAce(
    [System.Security.AccessControl.AceFlags]::None,
    [System.Security.AccessControl.AceQualifier]::AccessAllowed,
    0xF01FF,
    $sid,
    $false,
    $null
  )
  $dacl = $rawSecurity.DiscretionaryAcl
  $dacl.InsertAce($dacl.Count, $ace)
  $rawSecurity.DiscretionaryAcl = $dacl
  $registered.SetSecurityDescriptor($rawSecurity.GetSddlForm('All'), 0)
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
Write-Host "Watchdog installed: $TaskName ($($task.State))"
