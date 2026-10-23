param(
  [int]$Port = 18765
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$tmpRoot = Join-Path $repoRoot 'tmp'
$testRoot = Join-Path $tmpRoot 'daemon-exit-smoke'
$daemonSource = Join-Path $repoRoot 'scripts\daemon.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$resolvedTmp = [System.IO.Path]::GetFullPath($tmpRoot)
$resolvedTest = [System.IO.Path]::GetFullPath($testRoot)
if (-not $resolvedTest.StartsWith($resolvedTmp + [System.IO.Path]::DirectorySeparatorChar)) {
  throw "Refusing to clean test path outside tmp: $resolvedTest"
}
if (Test-Path -LiteralPath $resolvedTest) {
  Remove-Item -LiteralPath $resolvedTest -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $testRoot 'dist'), (Join-Path $testRoot 'scripts') | Out-Null
Copy-Item -LiteralPath $daemonSource -Destination (Join-Path $testRoot 'scripts\daemon.ps1')
Set-Content -LiteralPath (Join-Path $testRoot 'dist\index.html') -Value '<html></html>' -Encoding UTF8

$serverScript = @'
const fs = require('node:fs');
const http = require('node:http');
const mode = process.env.QDD_SMOKE_MODE || 'graceful';
const pidFile = process.env.R2_SERVER_PID_FILE;
const stopFile = process.env.R2_STOP_FILE;
if (pidFile) fs.writeFileSync(pidFile, String(process.pid), 'ascii');
if (mode === 'crash') {
  setTimeout(() => process.exit(17), 300);
} else {
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
    if (mode !== 'hang' && stopFile && fs.existsSync(stopFile)) {
      clearInterval(timer);
      server.close(() => process.exit(0));
    }
  }, 50);
}
'@
Set-Content -LiteralPath (Join-Path $testRoot 'server.js') -Value $serverScript -Encoding UTF8

function Invoke-Daemon {
  param([string[]]$Arguments)
  & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $testRoot 'scripts\daemon.ps1') @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "daemon.ps1 failed: $($Arguments -join ' ')"
  }
}

function Read-DaemonLog {
  return Get-Content -LiteralPath (Join-Path $testRoot 'logs\daemon.log') -Encoding UTF8 -Raw
}

$results = @{}
$savedMode = $env:QDD_SMOKE_MODE
try {
  $env:QDD_SMOKE_MODE = 'graceful'
  Invoke-Daemon @('-Action', 'start', '-Port', "$Port", '-Root', $testRoot)
  Invoke-Daemon @(
    '-Action', 'stop',
    '-Port', "$Port",
    '-Root', $testRoot,
    '-GracefulStopTimeoutMs', '1000',
    '-SupervisorExitWaitMs', '2000'
  )
  $log = Read-DaemonLog
  if ($log -notmatch 'server exited pid=\d+ code=0 ') {
    throw 'graceful exit code was not recorded as 0'
  }
  $results.graceful = 0

  Remove-Item -LiteralPath (Join-Path $testRoot 'logs') -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $testRoot 'run') -Recurse -Force -ErrorAction SilentlyContinue
  $env:QDD_SMOKE_MODE = 'crash'
  $runProcess = Start-Process `
    -FilePath $powershell `
    -ArgumentList @(
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', (Join-Path $testRoot 'scripts\daemon.ps1'),
      '-Action', 'run',
      '-Port', "$Port",
      '-Root', $testRoot
    ) `
    -WorkingDirectory $testRoot `
    -WindowStyle Hidden `
    -PassThru
  $crashLogged = $false
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 100
    if (
      (Test-Path -LiteralPath (Join-Path $testRoot 'logs\daemon.log')) -and
      ((Read-DaemonLog) -match 'server exited pid=\d+ code=17 ')
    ) {
      $crashLogged = $true
      break
    }
  }
  New-Item -ItemType File -Force -Path (Join-Path $testRoot 'run\daemon.stop') | Out-Null
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (-not (Get-Process -Id $runProcess.Id -ErrorAction SilentlyContinue)) {
      break
    }
    Start-Sleep -Milliseconds 100
  }
  if (Get-Process -Id $runProcess.Id -ErrorAction SilentlyContinue) {
    Stop-Process -Id $runProcess.Id -Force -ErrorAction SilentlyContinue
  }
  if (-not $crashLogged) {
    throw 'normal crash exit code was not recorded as 17'
  }
  $results.crash = 17

  Remove-Item -LiteralPath (Join-Path $testRoot 'logs') -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $testRoot 'run') -Recurse -Force -ErrorAction SilentlyContinue
  $env:QDD_SMOKE_MODE = 'hang'
  Invoke-Daemon @('-Action', 'start', '-Port', "$Port", '-Root', $testRoot)
  Invoke-Daemon @(
    '-Action', 'stop',
    '-Port', "$Port",
    '-Root', $testRoot,
    '-GracefulStopTimeoutMs', '300',
    '-SupervisorExitWaitMs', '2000'
  )
  $log = Read-DaemonLog
  if ($log -notmatch 'server exited pid=\d+ code=-?\d+ ') {
    throw 'forced termination exit code was not recorded'
  }
  $results.forced = [int]([regex]::Match($log, 'server exited pid=\d+ code=(-?\d+) ').Groups[1].Value)
} finally {
  $env:QDD_SMOKE_MODE = $savedMode
  try {
    & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $testRoot 'scripts\daemon.ps1') -Action stop -Port $Port -Root $testRoot -GracefulStopTimeoutMs 300 -SupervisorExitWaitMs 1000
  } catch {}
  if (Test-Path -LiteralPath $resolvedTest) {
    Remove-Item -LiteralPath $resolvedTest -Recurse -Force
  }
}

$results | ConvertTo-Json -Compress
