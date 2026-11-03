param(
  [ValidateSet(
    'install',
    'uninstall',
    'start',
    'stop',
    'restart',
    'status',
    'bootstrap',
    'stop-runtime'
  )]
  [string]$Action = 'status',
  [int]$Port = 8765,
  [string]$Root = '',
  [ValidatePattern('^[A-Za-z0-9_-]+$')]
  [string]$TaskName = 'QianDuoDuo-Production',
  [int]$HealthTimeoutSeconds = 3,
  [int]$GracefulStopTimeoutMs = 10000,
  [string]$LegacyStartupDirectory = '',
  [switch]$SkipElevation,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
  $Root = Split-Path -Parent $PSScriptRoot
}
$Root = [System.IO.Path]::GetFullPath($Root)
if (-not $LegacyStartupDirectory) {
  $LegacyStartupDirectory = [Environment]::GetFolderPath('Startup')
}
$LegacyStartupDirectory = [System.IO.Path]::GetFullPath($LegacyStartupDirectory)

$RunDir = Join-Path $Root 'run'
$LogDir = Join-Path $Root 'logs'
$DaemonScript = Join-Path $Root 'scripts\daemon.ps1'
$DaemonPidFile = Join-Path $RunDir 'daemon.pid'
$ServerPidFile = Join-Path $RunDir 'server.pid'
$SupervisorMetaFile = Join-Path $RunDir 'supervisor.json'
$HostStopFile = Join-Path $RunDir 'host.stop'
$HostLockFile = Join-Path $RunDir 'host.lock'
$HostConfigFile = Join-Path $RunDir 'host.json'
$HostStateFile = Join-Path $RunDir 'host-state.json'
$HostLog = Join-Path $LogDir 'host.log'
$HealthUrl = "http://127.0.0.1:$Port/api/health"
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$WScriptExe = Join-Path $env:SystemRoot 'System32\wscript.exe'
$TickLauncherTemplate = Join-Path $PSScriptRoot 'production-bootstrap-template.vbs'
$TickLauncherDir = Join-Path `
  ([Environment]::GetFolderPath('CommonApplicationData')) `
  'QianDuoDuoProduction'
$TickLauncher = Join-Path $TickLauncherDir "tick-$TaskName.vbs"
$TickLauncherLog = Join-Path $LogDir 'launcher.log'
$DefaultTaskName = 'QianDuoDuo-Production'
$LegacyTaskName = 'QianDuoDuo-AutoStart'
$LegacyStartupArchiveDir = Join-Path $RunDir 'legacy-startup'

function Ensure-Directories {
  New-Item -ItemType Directory -Force -Path $RunDir, $LogDir | Out-Null
}

function Write-HostLog {
  param([string]$Message)
  Ensure-Directories
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -LiteralPath $HostLog -Value $line -Encoding UTF8
}

function Write-JsonFile {
  param(
    [string]$Path,
    [object]$Value
  )
  Ensure-Directories
  $temporaryPath = '{0}.{1}.tmp' -f $Path, $PID
  $json = $Value | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText(
    $temporaryPath,
    $json,
    (New-Object System.Text.UTF8Encoding($false))
  )
  Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }
  try {
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-NewHostState {
  return [ordered]@{
    version = 2
    updated_at = $null
    last_bootstrap_at = $null
    last_outcome = 'not_started'
    last_error = $null
    supervisor_pid = $null
    server_pid = $null
  }
}

function Read-HostState {
  $state = Get-NewHostState
  $saved = Read-JsonFile -Path $HostStateFile
  if ($saved) {
    foreach ($property in $saved.PSObject.Properties) {
      if ($state.Contains($property.Name)) {
        $state[$property.Name] = $property.Value
      }
    }
  }
  return $state
}

function Save-HostState {
  param([object]$State)
  $State.updated_at = (Get-Date).ToUniversalTime().ToString('o')
  Write-JsonFile -Path $HostStateFile -Value $State
}

function Write-TickLauncher {
  if (-not (Test-Path -LiteralPath $TickLauncherTemplate)) {
    throw "Production bootstrap launcher template is missing: $TickLauncherTemplate"
  }
  New-Item -ItemType Directory -Force -Path $TickLauncherDir | Out-Null
  $content = Get-Content `
    -LiteralPath $TickLauncherTemplate `
    -Raw `
    -Encoding UTF8
  $content = $content.Replace(
    '__PROJECT_ROOT__',
    $Root.Replace('"', '""')
  )
  $content = $content.Replace('__PORT__', [string]$Port)
  $content = $content.Replace('__TASK_NAME__', $TaskName)
  $content = $content.Replace('__LOG_PATH__', $TickLauncherLog)
  [System.IO.File]::WriteAllText(
    $TickLauncher,
    $content,
    [System.Text.Encoding]::Unicode
  )
}

function Read-PidFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }
  $raw = Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue | Select-Object -First 1
  $processId = 0
  if ([int]::TryParse([string]$raw, [ref]$processId) -and $processId -gt 0) {
    return $processId
  }
  return $null
}

function Get-LiveProcessId {
  param([string]$Path)
  $processId = Read-PidFile -Path $Path
  if (-not $processId) {
    return $null
  }
  if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
    return $processId
  }
  return $null
}

function Test-Health {
  try {
    $response = Invoke-WebRequest `
      -UseBasicParsing `
      -Uri $HealthUrl `
      -TimeoutSec $HealthTimeoutSeconds
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Get-ListeningProcessId {
  if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
    return $null
  }
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($listener) {
    return [int]$listener.OwningProcess
  }
  return $null
}

function Get-RuntimeSnapshot {
  $supervisorPid = Get-LiveProcessId -Path $DaemonPidFile
  $serverPid = Get-LiveProcessId -Path $ServerPidFile
  $listenerPid = Get-ListeningProcessId
  $origin = $null
  $metadata = Read-JsonFile -Path $SupervisorMetaFile
  if ($metadata) {
    $origin = [string]$metadata.origin
  }
  return [pscustomobject]@{
    supervisor_pid = $supervisorPid
    server_pid = $serverPid
    listener_pid = $listenerPid
    supervisor_origin = $origin
    healthy = (
      (Test-Health) -and
      $null -ne $serverPid -and
      $listenerPid -eq $serverPid
    )
  }
}

function Get-ExpectedTaskArgument {
  return '//B //NoLogo "{0}"' -f $TickLauncher
}

function Test-TaskDefinition {
  param([object]$Task)
  if (-not $Task) {
    return $false
  }
  try {
    $action = @($Task.Actions)[0]
    $principal = $Task.Principal
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principalUser = [string]$principal.UserId
    $userMatches =
      $principalUser -eq $currentUser -or
      $principalUser -eq $currentUser.Split('\')[-1]
    $normalize = {
      param([string]$Value)
      return (($Value -replace '\s+', ' ').Trim())
    }
    return (
      $action -and
      $action.Execute -eq $WScriptExe -and
      (& $normalize $action.Arguments) -eq (& $normalize (Get-ExpectedTaskArgument)) -and
      $action.WorkingDirectory -eq $Root -and
      (Test-Path -LiteralPath $TickLauncher) -and
      $principal -and
      $userMatches -and
      $principal.LogonType -eq 'Interactive' -and
      $principal.RunLevel -eq 'Limited'
    )
  } catch {
    return $false
  }
}

function Get-TaskSnapshot {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    return [pscustomobject]@{
      installed = $false
      enabled = $false
      state = 'not_installed'
      definition_valid = $false
      login_trigger = $false
      single_trigger = $false
      last_run_time = $null
      last_task_result = $null
      next_run_time = $null
    }
  }

  $triggers = @($task.Triggers)
  $loginTrigger = @(
    $triggers | Where-Object {
      $_.CimClass.CimClassName -match 'LogonTrigger' -and $_.Enabled
    }
  ).Count -gt 0
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
  return [pscustomobject]@{
    installed = $true
    enabled = $task.State -ne 'Disabled'
    state = [string]$task.State
    definition_valid = Test-TaskDefinition -Task $task
    login_trigger = $loginTrigger
    single_trigger = $triggers.Count -eq 1
    last_run_time = if ($info) { $info.LastRunTime } else { $null }
    last_task_result = if ($info) { $info.LastTaskResult } else { $null }
    next_run_time = if ($info) { $info.NextRunTime } else { $null }
  }
}

function Test-IsElevated {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-ElevatedHostAction {
  param([string]$ElevatedAction)
  if ($SkipElevation) {
    throw "Task Scheduler operation requires elevation: $ElevatedAction"
  }
  $arguments = @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy Bypass',
    '-WindowStyle Hidden',
    '-File',
    ('"{0}"' -f $PSCommandPath),
    '-Action', $ElevatedAction,
    '-Port', "$Port",
    '-Root', ('"{0}"' -f $Root),
    '-TaskName', $TaskName,
    '-HealthTimeoutSeconds', "$HealthTimeoutSeconds",
    '-GracefulStopTimeoutMs', "$GracefulStopTimeoutMs"
  )
  if ($LegacyStartupDirectory) {
    $arguments += @('-LegacyStartupDirectory', ('"{0}"' -f $LegacyStartupDirectory))
  }
  $process = Start-Process `
    -FilePath $PowerShellExe `
    -ArgumentList $arguments `
    -WorkingDirectory $Root `
    -Verb RunAs `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
  if ($process.ExitCode -ne 0) {
    Write-HostLog "elevated action exited nonzero action=$ElevatedAction code=$($process.ExitCode); caller will verify final state"
  }
  return [int]$process.ExitCode
}

function Grant-CurrentUserTaskAccess {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $scheduler = New-Object -ComObject Schedule.Service
  $scheduler.Connect()
  $folder = $scheduler.GetFolder('\')
  $registered = $folder.GetTask($TaskName)
  $securityDescriptor = $registered.GetSecurityDescriptor(7)
  $rawSecurity = New-Object System.Security.AccessControl.RawSecurityDescriptor($securityDescriptor)
  $hasFullControl = $false
  foreach ($ace in $rawSecurity.DiscretionaryAcl) {
    if (
      $ace -is [System.Security.AccessControl.CommonAce] -and
      $ace.AceQualifier -eq [System.Security.AccessControl.AceQualifier]::AccessAllowed -and
      $ace.SecurityIdentifier -eq $sid -and
      (($ace.AccessMask -band 0xF01FF) -eq 0xF01FF)
    ) {
      $hasFullControl = $true
      break
    }
  }
  if (-not $hasFullControl) {
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
}

function Move-LegacyStartupShortcuts {
  $legacyNames = @(
    'QianDuoDuo Production.lnk',
    'QianDuoDuo Production.lnk.legacy-disabled'
  )
  foreach ($name in $legacyNames) {
    $source = Join-Path $LegacyStartupDirectory $name
    if (-not (Test-Path -LiteralPath $source)) {
      continue
    }

    New-Item -ItemType Directory -Force -Path $LegacyStartupArchiveDir | Out-Null
    $destination = Join-Path $LegacyStartupArchiveDir $name
    if (Test-Path -LiteralPath $destination) {
      $suffix = Get-Date -Format 'yyyyMMddHHmmssfff'
      $destination = '{0}.{1}' -f $destination, $suffix
    }
    Move-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
    Write-HostLog "moved legacy startup file out of Startup source=$source destination=$destination"
  }
}

function Remove-LegacyAutoStart {
  if ($TaskName -eq $DefaultTaskName -and $Port -eq 8765) {
    $legacyTask = Get-ScheduledTask -TaskName $LegacyTaskName -ErrorAction SilentlyContinue
    if ($legacyTask) {
      Unregister-ScheduledTask -TaskName $LegacyTaskName -Confirm:$false -ErrorAction Stop
      Write-HostLog "removed legacy scheduled task=$LegacyTaskName"
    }
  }

  Move-LegacyStartupShortcuts
}

function Install-Host {
  Move-LegacyStartupShortcuts
  $existing = Get-TaskSnapshot
  if (
    $existing.installed -and
    $existing.enabled -and
    $existing.definition_valid -and
    $existing.login_trigger -and
    $existing.single_trigger
  ) {
    Write-HostLog "independent login task already valid task=$TaskName"
    Write-Host "Independent production host already installed: $TaskName"
    return
  }

  if (-not (Test-IsElevated)) {
    Invoke-ElevatedHostAction -ElevatedAction 'install' | Out-Null
    $installed = Get-TaskSnapshot
    if (
      -not $installed.installed -or
      -not $installed.definition_valid -or
      -not $installed.single_trigger
    ) {
      throw "Task was not installed with the expected single-trigger definition: $TaskName"
    }
    return
  }

  Ensure-Directories
  Write-TickLauncher
  $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $taskAction = New-ScheduledTaskAction `
    -Execute $WScriptExe `
    -Argument (Get-ExpectedTaskArgument) `
    -WorkingDirectory $Root
  $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
  $principal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -LogonType Interactive `
    -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $taskAction `
    -Trigger $logonTrigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Start QianDuoDuo Supervisor once at user logon through a hidden WScript launcher.' `
    -Force | Out-Null
  Enable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null
  Grant-CurrentUserTaskAccess
  Remove-LegacyAutoStart

  $config = [ordered]@{
    version = 2
    provider = 'windows-task-scheduler'
    task_name = $TaskName
    launcher = $TickLauncher
    user = $currentUser
    root = $Root
    port = $Port
    trigger = 'AtLogOn'
    installed_at = (Get-Date).ToUniversalTime().ToString('o')
  }
  Write-JsonFile -Path $HostConfigFile -Value $config
  Write-HostLog "installed hidden login task=$TaskName user=$currentUser port=$Port"
  Write-Host "Independent production host installed: $TaskName"
}

function Unregister-Host {
  if (-not (Test-IsElevated)) {
    Invoke-ElevatedHostAction -ElevatedAction 'uninstall' | Out-Null
    if ((Get-TaskSnapshot).installed) {
      throw "Task still exists after uninstall: $TaskName"
    }
    return
  }

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    Write-HostLog "uninstalled independent host task=$TaskName"
  }
  Remove-Item -LiteralPath $TickLauncher, $TickLauncherLog -Force -ErrorAction SilentlyContinue
  if (
    (Test-Path -LiteralPath $TickLauncherDir) -and
    -not (Get-ChildItem -LiteralPath $TickLauncherDir -Force -ErrorAction SilentlyContinue)
  ) {
    Remove-Item -LiteralPath $TickLauncherDir -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $HostConfigFile -Force -ErrorAction SilentlyContinue
  Write-Host "Independent production host uninstalled: $TaskName"
}

function Ensure-HostInstalled {
  $task = Get-TaskSnapshot
  if (
    -not $task.installed -or
    -not $task.enabled -or
    -not $task.definition_valid -or
    -not $task.login_trigger -or
    -not $task.single_trigger
  ) {
    Install-Host
  }
}

function Invoke-Daemon {
  param([string[]]$Arguments)
  & $PowerShellExe `
    -NoProfile `
    -NonInteractive `
    -ExecutionPolicy Bypass `
    -WindowStyle Hidden `
    -File $DaemonScript `
    @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "daemon.ps1 failed: $($Arguments -join ' ')"
  }
}

function Enter-HostLock {
  Ensure-Directories
  try {
    return [System.IO.File]::Open(
      $HostLockFile,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
  } catch [System.IO.IOException] {
    return $null
  }
}

function Invoke-Bootstrap {
  $lock = Enter-HostLock
  if (-not $lock) {
    return
  }
  $state = Read-HostState
  $state.last_bootstrap_at = (Get-Date).ToUniversalTime().ToString('o')
  try {
    Move-LegacyStartupShortcuts
    if (Test-Path -LiteralPath $HostStopFile) {
      $runtime = Get-RuntimeSnapshot
      if ($runtime.supervisor_pid -or $runtime.server_pid) {
        Invoke-Daemon @(
          '-Action', 'stop',
          '-Port', "$Port",
          '-Root', $Root,
          '-GracefulStopTimeoutMs', "$GracefulStopTimeoutMs",
          '-SupervisorExitWaitMs', '5000',
          '-SkipAutoStart'
        )
      }
      $state.last_outcome = 'controlled_stop'
      $state.last_error = $null
      $state.supervisor_pid = $null
      $state.server_pid = $null
      Save-HostState -State $state
      return
    }

    $runtime = Get-RuntimeSnapshot
    if ($runtime.supervisor_pid) {
      $state.last_outcome = 'supervisor_already_running'
      $state.last_error = $null
      $state.supervisor_pid = $runtime.supervisor_pid
      $state.server_pid = $runtime.server_pid
      Save-HostState -State $state
      return
    }

    Invoke-Daemon @(
      '-Action', 'start',
      '-Port', "$Port",
      '-Root', $Root,
      '-Origin', 'task-scheduler',
      '-SkipAutoStart'
    )
    $runtime = Get-RuntimeSnapshot
    if (-not $runtime.supervisor_pid -or -not $runtime.healthy) {
      throw 'Supervisor did not become healthy during login bootstrap.'
    }
    $state.last_outcome = 'started'
    $state.last_error = $null
    $state.supervisor_pid = $runtime.supervisor_pid
    $state.server_pid = $runtime.server_pid
    Save-HostState -State $state
    Write-HostLog "login bootstrap started supervisor=$($runtime.supervisor_pid) server=$($runtime.server_pid)"
  } catch {
    $state.last_outcome = 'start_failed'
    $state.last_error = $_.Exception.Message
    Save-HostState -State $state
    Write-HostLog "login bootstrap failed: $($_.Exception.Message)"
    exit 1
  } finally {
    $lock.Dispose()
  }
}

function Stop-Runtime {
  Invoke-Daemon @(
    '-Action', 'stop',
    '-Port', "$Port",
    '-Root', $Root,
    '-GracefulStopTimeoutMs', "$GracefulStopTimeoutMs",
    '-SupervisorExitWaitMs', '5000',
    '-SkipAutoStart'
  )
}

function Start-HostedProduction {
  Ensure-Directories
  $distIndex = Join-Path $Root 'dist\index.html'
  if (-not (Test-Path -LiteralPath $distIndex)) {
    throw 'dist/index.html is missing. Run npm run build before starting production.'
  }
  Ensure-HostInstalled

  $runtime = Get-RuntimeSnapshot
  if (
    ($runtime.supervisor_pid -or $runtime.server_pid) -and
    $runtime.supervisor_origin -ne 'task-scheduler'
  ) {
    Write-HostLog "migrating existing runtime origin=$($runtime.supervisor_origin) to task-scheduler"
    try {
      Stop-Runtime
    } catch {
      Invoke-ElevatedHostAction -ElevatedAction 'stop-runtime' | Out-Null
    }
  }

  Remove-Item -LiteralPath $HostStopFile -Force -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  Write-HostLog "start requested through hidden login task=$TaskName"

  for ($attempt = 0; $attempt -lt 90; $attempt++) {
    $runtime = Get-RuntimeSnapshot
    if (
      $runtime.healthy -and
      $runtime.supervisor_pid -and
      $runtime.server_pid -and
      $runtime.supervisor_origin -eq 'task-scheduler'
    ) {
      Write-Host "QianDuoDuo is running independently at http://127.0.0.1:$Port"
      Write-Host "Task: $TaskName"
      Write-Host "Supervisor PID: $($runtime.supervisor_pid)"
      Write-Host "Server PID: $($runtime.server_pid)"
      return
    }
    Start-Sleep -Milliseconds 500
  }
  throw "QianDuoDuo did not become healthy through login task $TaskName. Inspect $TickLauncherLog and $HostLog."
}

function Stop-HostedProduction {
  Ensure-Directories
  New-Item -ItemType File -Force -Path $HostStopFile | Out-Null
  Write-HostLog 'controlled stop requested through hidden login task'
  $task = Get-TaskSnapshot
  if ($task.installed -and $task.enabled) {
    Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $runtime = Get-RuntimeSnapshot
    if (-not $runtime.supervisor_pid -and -not $runtime.server_pid) {
      break
    }
    Start-Sleep -Milliseconds 500
  }
  $runtime = Get-RuntimeSnapshot
  if ($runtime.supervisor_pid -or $runtime.server_pid) {
    try {
      Invoke-ElevatedHostAction -ElevatedAction 'stop-runtime' | Out-Null
    } catch {
      Stop-Runtime
    }
  }
  $runtime = Get-RuntimeSnapshot
  if ($runtime.supervisor_pid -or $runtime.server_pid) {
    throw "Production runtime did not stop: supervisor=$($runtime.supervisor_pid) server=$($runtime.server_pid)"
  }
  $state = Read-HostState
  $state.last_outcome = 'controlled_stop'
  $state.last_error = $null
  $state.supervisor_pid = $null
  $state.server_pid = $null
  Save-HostState -State $state
  Write-Host 'QianDuoDuo production is stopped. The login task remains installed but is isolated by host.stop.'
}

function Uninstall-HostedProduction {
  Stop-HostedProduction
  Unregister-Host
  Write-Host 'QianDuoDuo production host and runtime are uninstalled.'
}

function Get-HostStatusSnapshot {
  $task = Get-TaskSnapshot
  $runtime = Get-RuntimeSnapshot
  $state = Read-HostState
  $stopRequested = Test-Path -LiteralPath $HostStopFile
  $independent =
    $task.installed -and
    $task.enabled -and
    $task.definition_valid -and
    $task.login_trigger -and
    $task.single_trigger -and
    $runtime.supervisor_origin -eq 'task-scheduler'
  return [pscustomobject]@{
    host_provider = 'windows-task-scheduler'
    task_name = $TaskName
    tick_launcher = $TickLauncher
    host_installed = $task.installed
    host_enabled = $task.enabled
    host_state = $task.state
    task_definition_valid = $task.definition_valid
    login_trigger = $task.login_trigger
    single_trigger = $task.single_trigger
    task_last_run_time = $task.last_run_time
    task_last_result = $task.last_task_result
    task_next_run_time = $task.next_run_time
    stop_requested = $stopRequested
    independent = $independent
    healthy = $runtime.healthy
    supervisor_pid = $runtime.supervisor_pid
    server_pid = $runtime.server_pid
    listener_pid = $runtime.listener_pid
    supervisor_origin = $runtime.supervisor_origin
    last_bootstrap_at = $state.last_bootstrap_at
    last_bootstrap_outcome = $state.last_outcome
    last_error = $state.last_error
    logs = $LogDir
  }
}

function Show-HostStatus {
  $status = Get-HostStatusSnapshot
  if ($Json) {
    $status | ConvertTo-Json -Depth 6
  } else {
    $hostingText = if ($status.host_installed -and $status.task_definition_valid) {
      "$($status.task_name) ($($status.host_state))"
    } elseif ($status.host_installed) {
      "$($status.task_name) (definition mismatch)"
    } else {
      'not installed'
    }
    $intentText = if ($status.stop_requested) { 'stopped by prod:stop' } else { 'run requested' }
    $healthText = if ($status.healthy) { 'OK' } else { 'FAIL' }
    $supervisorText = if ($status.supervisor_pid) {
      "running (PID $($status.supervisor_pid), $($status.supervisor_origin))"
    } else {
      'stopped'
    }
    $serverText = if ($status.server_pid) {
      "running (PID $($status.server_pid))"
    } else {
      'stopped'
    }

    Write-Host 'QianDuoDuo production status'
    Write-Host "URL:          http://127.0.0.1:$Port"
    Write-Host "Hosting:      $hostingText"
    Write-Host "Auto-start:   $(if ($status.login_trigger -and $status.single_trigger -and $status.task_definition_valid) { 'configured at current-user logon' } else { 'not configured' })"
    Write-Host "Bootstrap:    hidden WScript; no periodic health probe"
    Write-Host "Independent:  $(if ($status.independent) { 'yes' } else { 'no' })"
    Write-Host "Intent:       $intentText"
    Write-Host "Health:       $healthText"
    Write-Host "Server:       $serverText"
    Write-Host "Supervisor:   $supervisorText"
    Write-Host "Last start:   $($status.last_bootstrap_at) | $($status.last_bootstrap_outcome)"
    if ($status.last_error) {
      Write-Host "Last error:   $($status.last_error)"
    }
    Write-Host "Logs:         $LogDir"
  }

  if ($status.stop_requested) {
    exit 0
  }
  if (-not $status.host_installed -or -not $status.healthy -or -not $status.independent) {
    exit 1
  }
}

switch ($Action) {
  'install' {
    Install-Host
  }
  'uninstall' {
    Uninstall-HostedProduction
  }
  'start' {
    Start-HostedProduction
  }
  'stop' {
    Stop-HostedProduction
  }
  'restart' {
    Stop-HostedProduction
    Start-Sleep -Seconds 1
    Start-HostedProduction
  }
  'status' {
    Show-HostStatus
  }
  'bootstrap' {
    Invoke-Bootstrap
  }
  'stop-runtime' {
    Stop-Runtime
  }
}
