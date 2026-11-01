param(
  [int]$Port = 18766
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$tmpRoot = Join-Path $repoRoot 'tmp'
$testRoot = Join-Path $tmpRoot 'production-host-smoke'
$taskName = 'QianDuoDuo-HostSmoke-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$hostScript = Join-Path $testRoot 'scripts\production-host.ps1'
$daemonScript = Join-Path $testRoot 'scripts\daemon.ps1'
$healthUrl = "http://127.0.0.1:$Port/api/health"
$launcherDir = Join-Path `
  ([Environment]::GetFolderPath('CommonApplicationData')) `
  'QianDuoDuoProduction'
$tickLauncher = Join-Path $launcherDir "tick-$taskName.vbs"
$tickLauncherLog = Join-Path $testRoot 'logs\launcher.log'

$resolvedTmp = [System.IO.Path]::GetFullPath($tmpRoot)
$resolvedTest = [System.IO.Path]::GetFullPath($testRoot)
if (-not $resolvedTest.StartsWith($resolvedTmp + [System.IO.Path]::DirectorySeparatorChar)) {
  throw "Refusing to clean test path outside tmp: $resolvedTest"
}
if (Test-Path -LiteralPath $resolvedTest) {
  Remove-Item -LiteralPath $resolvedTest -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $testRoot 'dist'), (Join-Path $testRoot 'scripts') | Out-Null
Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts\daemon.ps1') -Destination $daemonScript
Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts\production-host.ps1') -Destination $hostScript
Copy-Item `
  -LiteralPath (Join-Path $repoRoot 'scripts\production-bootstrap-template.vbs') `
  -Destination (Join-Path $testRoot 'scripts\production-bootstrap-template.vbs')
Set-Content -LiteralPath (Join-Path $testRoot 'dist\index.html') -Value '<html></html>' -Encoding UTF8

$serverScript = @'
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const pidFile = process.env.R2_SERVER_PID_FILE;
const stopFile = process.env.R2_STOP_FILE;
const root = process.cwd();
const countFile = path.join(root, 'run', 'server-starts.txt');
if (pidFile) fs.writeFileSync(pidFile, String(process.pid), 'ascii');
fs.mkdirSync(path.dirname(countFile), { recursive: true });
fs.appendFileSync(countFile, `${process.pid}\n`, 'utf8');

const server = http.createServer((request, response) => {
  if (request.url === '/api/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"ok":true}');
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(Number(process.env.PORT || 8765), process.env.HOST || '127.0.0.1');
const timer = setInterval(() => {
  if (stopFile && fs.existsSync(stopFile)) {
    clearInterval(timer);
    server.close(() => process.exit(0));
  }
}, 50);
'@
Set-Content -LiteralPath (Join-Path $testRoot 'server.js') -Value $serverScript -Encoding UTF8

function Invoke-HostCommand {
  param([string[]]$Arguments)
  $output = & $powershell `
    -NoProfile `
    -NonInteractive `
    -ExecutionPolicy Bypass `
    -WindowStyle Hidden `
    -File $hostScript `
    -Root $testRoot `
    -Port "$Port" `
    -TaskName $taskName `
    @Arguments 2>&1
  return [pscustomobject]@{
    exit_code = $LASTEXITCODE
    output = @($output)
  }
}

function Invoke-HostAction {
  param([string[]]$Arguments)
  $result = Invoke-HostCommand -Arguments $Arguments
  if ($result.exit_code -ne 0) {
    throw "production-host.ps1 failed: $($Arguments -join ' ')`n$($result.output -join "`n")"
  }
  return $result.output
}

function Get-HostStatus {
  $result = Invoke-HostCommand -Arguments @('-Action', 'status', '-Json')
  $lines = @($result.output | ForEach-Object { [string]$_ })
  $jsonStart = -1
  for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index] -match '^\s*\{') {
      $jsonStart = $index
      break
    }
  }
  $json = if ($jsonStart -ge 0) {
    $lines[$jsonStart..($lines.Count - 1)] -join "`n"
  } else {
    ''
  }
  if (-not $json) {
    throw "production-host.ps1 status returned no JSON`n$($result.output -join "`n")"
  }
  return $json | ConvertFrom-Json
}

function Wait-Until {
  param(
    [scriptblock]$Condition,
    [int]$TimeoutSeconds = 30,
    [string]$FailureMessage = 'condition timed out'
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (& $Condition) {
      return
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw $FailureMessage
}

function Test-Health {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Get-RuntimePids {
  $supervisorId = $null
  $serverId = $null
  $daemonPidPath = Join-Path $testRoot 'run\daemon.pid'
  $serverPidPath = Join-Path $testRoot 'run\server.pid'
  if (Test-Path -LiteralPath $daemonPidPath) {
    $supervisorId = [int](Get-Content -LiteralPath $daemonPidPath -Raw).Trim()
  }
  if (Test-Path -LiteralPath $serverPidPath) {
    $serverId = [int](Get-Content -LiteralPath $serverPidPath -Raw).Trim()
  }
  return [pscustomobject]@{
    supervisor = $supervisorId
    server = $serverId
  }
}

function Stop-ProcessElevated {
  param([int]$ProcessId)
  $arguments = @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-Command',
    "Stop-Process -Id $ProcessId -Force -ErrorAction Stop"
  )
  $process = Start-Process `
    -FilePath $powershell `
    -ArgumentList $arguments `
    -Verb RunAs `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Failed to terminate process $ProcessId (exit $($process.ExitCode))."
  }
}

$results = [ordered]@{}
$installed = $false
try {
  Write-Host '1/9 Installing a hidden current-user login task...'
  Invoke-HostAction @('-Action', 'install') | Out-Null
  $installed = $true
  Invoke-HostAction @('-Action', 'install') | Out-Null
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  if ($task.Actions[0].Execute -notmatch '\\wscript\.exe$') {
    throw "Task does not use WScript: $($task.Actions[0].Execute)"
  }
  if (@($task.Triggers).Count -ne 1) {
    throw "Expected exactly one login trigger, found $(@($task.Triggers).Count)."
  }
  if (@($task.Triggers)[0].CimClass.CimClassName -notmatch 'LogonTrigger') {
    throw 'The only task trigger is not a login trigger.'
  }
  if (-not (Test-Path -LiteralPath $tickLauncher)) {
    throw 'Hidden launcher was not generated.'
  }
  $results.install = 'ok'

  Write-Host '2/9 Migrating a healthy manual Supervisor and starting through the task...'
  $manualStart = & $powershell `
    -NoProfile `
    -NonInteractive `
    -ExecutionPolicy Bypass `
    -WindowStyle Hidden `
    -File $daemonScript `
    -Action start `
    -Root $testRoot `
    -Port "$Port" `
    -Origin manual `
    -SkipAutoStart 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Manual runtime fixture failed:`n$($manualStart -join "`n")"
  }
  $manualSupervisor = (Get-RuntimePids).supervisor
  Invoke-HostAction @('-Action', 'start') | Out-Null
  Wait-Until -Condition { Test-Health } -TimeoutSeconds 30 -FailureMessage 'Hosted production did not become healthy.'
  $status = Get-HostStatus
  if (
    -not $status.task_definition_valid -or
    -not $status.single_trigger -or
    -not $status.independent -or
    $status.supervisor_origin -ne 'task-scheduler'
  ) {
    throw 'Production host is not marked as independent with a single login trigger.'
  }
  if ($status.listener_pid -ne $status.server_pid) {
    throw 'Listening process is not bound to the supervised Server PID.'
  }
  if (-not (Test-Path -LiteralPath $tickLauncherLog)) {
    $launcherOutput = if (Test-Path -LiteralPath $tickLauncher) {
      Get-Content -LiteralPath $tickLauncher -Raw -Encoding Unicode
    } else {
      'launcher missing'
    }
    throw "Task bootstrap did not write the hidden launcher log.`n$launcherOutput"
  }
  $launcherLog = Get-Content -LiteralPath $tickLauncherLog -Raw -Encoding Unicode
  if ($launcherLog -notmatch 'start command=.*-WindowStyle Hidden' -or $launcherLog -notmatch 'exit=0') {
    throw "Task bootstrap launcher did not complete successfully.`n$launcherLog"
  }
  $initialPids = Get-RuntimePids
  if ($initialPids.supervisor -eq $manualSupervisor) {
    throw 'Manual Supervisor was not migrated to the scheduled bootstrap.'
  }
  $results.logged_in_start = 'ok'

  Write-Host '3/9 Checking duplicate starts do not create another runtime...'
  Invoke-HostAction @('-Action', 'start') | Out-Null
  $afterDuplicate = Get-RuntimePids
  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  if (
    $afterDuplicate.supervisor -ne $initialPids.supervisor -or
    $afterDuplicate.server -ne $initialPids.server -or
    $listeners.Count -ne 1
  ) {
    throw 'Duplicate start created another runtime.'
  }
  $results.duplicate_start = 'ok'

  Write-Host '4/9 Checking Supervisor restarts a crashed Node process...'
  Stop-ProcessElevated -ProcessId $initialPids.server
  Wait-Until -Condition {
    $runtime = Get-RuntimePids
    $runtime.server -and
    $runtime.server -ne $initialPids.server -and
    (Test-Health)
  } -TimeoutSeconds 30 -FailureMessage 'Supervisor did not restart the Node server.'
  $daemonLog = Get-Content -LiteralPath (Join-Path $testRoot 'logs\daemon.log') -Raw -Encoding UTF8
  if ($daemonLog -notmatch 'restarting server in [248] seconds') {
    throw 'Supervisor crash restart did not use the configured backoff path.'
  }
  $results.node_restart = 'ok'

  Write-Host '5/9 Checking prod:stop remains isolated when the login task runs...'
  Invoke-HostAction @('-Action', 'stop') | Out-Null
  if (Test-Health) {
    throw 'Health endpoint remained available after controlled stop.'
  }
  Start-ScheduledTask -TaskName $taskName
  Wait-Until -Condition {
    (Get-ScheduledTask -TaskName $taskName).State -ne 'Running'
  } -TimeoutSeconds 15 -FailureMessage 'Login task did not finish after controlled stop.'
  Start-Sleep -Seconds 2
  if (Test-Health) {
    throw 'The login task restarted production after prod:stop.'
  }
  if (-not (Get-HostStatus).stop_requested) {
    throw 'Status does not expose controlled stop intent.'
  }
  $results.stop_isolation = 'ok'

  Write-Host '6/9 Restarting production through the hidden login task...'
  Invoke-HostAction @('-Action', 'start') | Out-Null
  Wait-Until -Condition { Test-Health } -TimeoutSeconds 30 -FailureMessage 'Hosted restart failed.'
  $beforeSupervisorKill = Get-RuntimePids
  $results.restart = 'ok'

  Write-Host '7/9 Confirming there is no periodic recovery after Supervisor loss...'
  Stop-ProcessElevated -ProcessId $beforeSupervisorKill.supervisor
  Wait-Until -Condition {
    -not (Get-Process -Id $beforeSupervisorKill.supervisor -ErrorAction SilentlyContinue)
  } -TimeoutSeconds 10 -FailureMessage 'Supervisor did not terminate.'
  Start-Sleep -Seconds 3
  if (Get-Process -Id $beforeSupervisorKill.supervisor -ErrorAction SilentlyContinue) {
    throw 'A periodic recovery unexpectedly restarted the Supervisor.'
  }
  $results.no_periodic_probe = 'ok'

  Write-Host '8/9 Recovering the orphan through an explicit prod:start...'
  Invoke-HostAction @('-Action', 'start') | Out-Null
  Wait-Until -Condition { Test-Health } -TimeoutSeconds 30 -FailureMessage 'Explicit start did not recover production.'
  $recovered = Get-HostStatus
  if (-not $recovered.independent -or $recovered.supervisor_pid -eq $beforeSupervisorKill.supervisor) {
    throw 'Explicit start did not create an independent Supervisor.'
  }
  $results.explicit_recovery = 'ok'

  Write-Host '9/9 Uninstalling the login task...'
  Invoke-HostAction @('-Action', 'uninstall') | Out-Null
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    throw 'Scheduled task still exists after uninstall.'
  }
  if (Test-Health) {
    throw 'Production runtime still responds after uninstall.'
  }
  $installed = $false
  $results.uninstall = 'ok'
} finally {
  if ($installed) {
    try {
      Invoke-HostAction @('-Action', 'uninstall') | Out-Null
    } catch {}
  }
  if (Test-Path -LiteralPath $resolvedTest) {
    Remove-Item -LiteralPath $resolvedTest -Recurse -Force
  }
  Remove-Item -LiteralPath $tickLauncher -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $tickLauncherLog -Force -ErrorAction SilentlyContinue
}

$results | ConvertTo-Json -Compress
