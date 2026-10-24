param(
  [int]$Port = 8765,
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
  $Root = Split-Path -Parent $PSScriptRoot
}
$Root = [System.IO.Path]::GetFullPath($Root)
$TaskName = 'QianDuoDuo-AutoStart'
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$taskArgument = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ".\scripts\daemon.ps1" -Action start -Port {0} -Root "."' -f $Port
$taskAction = New-ScheduledTaskAction `
  -Execute $PowerShellExe `
  -Argument $taskArgument `
  -WorkingDirectory $Root
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
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

function Install-StartupShortcut {
  $shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'QianDuoDuo Production.lnk'
  $disabledShortcut = "$shortcutPath.disabled"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $PowerShellExe
  $shortcut.Arguments = $taskArgument
  $shortcut.WorkingDirectory = $Root
  $shortcut.WindowStyle = 7
  $shortcut.Save()
  if (Test-Path -LiteralPath $disabledShortcut) {
    Remove-Item -LiteralPath $disabledShortcut -Force
  }
  Write-Host "Login auto-start installed through Startup shortcut: $shortcutPath"
}

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
  $existingAction = @($existingTask.Actions)[0]
  $matchesExisting =
    $existingAction -and
    $existingAction.Execute -eq $PowerShellExe -and
    $existingAction.Arguments -eq $taskArgument -and
    $existingAction.WorkingDirectory -eq $Root
  if (-not $matchesExisting) {
    throw "Existing auto-start task differs from the current definition: $TaskName"
  }
  Enable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null
  Write-Host "Auto-start already installed: $TaskName"
  exit 0
}

try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $taskAction `
    -Trigger $logonTrigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Start QianDuoDuo once when the current user logs on. No periodic watchdog.' `
    -Force | Out-Null
  Enable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null

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
  Write-Host "Login auto-start installed: $TaskName ($($task.State))"
} catch {
  $message = $_.Exception.Message
  if ($message -notmatch 'Access is denied|0x80070005') {
    throw
  }
  Write-Warning "Scheduled task creation was denied; using the current user's Startup folder."
  Install-StartupShortcut
}
