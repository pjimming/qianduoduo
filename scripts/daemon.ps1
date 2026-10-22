param(
  [ValidateSet('start', 'stop', 'restart', 'status', 'run')]
  [string]$Action = 'status',
  [int]$Port = 8765,
  [string]$Root = '',
  [string]$TaskName = 'QianDuoDuo-Production'
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
  $Root = Split-Path -Parent $PSScriptRoot
}
$Root = [System.IO.Path]::GetFullPath($Root)

$RunDir = Join-Path $Root 'run'
$LogDir = Join-Path $Root 'logs'
$DaemonPidFile = Join-Path $RunDir 'daemon.pid'
$ServerPidFile = Join-Path $RunDir 'server.pid'
$StopFile = Join-Path $RunDir 'daemon.stop'
$ServerStopFile = Join-Path $RunDir 'server.stop'
$DaemonLog = Join-Path $LogDir 'daemon.log'
$HealthUrl = "http://127.0.0.1:$Port/api/health"

function Ensure-Directories {
  New-Item -ItemType Directory -Force -Path $RunDir, $LogDir | Out-Null
}

function Write-DaemonLog {
  param([string]$Message)
  Ensure-Directories
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -LiteralPath $DaemonLog -Value $line -Encoding UTF8
}

function Get-LiveProcess {
  param([string]$PidFile)
  if (-not (Test-Path -LiteralPath $PidFile)) {
    return $null
  }
  $raw = Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  $processId = 0
  if (-not [int]::TryParse([string]$raw, [ref]$processId)) {
    return $null
  }
  return Get-Process -Id $processId -ErrorAction SilentlyContinue
}

function Test-Health {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Get-NodeExe {
  $fallback = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path -LiteralPath $fallback) {
    return $fallback
  }
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }
  throw 'Node.js 24 or newer was not found.'
}

function Enable-WatchdogTask {
  if (-not (Get-Command Enable-ScheduledTask -ErrorAction SilentlyContinue)) {
    return
  }
  try {
    Enable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null
  } catch {
    # The task is optional when the daemon is started manually.
  }
}

function Get-StartupShortcut {
  return Join-Path ([Environment]::GetFolderPath('Startup')) 'QianDuoDuo Production.lnk'
}

function Enable-WatchdogStartup {
  $shortcut = Get-StartupShortcut
  $disabled = "$shortcut.disabled"
  if ((Test-Path -LiteralPath $disabled) -and -not (Test-Path -LiteralPath $shortcut)) {
    Move-Item -LiteralPath $disabled -Destination $shortcut -Force
  }
}

function Disable-WatchdogStartup {
  $shortcut = Get-StartupShortcut
  $disabled = "$shortcut.disabled"
  if (Test-Path -LiteralPath $shortcut) {
    Move-Item -LiteralPath $shortcut -Destination $disabled -Force
  }
}

function Start-Supervisor {
  Ensure-Directories
  $distIndex = Join-Path $Root 'dist\index.html'
  if (-not (Test-Path -LiteralPath $distIndex)) {
    throw 'dist/index.html is missing. Run npm run build before starting production.'
  }

  $existing = Get-LiveProcess -PidFile $DaemonPidFile
  if ($existing) {
    if (Test-Health) {
      Write-Host "QianDuoDuo is already running at http://127.0.0.1:$Port"
      return
    }
    throw "Supervisor PID $($existing.Id) is alive but the health check failed. Inspect $DaemonLog."
  }

  $listener = $null
  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -First 1
  }
  if ($listener) {
    throw "Port $Port is already in use by PID $($listener.OwningProcess) without a supervisor. Stop that process before starting production."
  }

  Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
  Enable-WatchdogTask
  Enable-WatchdogStartup

  $powerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = @(
    '-NoProfile',
    '-ExecutionPolicy Bypass',
    '-WindowStyle Hidden',
    '-File', '.\scripts\daemon.ps1',
    '-Action run',
    '-Port', $Port,
    '-Root', '.',
    '-TaskName', $TaskName
  )

  $supervisor = Start-Process `
    -FilePath $powerShellExe `
    -ArgumentList $arguments `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -PassThru

  Set-Content -LiteralPath $DaemonPidFile -Value $supervisor.Id -Encoding ASCII
  Write-DaemonLog "supervisor launch requested pid=$($supervisor.Id) port=$Port"

  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if (Test-Health) {
      Write-Host "QianDuoDuo is running at http://127.0.0.1:$Port"
      Write-Host "Supervisor PID: $($supervisor.Id)"
      Write-Host "Logs: $LogDir"
      return
    }
    Start-Sleep -Milliseconds 500
  }

  throw "QianDuoDuo did not become healthy. Inspect $DaemonLog and $LogDir."
}

function Stop-Supervisor {
  if (Get-Command Stop-ScheduledTask -ErrorAction SilentlyContinue) {
    try {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    } catch {}
  }
  if (Get-Command Disable-ScheduledTask -ErrorAction SilentlyContinue) {
    try {
      Disable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
    } catch {}
  }
  Disable-WatchdogStartup

  Ensure-Directories
  New-Item -ItemType File -Force -Path $StopFile | Out-Null
  New-Item -ItemType File -Force -Path $ServerStopFile | Out-Null

  $server = Get-LiveProcess -PidFile $ServerPidFile
  if ($server) {
    $serverId = $server.Id
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      if (-not (Get-Process -Id $serverId -ErrorAction SilentlyContinue)) {
        break
      }
      Start-Sleep -Milliseconds 250
    }
    $server = Get-Process -Id $serverId -ErrorAction SilentlyContinue
    if ($server) {
      Stop-Process -Id $serverId -Force -ErrorAction SilentlyContinue
      Write-DaemonLog "server forced to stop pid=$serverId"
    } else {
      Write-DaemonLog "server stopped gracefully pid=$serverId"
    }
  }

  $supervisor = Get-LiveProcess -PidFile $DaemonPidFile
  if ($supervisor) {
    Stop-Process -Id $supervisor.Id -Force -ErrorAction SilentlyContinue
    Write-DaemonLog "supervisor stopped pid=$($supervisor.Id)"
  }

  Start-Sleep -Milliseconds 500
  Remove-Item -LiteralPath $ServerPidFile, $DaemonPidFile, $StopFile, $ServerStopFile -Force -ErrorAction SilentlyContinue
  Write-Host 'QianDuoDuo production supervisor stopped.'
}

function Show-Status {
  $server = Get-LiveProcess -PidFile $ServerPidFile
  $supervisor = Get-LiveProcess -PidFile $DaemonPidFile
  $healthy = Test-Health
  $task = $null
  if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }

  Write-Host 'QianDuoDuo production status'
  Write-Host "URL:        http://127.0.0.1:$Port"
  Write-Host ('Health:     {0}' -f $(if ($healthy) { 'OK' } else { 'FAIL' }))
  Write-Host ('Server:     {0}' -f $(if ($server) { "running (PID $($server.Id))" } else { 'stopped' }))
  Write-Host ('Supervisor: {0}' -f $(if ($supervisor) { "running (PID $($supervisor.Id))" } else { 'stopped' }))
  Write-Host ('Watchdog:   {0}' -f $(if ($task) { "$TaskName ($($task.State))" } else { 'not installed' }))
  Write-Host "Logs:       $LogDir"

  if (-not $healthy) {
    exit 1
  }
}

function Prune-OldLogs {
  Get-ChildItem -LiteralPath $LogDir -Filter 'server-*.out.log' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 30 |
    Remove-Item -Force -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath $LogDir -Filter 'server-*.err.log' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 30 |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

function Run-Supervisor {
  Ensure-Directories

  $existing = Get-LiveProcess -PidFile $DaemonPidFile
  if ($existing -and $existing.Id -ne $PID) {
    Write-DaemonLog "supervisor already alive pid=$($existing.Id); current pid=$PID exits"
    return
  }

  Set-Content -LiteralPath $DaemonPidFile -Value $PID -Encoding ASCII
  $env:PORT = [string]$Port
  $env:HOST = '127.0.0.1'
  $env:NODE_NO_WARNINGS = '1'
  $env:R2_STOP_FILE = $ServerStopFile
  Write-DaemonLog "supervisor started pid=$PID port=$Port root=$Root"

  $restartDelay = 2
  try {
    while (-not (Test-Path -LiteralPath $StopFile)) {
      $nodeExe = Get-NodeExe
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      $stdoutLog = Join-Path $LogDir "server-$stamp.out.log"
      $stderrLog = Join-Path $LogDir "server-$stamp.err.log"
      $startedAt = Get-Date

      Write-DaemonLog "starting node=$nodeExe stdout=$stdoutLog"
      $server = Start-Process `
        -FilePath $nodeExe `
        -ArgumentList @('--no-warnings', 'server.js') `
        -WorkingDirectory $Root `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog `
        -WindowStyle Hidden `
        -PassThru

      Set-Content -LiteralPath $ServerPidFile -Value $server.Id -Encoding ASCII
      Write-DaemonLog "server started pid=$($server.Id)"
      Prune-OldLogs

      $server.WaitForExit()
      $exitCode = $server.ExitCode
      $runSeconds = ((Get-Date) - $startedAt).TotalSeconds
      Write-DaemonLog ('server exited pid={0} code={1} after={2}s' -f $server.Id, $exitCode, [math]::Round($runSeconds, 1))
      Remove-Item -LiteralPath $ServerPidFile -Force -ErrorAction SilentlyContinue

      if (Test-Path -LiteralPath $StopFile) {
        break
      }

      if ($runSeconds -gt 60) {
        $restartDelay = 2
      } else {
        $restartDelay = [Math]::Min(60, $restartDelay * 2)
      }
      Write-DaemonLog "restarting server in $restartDelay seconds"
      Start-Sleep -Seconds $restartDelay
    }
  } finally {
    Write-DaemonLog "supervisor exiting pid=$PID"
    $server = Get-LiveProcess -PidFile $ServerPidFile
    if ($server) {
      Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $ServerPidFile -Force -ErrorAction SilentlyContinue
    $current = Get-LiveProcess -PidFile $DaemonPidFile
    if ($current -and $current.Id -eq $PID) {
      Remove-Item -LiteralPath $DaemonPidFile -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
  }
}

switch ($Action) {
  'start' {
    Start-Supervisor
  }
  'stop' {
    Stop-Supervisor
  }
  'restart' {
    Stop-Supervisor
    Start-Sleep -Seconds 1
    Start-Supervisor
  }
  'status' {
    Show-Status
  }
  'run' {
    Run-Supervisor
  }
}
