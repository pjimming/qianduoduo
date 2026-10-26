param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

$sourceReportDir = Join-Path $ProjectRoot 'report'
$sourceNavPath = Join-Path $ProjectRoot 'scripts\report-nav.js'
$manifestPath = Join-Path $ProjectRoot 'src\data\stockReports.json'

foreach ($required in @($sourceReportDir, $sourceNavPath)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "缺少来源文件或目录：$required"
  }
}

$sourceReports = @(Get-ChildItem -LiteralPath $sourceReportDir -Filter '*.html' -File | Sort-Object Name)
if ($sourceReports.Count -eq 0) {
  throw "来源目录没有 HTML 报告：$sourceReportDir"
}

# report/ 是唯一报告源。本脚本只生成 Vue 报告库清单，不复制 HTML 报告或导航脚本。
$utf8 = New-Object System.Text.UTF8Encoding($false)
$navText = [System.IO.File]::ReadAllText($sourceNavPath, [System.Text.Encoding]::UTF8)

function ConvertFrom-JsString {
  param([string]$Value)
  try {
    return ('"' + $Value + '"' | ConvertFrom-Json)
  } catch {
    return ($Value -replace '\\"', '"' -replace '\\\\', '\')
  }
}

function Get-CleanText {
  param([string]$Value, [int]$MaxLength = 300)
  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
  $text = [System.Net.WebUtility]::HtmlDecode($Value)
  $text = ($text -replace '<[^>]+>', ' ')
  $text = ($text -replace '\s+', ' ').Trim()
  if ($text.Length -gt $MaxLength) {
    return $text.Substring(0, $MaxLength).TrimEnd() + '…'
  }
  return $text
}

$entryPattern = '\{\s*f:\s*"(?<f>(?:[^"\\]|\\.)*)"\s*,\s*t:\s*"(?<t>(?:[^"\\]|\\.)*)"\s*,\s*d:\s*"(?<d>[^"]*)"(?:\s*,\s*p:\s*"(?<p>[^"]*)")?\s*,\s*g:\s*"(?<g>(?:[^"\\]|\\.)*)"\s*,\s*s:\s*"(?<s>(?:[^"\\]|\\.)*)"\s*,\s*k:\s*"(?<k>(?:[^"\\]|\\.)*)"\s*\}'
$navIndex = @{}
$navMatches = [regex]::Matches(
  $navText,
  $entryPattern,
  [System.Text.RegularExpressions.RegexOptions]::Singleline
)
foreach ($match in $navMatches) {
  $file = ConvertFrom-JsString $match.Groups['f'].Value
  $navIndex[$file] = [pscustomobject]@{
    title    = ConvertFrom-JsString $match.Groups['t'].Value
    date     = $match.Groups['d'].Value
    publishedAt = $match.Groups['p'].Value
    category = ConvertFrom-JsString $match.Groups['g'].Value
    summary  = ConvertFrom-JsString $match.Groups['s'].Value
    keywords = ConvertFrom-JsString $match.Groups['k'].Value
  }
}

function Get-FallbackCategory {
  param([string]$FileName)
  $rules = @(
    @{ Pattern = '军工|兵装|航空|船舶|航发|导弹'; Category = '军工国防' },
    @{ Pattern = 'AI短剧|传媒|IP'; Category = 'AI/传媒' },
    @{ Pattern = '半导体|富乐德'; Category = '半导体设备' },
    @{ Pattern = '覆铜板|电子材料|天通|四会'; Category = '电子材料' },
    @{ Pattern = '电力|电缆|远东|杭电'; Category = '电力设备' },
    @{ Pattern = '消费电子|博硕'; Category = '消费电子' },
    @{ Pattern = '算力|行云'; Category = 'AI算力' }
  )
  foreach ($rule in $rules) {
    if ($FileName -match $rule.Pattern) { return $rule.Category }
  }
  return '其他'
}

$records = New-Object System.Collections.Generic.List[object]

foreach ($report in $sourceReports) {
  $html = [System.IO.File]::ReadAllText($report.FullName, [System.Text.Encoding]::UTF8)
  $nav = $navIndex[$report.Name]

  $titleMatch = [regex]::Match($html, '<title>(?<v>.*?)</title>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
  $title = Get-CleanText $titleMatch.Groups['v'].Value 160
  if ([string]::IsNullOrWhiteSpace($title)) {
    $title = [System.IO.Path]::GetFileNameWithoutExtension($report.Name)
  }
  if ($nav -and -not [string]::IsNullOrWhiteSpace($nav.title) -and $title -match '\d{4}-\d{2}-\d{2}') {
    # 报告 <title> 通常带日期；卡片标题使用导航中的简洁标题，日期单独展示。
    $title = Get-CleanText $nav.title 160
  }

  $dateMatch = [regex]::Match($report.Name, '(?<d>\d{4}-\d{2}-\d{2})\.html$')
  $date = if ($dateMatch.Success) { $dateMatch.Groups['d'].Value } elseif ($nav) { $nav.date } else { $report.LastWriteTime.ToString('yyyy-MM-dd') }
  $publishedMatch = [regex]::Match($html, '<!--\s*rpnav-published:\s*(?<v>\d{4}-\d{2}-\d{2}(?:[ T])\d{2}:\d{2}(?::\d{2})?)\s*-->', [System.Text.RegularExpressions.RegexOptions]::Singleline)
  $publishedAt = if ($publishedMatch.Success) {
    $publishedMatch.Groups['v'].Value.Replace('T', ' ').Substring(0, 16)
  } elseif ($nav -and -not [string]::IsNullOrWhiteSpace($nav.publishedAt)) {
    $nav.publishedAt
  } else {
    $report.LastWriteTime.ToString('yyyy-MM-dd HH:mm')
  }

  $tagMatch = [regex]::Match($html, '<!--\s*rpnav-tag:\s*(?<v>.*?)\s*-->', [System.Text.RegularExpressions.RegexOptions]::Singleline)
  $category = Get-CleanText $tagMatch.Groups['v'].Value 40
  if ([string]::IsNullOrWhiteSpace($category) -and $nav) { $category = Get-CleanText $nav.category 40 }
  if ([string]::IsNullOrWhiteSpace($category)) { $category = Get-FallbackCategory $report.Name }

  $summaryMatch = [regex]::Match($html, '<!--\s*rpnav-summary:\s*(?<v>.*?)\s*-->', [System.Text.RegularExpressions.RegexOptions]::Singleline)
  $summary = Get-CleanText $summaryMatch.Groups['v'].Value 300
  if ([string]::IsNullOrWhiteSpace($summary)) {
    $summaryMatch = [regex]::Match($html, '<p class="sub">(?<v>.*?)</p>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    $summary = Get-CleanText $summaryMatch.Groups['v'].Value 300
  }
  if ([string]::IsNullOrWhiteSpace($summary)) {
    $summaryMatch = [regex]::Match($html, '<p class="one-liner">(?<v>.*?)</p>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    $summary = Get-CleanText $summaryMatch.Groups['v'].Value 300
  }
  if ([string]::IsNullOrWhiteSpace($summary) -and $nav) { $summary = Get-CleanText $nav.summary 300 }

  $keywords = ''
  if ($nav) { $keywords = Get-CleanText $nav.keywords 6000 }
  if ([string]::IsNullOrWhiteSpace($keywords)) {
    $headings = [regex]::Matches($html, '<h[23][^>]*>(?<v>.*?)</h[23]>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    $keywords = (($headings | ForEach-Object { Get-CleanText $_.Groups['v'].Value 80 }) | Select-Object -First 80) -join ' / '
  }

  $priority = $null
  $priorityDetail = $null
  $priorityMetaMatch = [regex]::Match($html, '<!--\s*rpnav-priority:\s*(?<v>.*?)\s*-->', [System.Text.RegularExpressions.RegexOptions]::Singleline)
  $priorityDetailMetaMatch = [regex]::Match($html, '<!--\s*rpnav-priority-detail:\s*(?<v>.*?)\s*-->', [System.Text.RegularExpressions.RegexOptions]::Singleline)
  if ($priorityMetaMatch.Success) {
    $priority = Get-CleanText $priorityMetaMatch.Groups['v'].Value 12
  }
  if ($priorityDetailMetaMatch.Success) {
    $priorityDetail = Get-CleanText $priorityDetailMetaMatch.Groups['v'].Value 120
  }
  if ([string]::IsNullOrWhiteSpace($priorityDetail)) {
    $verdictMatch = [regex]::Match($html, '<span class="verdict">(?<v>.*?)</span>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if ($verdictMatch.Success) {
      $priorityDetail = Get-CleanText $verdictMatch.Groups['v'].Value 120
    } else {
      $priorityMatch = [regex]::Match($html, '研究优先级[：:]\s*(?<v>[^<\r\n]{1,60})', [System.Text.RegularExpressions.RegexOptions]::Singleline)
      if ($priorityMatch.Success) { $priorityDetail = Get-CleanText ('研究优先级：' + $priorityMatch.Groups['v'].Value) 120 }
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($priorityDetail)) {
    if ([string]::IsNullOrWhiteSpace($priority)) {
      $label = $priorityDetail -replace '^研究优先级[：:]\s*', ''
      $label = ($label -split '[（(，,。；;]')[0].Trim()
      if ($label.Length -gt 12) { $label = $label.Substring(0, 12) }
      if (-not [string]::IsNullOrWhiteSpace($label)) { $priority = $label }
    }
  } elseif (-not [string]::IsNullOrWhiteSpace($priority)) {
    $priorityDetail = '研究优先级：' + $priority
  }

  $records.Add([ordered]@{
    file           = $report.Name
    slug           = [System.IO.Path]::GetFileNameWithoutExtension($report.Name)
    title          = $title
    date           = $date
    publishedAt    = $publishedAt
    category       = $category
    summary        = $summary
    keywords       = $keywords
    priority       = $priority
    priorityDetail = $priorityDetail
  })
}

$sorted = @(
  $records |
    Sort-Object -Property `
      @{ Expression = { $_.publishedAt }; Descending = $true },
      @{ Expression = { $_.date }; Descending = $true },
      @{ Expression = { $_.title }; Descending = $false }
)
$manifest = [ordered]@{
  generatedAt = (Get-Date -Format 'yyyy-MM-dd HH:mm')
  source      = 'report'
  count       = $sorted.Count
  reports     = $sorted
}

$json = $manifest | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($manifestPath, $json, $utf8)

Write-Host ("已从 report/ 生成 {0} 篇报告清单 -> {1}" -f $sorted.Count, $manifestPath)
