# PID files survive logoff; a live PID alone does not identify our runtime.
function Get-QddRuntimeProcess {
  param(
    [string]$PidFile,
    [ValidateSet('supervisor', 'server')][string]$Role,
    [string]$Root,
    [int]$Port
  )
  try {
    $raw = Get-Content -LiteralPath $PidFile -ErrorAction Stop | Select-Object -First 1
    $runtimeId = 0
    if (-not [int]::TryParse([string]$raw, [ref]$runtimeId) -or $runtimeId -le 0) { return $null }
    $info = Get-CimInstance Win32_Process -Filter "ProcessId = $runtimeId" -ErrorAction Stop
    if (-not $info) { return $null }
    $command = [string]$info.CommandLine
    if ($Role -eq 'supervisor') {
      if ($info.Name -notmatch '^(powershell|pwsh)\.exe$') { return $null }
      # Unelevated callers cannot read elevated task command lines. Bind those
      # instances to the process creation timestamp saved by the supervisor.
      if (-not $command) {
        $metadata = Get-Content -LiteralPath (Join-Path $Root 'run\supervisor.json') -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json
        if ([int]$metadata.pid -ne $runtimeId -or $metadata.root -ne $Root -or [int]$metadata.port -ne $Port) { return $null }
        if (-not $metadata.process_started_at) { return $null }
        $recordedStart = ([datetime]$metadata.process_started_at).ToUniversalTime()
        if ([Math]::Abs(($recordedStart - $info.CreationDate.ToUniversalTime()).TotalSeconds) -gt 0.01) { return $null }
      } else {
        $daemonPath = [regex]::Escape((Join-Path $Root 'scripts\daemon.ps1'))
        $rootPath = [regex]::Escape($Root)
        if (
          $command -notmatch ('(?:^|\s)-File\s+(?:"{0}"|{0})(?=\s|$)' -f $daemonPath) -or
          $command -notmatch '(?:^|\s)-Action\s+run(?=\s|$)' -or
          $command -notmatch ('(?:^|\s)-Root\s+(?:"{0}"|{0})(?=\s|$)' -f $rootPath) -or
          $command -notmatch ('(?:^|\s)-Port\s+{0}(?=\s|$)' -f $Port)
        ) { return $null }
      }
    } else {
      if ($info.Name -ne 'node.exe' -or ($command -and $command -notmatch '(?:^|\s)(?:"server\.js"|server\.js)(?=\s|$)')) { return $null }
      $metadata = Get-Content -LiteralPath (Join-Path $Root 'run\supervisor.json') -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json
      if ($metadata.root -ne $Root -or [int]$metadata.port -ne $Port -or [int]$metadata.pid -ne [int]$info.ParentProcessId) { return $null }
      $writeDelay = ((Get-Item -LiteralPath $PidFile).LastWriteTimeUtc - $info.CreationDate.ToUniversalTime()).TotalSeconds
      if ($writeDelay -lt 0 -or $writeDelay -gt 30) { return $null }
    }
    $process = Get-Process -Id $runtimeId -ErrorAction Stop
    if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $info.CreationDate.ToUniversalTime()).TotalSeconds) -gt 0.01) { return $null }
    return $process
  } catch { return $null }
}
