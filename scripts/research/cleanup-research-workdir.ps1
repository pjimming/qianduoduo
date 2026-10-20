param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[\p{L}\p{N}._-]+$')]
  [string]$Slug
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$researchRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'tmp\research'))
$target = [IO.Path]::GetFullPath((Join-Path $researchRoot $Slug))
$researchPrefix = $researchRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

function Remove-EmptyResearchRoot {
  if (Test-Path -LiteralPath $researchRoot) {
    $remaining = Get-ChildItem -LiteralPath $researchRoot -Force
    if ($remaining.Count -eq 0) {
      [IO.Directory]::Delete($researchRoot, $false)
    }
  }
}

if (-not $target.StartsWith($researchPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to remove outside tmp/research: $target"
}
if (-not (Test-Path -LiteralPath $target)) {
  Remove-EmptyResearchRoot
  Write-Output "Nothing to remove: $target"
  exit 0
}

Remove-Item -LiteralPath $target -Recurse -Force
Remove-EmptyResearchRoot
Write-Output "Removed research workdir: $target"
