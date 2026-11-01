param(
  [ValidateSet('start', 'stop', 'restart', 'status', 'run')]
  [string]$Action = 'status',
  [int]$Port = 8765,
  [string]$Root = '',
  [int]$GracefulStopTimeoutMs = 10000,
  [int]$SupervisorExitWaitMs = 5000,
  [ValidateSet('manual', 'task-scheduler')]
  [string]$Origin = 'manual',
  [switch]$SkipAutoStart
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
$DaemonMetaFile = Join-Path $RunDir 'supervisor.json'
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

function Get-ProcessParentId {
  param([int]$ProcessId)
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($process) {
      return [int]$process.ParentProcessId
    }
  } catch {}
  return $null
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

function Start-Supervisor {
  param([string]$SupervisorOrigin = 'manual')

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
    throw "Supervisor PID $($existing.Id) is alive but the health check failed. Run npm run prod:start after checking the process."
  }

  $listenerPid = Get-ListeningProcessId
  if ($listenerPid) {
    $recordedServer = Get-LiveProcess -PidFile $ServerPidFile
    if ($recordedServer -and $recordedServer.Id -eq $listenerPid) {
      Write-DaemonLog "recovering orphan server pid=$($recordedServer.Id) after missing supervisor"
      Stop-Process -Id $recordedServer.Id -Force -ErrorAction SilentlyContinue
      for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if (-not (Get-Process -Id $recordedServer.Id -ErrorAction SilentlyContinue)) {
          break
        }
        Start-Sleep -Milliseconds 250
      }
      Remove-Item -LiteralPath $ServerPidFile -Force -ErrorAction SilentlyContinue
    } else {
      throw "Port $Port is already in use by PID $listenerPid without a recorded supervised server."
    }
  }

  Remove-Item -LiteralPath $StopFile, $ServerStopFile, $DaemonMetaFile -Force -ErrorAction SilentlyContinue

  $powerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = @(
    '-NoProfile',
    '-ExecutionPolicy Bypass',
    '-WindowStyle Hidden',
    '-File',
    ('"{0}"' -f $PSCommandPath),
    '-Action', 'run',
    '-Port', "$Port",
    '-Root', ('"{0}"' -f $Root),
    '-Origin', $SupervisorOrigin
  )

  $supervisor = Start-Process `
    -FilePath $powerShellExe `
    -ArgumentList $arguments `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -PassThru

  Set-Content -LiteralPath $DaemonPidFile -Value $supervisor.Id -Encoding ASCII
  Write-DaemonLog "supervisor launch requested pid=$($supervisor.Id) port=$Port origin=$SupervisorOrigin"

  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if (Test-Health) {
      Write-Host "QianDuoDuo is running at http://127.0.0.1:$Port"
      Write-Host "Supervisor PID: $($supervisor.Id)"
      Write-Host "Logs: $LogDir"
      return
    }
    if (-not (Get-Process -Id $supervisor.Id -ErrorAction SilentlyContinue)) {
      break
    }
    Start-Sleep -Milliseconds 500
  }

  throw "QianDuoDuo did not become healthy. Inspect $DaemonLog and $LogDir."
}

function Stop-Runtime {
  Ensure-Directories
  New-Item -ItemType File -Force -Path $StopFile | Out-Null
  New-Item -ItemType File -Force -Path $ServerStopFile | Out-Null

  $server = Get-LiveProcess -PidFile $ServerPidFile
  if ($server) {
    $serverId = $server.Id
    $serverWaitAttempts = [Math]::Max(1, [Math]::Ceiling($GracefulStopTimeoutMs / 250))
    for ($attempt = 0; $attempt -lt $serverWaitAttempts; $attempt++) {
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
    $supervisorWaitAttempts = [Math]::Max(1, [Math]::Ceiling($SupervisorExitWaitMs / 250))
    for ($attempt = 0; $attempt -lt $supervisorWaitAttempts; $attempt++) {
      if (-not (Get-Process -Id $supervisor.Id -ErrorAction SilentlyContinue)) {
        break
      }
      Start-Sleep -Milliseconds 250
    }
    $supervisor = Get-Process -Id $supervisor.Id -ErrorAction SilentlyContinue
    if ($supervisor) {
      Stop-Process -Id $supervisor.Id -Force -ErrorAction SilentlyContinue
      Write-DaemonLog "supervisor stopped pid=$($supervisor.Id)"
    }
  }

  Start-Sleep -Milliseconds 300
  Remove-Item -LiteralPath $ServerPidFile, $DaemonPidFile, $StopFile, $ServerStopFile, $DaemonMetaFile -Force -ErrorAction SilentlyContinue
}

function Stop-Supervisor {
  Stop-Runtime
  Write-Host 'QianDuoDuo production supervisor stopped.'
}

function Show-Status {
  $server = Get-LiveProcess -PidFile $ServerPidFile
  $supervisor = Get-LiveProcess -PidFile $DaemonPidFile
  $healthy = Test-Health

  Write-Host 'QianDuoDuo runtime status'
  Write-Host "URL:        http://127.0.0.1:$Port"
  Write-Host ('Health:     {0}' -f $(if ($healthy) { 'OK' } else { 'FAIL' }))
  Write-Host ('Server:     {0}' -f $(if ($server) { "running (PID $($server.Id))" } else { 'stopped' }))
  Write-Host ('Supervisor: {0}' -f $(if ($supervisor) { "running (PID $($supervisor.Id))" } else { 'stopped' }))
  if (Test-Path -LiteralPath $DaemonMetaFile) {
    try {
      $metadata = Get-Content -LiteralPath $DaemonMetaFile -Raw -Encoding UTF8 | ConvertFrom-Json
      Write-Host ('Origin:     {0}' -f $metadata.origin)
    } catch {}
  }
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
  param([string]$SupervisorOrigin = 'manual')

  Ensure-Directories

  $existing = Get-LiveProcess -PidFile $DaemonPidFile
  if ($existing -and $existing.Id -ne $PID) {
    Write-DaemonLog "supervisor already alive pid=$($existing.Id); current pid=$PID exits"
    return
  }

  Set-Content -LiteralPath $DaemonPidFile -Value $PID -Encoding ASCII
  $metadata = [ordered]@{
    pid = $PID
    parent_pid = Get-ProcessParentId -ProcessId $PID
    origin = $SupervisorOrigin
    root = $Root
    port = $Port
    started_at = (Get-Date).ToUniversalTime().ToString('o')
  }
  Write-JsonFile -Path $DaemonMetaFile -Value $metadata

  $env:PORT = [string]$Port
  $env:HOST = '127.0.0.1'
  $env:NODE_NO_WARNINGS = '1'
  $env:R2_STOP_FILE = $ServerStopFile
  Write-DaemonLog "supervisor started pid=$PID port=$Port origin=$SupervisorOrigin root=$Root"

  $restartDelay = 0
  try {
    while (-not (Test-Path -LiteralPath $StopFile)) {
      $nodeExe = Get-NodeExe
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
      $stdoutLog = Join-Path $LogDir "server-$stamp.out.log"
      $stderrLog = Join-Path $LogDir "server-$stamp.err.log"
      $startedAt = Get-Date

      Write-DaemonLog "starting node=$nodeExe stdout=$stdoutLog"
      $env:R2_SERVER_PID_FILE = $ServerPidFile
      $previousErrorActionPreference = $ErrorActionPreference
      try {
        # Native stderr is diagnostic output and must not terminate the supervisor.
        $ErrorActionPreference = 'Continue'
        & $nodeExe --no-warnings server.js 1>> $stdoutLog 2>> $stderrLog
      } finally {
        $ErrorActionPreference = $previousErrorActionPreference
      }
      $exitCode = if ($null -eq $LASTEXITCODE) { 'unknown' } else { [int]$LASTEXITCODE }
      $serverPid = if (Test-Path -LiteralPath $ServerPidFile) {
        (Get-Content -LiteralPath $ServerPidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
      } else {
        'unknown'
      }
      Prune-OldLogs

      $runSeconds = ((Get-Date) - $startedAt).TotalSeconds
      Write-DaemonLog ('server exited pid={0} code={1} after={2}s' -f $serverPid, $exitCode, [math]::Round($runSeconds, 1))
      Remove-Item -LiteralPath $ServerPidFile -Force -ErrorAction SilentlyContinue

      if (Test-Path -LiteralPath $StopFile) {
        break
      }

      if ($runSeconds -gt 60 -or $restartDelay -eq 0) {
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
      Remove-Item -LiteralPath $DaemonPidFile, $DaemonMetaFile -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
  }
}

switch ($Action) {
  'start' {
    Start-Supervisor -SupervisorOrigin $Origin
  }
  'stop' {
    Stop-Supervisor
  }
  'restart' {
    Stop-Supervisor
    Start-Sleep -Seconds 1
    Start-Supervisor -SupervisorOrigin $Origin
  }
  'status' {
    Show-Status
  }
  'run' {
    Run-Supervisor -SupervisorOrigin $Origin
  }
}
