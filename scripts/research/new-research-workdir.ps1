param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[\p{L}\p{N}._-]+$')]
  [string]$Slug,

  [ValidateSet('company', 'etf', 'theme')]
  [string]$Kind = 'company'
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$researchRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'tmp\research'))
$workdir = [IO.Path]::GetFullPath((Join-Path $researchRoot $Slug))
$researchPrefix = $researchRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

if (-not $workdir.StartsWith($researchPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to create outside tmp/research: $workdir"
}
if (Test-Path -LiteralPath $workdir) {
  throw "Research workdir already exists: $workdir"
}

New-Item -ItemType Directory -Path $workdir -Force | Out-Null
$templateName = if ($Kind -eq 'company') { 'dcf-company.template.json' } else { 'dcf-etf.template.json' }
$templatePath = Join-Path $PSScriptRoot "templates\$templateName"
if (-not (Test-Path -LiteralPath $templatePath)) {
  throw "Template not found: $templatePath"
}

Copy-Item -LiteralPath $templatePath -Destination (Join-Path $workdir 'assignments.json')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'templates\research-manifest.template.json') -Destination (Join-Path $workdir 'manifest.json')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'templates\sources.template.csv') -Destination (Join-Path $workdir 'sources.csv')

$manifestPath = Join-Path $workdir 'manifest.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$manifest.slug = $Slug
$manifest.reportType = $Kind
$manifest.paths.assumptions = "tmp/research/$Slug/assignments.json"
$manifest.paths.sourceRegister = "tmp/research/$Slug/sources.csv"
$manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath -Encoding utf8

Write-Output "Created research workdir: $workdir"
Write-Output "Template: $templateName"
Write-Output "Next: edit assignments.json, manifest.json and sources.csv; clean before publish."
