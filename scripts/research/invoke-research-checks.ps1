param(
  [Parameter(Mandatory = $true)]
  [string]$Report,

  [string]$Assumptions,
  [string[]]$Industry = @(),
  [ValidateSet('zh', 'en', 'auto')]
  [string]$Language = 'zh',
  [switch]$SkipDcf
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$reportPath = if ([IO.Path]::IsPathRooted($Report)) { $Report } else { Join-Path $workspaceRoot $Report }
$reportPath = (Resolve-Path -LiteralPath $reportPath).Path
$assumptionPath = $null
if ($Assumptions) {
  $assumptionPath = if ([IO.Path]::IsPathRooted($Assumptions)) { $Assumptions } else { Join-Path $workspaceRoot $Assumptions }
  $assumptionPath = (Resolve-Path -LiteralPath $assumptionPath).Path
}

$python = $env:QDD_RESEARCH_PYTHON
if (-not $python) {
  $python = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
}
if (-not (Test-Path -LiteralPath $python)) {
  throw "Python not found: $python. Set QDD_RESEARCH_PYTHON to the bundled Python executable."
}

$skillScripts = Join-Path $env:USERPROFILE '.codex\skills\equity-research\scripts'
$dcfScript = Join-Path $skillScripts 'dcf.py'
$checkerScript = Join-Path $skillScripts 'check_research_output.py'
if (-not (Test-Path -LiteralPath $dcfScript) -or -not (Test-Path -LiteralPath $checkerScript)) {
  throw "equity-research skill scripts not found under: $skillScripts"
}

$oldEncoding = $env:PYTHONIOENCODING
$env:PYTHONIOENCODING = 'utf-8'
try {
  if ($assumptionPath -and -not $SkipDcf) {
    Write-Host "== dcf.py ==" -ForegroundColor Cyan
    & $python $dcfScript --config $assumptionPath
    if ($LASTEXITCODE -ne 0) { throw "dcf.py failed with exit code $LASTEXITCODE" }
  }

  Write-Host "== check_research_output.py ==" -ForegroundColor Cyan
  $checkArgs = @($checkerScript, '--report', $reportPath, '--language', $Language, '--json')
  if ($assumptionPath) { $checkArgs += @('--assumptions', $assumptionPath) }
  foreach ($item in $Industry) {
    foreach ($slug in ($item -split ',' | Where-Object { $_ })) {
      $checkArgs += @('--industry', $slug.Trim())
    }
  }
  & $python @checkArgs
  if ($LASTEXITCODE -ne 0) { throw "check_research_output.py failed with exit code $LASTEXITCODE" }
} finally {
  $env:PYTHONIOENCODING = $oldEncoding
}

Write-Host "== HTML static checks ==" -ForegroundColor Cyan
$html = Get-Content -Raw -LiteralPath $reportPath
$navScript = '<script src="../scripts/report-nav.js" defer></script>'
$withoutNav = $html.Replace($navScript, '')
if ($withoutNav -match '<script\b') { throw 'Report contains a script other than the required report-nav.js' }
if ($withoutNav -match '\bon[a-z]+\s*=') { throw 'Report contains inline event handlers' }
if ($withoutNav -match 'javascript:') { throw 'Report contains a javascript: link' }
if ($html -notmatch '<style\b') { throw 'Report is missing its own style block' }
$body = [regex]::Match($html, '<body[^>]*>([\s\S]*?)</body>', 'IgnoreCase').Groups[1].Value
if ($body.Trim().Length -lt 200) { throw 'Report body is unexpectedly empty' }

Write-Host "All research checks passed: $reportPath" -ForegroundColor Green
