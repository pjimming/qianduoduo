<#
============================================================================
 update-nav.ps1 — 重新生成 scripts/report-nav.js 中的报告清单
----------------------------------------------------------------------------
 作用：扫描工作区 report/ 下的 *.html 报告，读取每篇的 <title>、从文件名解析日期、
       读取发布时间并按关键词推断标签，然后重写 scripts/report-nav.js 里
       //>NAV:BEGIN … //>NAV:END 之间的清单区块。

 为什么这样做：报告导航必须"新增报告时不用逐篇修改既有报告"。
       因此清单集中在 report-nav.js 一处，各报告只引用同一行 <script>。

 用法（在工作区根目录执行）：
       pwsh -NoProfile -File .\scripts\update-nav.ps1
       或指定工作区：pwsh -NoProfile -File .\scripts\update-nav.ps1 -Dir "D:\codex\钱多多财富工作台"

 注意：本脚本只改 report-nav.js，不会改动任何报告 HTML。
============================================================================
#>
[CmdletBinding()]
param(
    [string]$Dir = (Split-Path -Parent $PSScriptRoot),
    [string]$ReportDir = "report",
    [string]$NavFile = "scripts/report-nav.js",
    [string]$IndexFile = "index.html",
    [string[]]$Exclude = @()
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Dir)) { $Dir = (Get-Location).Path }
$Dir = (Resolve-Path -LiteralPath $Dir).Path
$reportPath = Join-Path $Dir $ReportDir
$navPath = Join-Path $Dir $NavFile

if (-not (Test-Path -LiteralPath $reportPath)) {
    throw "找不到报告目录：$reportPath"
}
if (-not (Test-Path -LiteralPath $navPath)) {
    throw "找不到导航文件：$navPath（请先创建 scripts/report-nav.js）"
}
$reportPath = (Resolve-Path -LiteralPath $reportPath).Path

$BEGIN      = "//>NAV:BEGIN"
$END        = "//>NAV:END"
$META_BEGIN = "//>META:BEGIN"
$META_END   = "//>META:END"

# 文件名/标题关键词 -> 分类标签。命中第一个即用；未命中记为“其他”。
$TagMap = [ordered]@{
    "军工" = "军工国防"; "航空" = "军工国防"; "船舶" = "军工国防"
    "导弹" = "军工国防"; "国防" = "军工国防"; "航发" = "军工国防"
    "AI"   = "AI/传媒";  "短剧" = "AI/传媒";  "传媒" = "AI/传媒"
    "半导体" = "半导体"; "芯片" = "半导体";    "算力" = "半导体"
    "覆铜板" = "电子材料"; "PCB" = "电子材料"; "材料" = "电子材料"
    "机器人" = "高端制造"; "光伏" = "新能源";  "锂" = "新能源"
}

function Get-ReportDate {
    param([string]$FileName, [datetime]$Fallback)
    # 取文件名中最后一个 YYYY-MM-DD
    $ms = [regex]::Matches($FileName, '\d{4}-\d{2}-\d{2}')
    if ($ms.Count -gt 0) {
        $last = $ms[$ms.Count - 1].Value
        $parsed = [datetime]::MinValue
        if ([datetime]::TryParseExact($last, "yyyy-MM-dd",
                [System.Globalization.CultureInfo]::InvariantCulture,
                [System.Globalization.DateTimeStyles]::None, [ref]$parsed)) {
            return $parsed.ToString("yyyy-MM-dd")
        }
    }
    return $Fallback.ToString("yyyy-MM-dd")
}

function Get-ReportTag {
    param([string]$Text)
    foreach ($k in $TagMap.Keys) {
        if ($Text -like "*$k*") { return $TagMap[$k] }
    }
    return "其他"
}

function ConvertTo-JsString {
    param([string]$Text)
    $t = [string]$Text
    $t = $t -replace '\r?\n', ' '
    $t = $t -replace '\\', '\\\\'
    $t = $t -replace '"', '\"'
    return $t.Trim()
}

function ConvertFrom-JsString {
    param([string]$Text)
    try {
        return ('"' + $Text + '"' | ConvertFrom-Json)
    } catch {
        return ($Text -replace '\\"', '"' -replace '\\\\', '\')
    }
}

function Get-Override {
    param([string]$Raw, [string]$Key)
    # 报告内可写 <!-- rpnav-tag: 军工国防 --> 或 <!-- rpnav-title: 自定义标题 -->
    # 来显式指定，无需修改本脚本。用于关键词推断不到的场合。
    $m = [regex]::Match($Raw, "(?is)<!--\s*rpnav-$Key\s*:\s*(.*?)\s*-->")
    if ($m.Success) { return $m.Groups[1].Value.Trim() }
    return ""
}

function ConvertTo-ReportPublishedAt {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
    $formats = @(
        "yyyy-MM-dd HH:mm",
        "yyyy-MM-dd HH:mm:ss",
        "yyyy-MM-ddTHH:mm",
        "yyyy-MM-ddTHH:mm:ss"
    )
    foreach ($format in $formats) {
        $parsed = [datetime]::MinValue
        if ([datetime]::TryParseExact(
                $Value.Trim(),
                $format,
                [System.Globalization.CultureInfo]::InvariantCulture,
                [System.Globalization.DateTimeStyles]::None,
                [ref]$parsed)) {
            return $parsed.ToString("yyyy-MM-dd HH:mm")
        }
    }
    return ""
}

function Get-ReportPublishedAt {
    param([string]$Raw, [datetime]$Fallback, [string]$Existing = "")

    # 显式发布时间（推荐）：<!-- rpnav-published: 2026-10-21 00:02 -->
    $explicit = ConvertTo-ReportPublishedAt (Get-Override -Raw $Raw -Key "published")
    if (-not [string]::IsNullOrWhiteSpace($explicit)) { return $explicit }

    # 缺少新注释时沿用已生成清单中的发布时间，避免新机器检出后文件 mtime 全部变化。
    $previous = ConvertTo-ReportPublishedAt $Existing
    if (-not [string]::IsNullOrWhiteSpace($previous)) { return $previous }

    return $Fallback.ToString("yyyy-MM-dd HH:mm")
}

function Clear-TitleNoise {
    param([string]$Text)
    $t = [string]$Text
    $t = $t -replace '\s*[|｜]\s*\d{4}-\d{2}-\d{2}\s*$', ''          # … | 2026-10-16
    $t = $t -replace '\s*[·•‧]\s*\d{4}-\d{2}-\d{2}\s*$', ''          # … · 2026-09-29
    $t = $t -replace '\s*[（(]\s*\d{4}-\d{2}-\d{2}\s*[）)]\s*$', ''  # …（2026-10-16）
    $t = $t -replace '\s*[|｜·•]\s*$', ''
    return $t.Trim()
}

function ConvertFrom-Html {
    param([string]$Text)
    $t = [string]$Text
    $t = $t -replace '(?s)<[^>]+>', ''     # 先剥标签，再解实体（顺序不能反）
    $t = $t -replace '&nbsp;', ' '
    $t = $t -replace '&lt;', '<'
    $t = $t -replace '&gt;', '>'
    $t = $t -replace '&quot;', '"'
    $t = $t -replace '&#39;', "'"
    $t = $t -replace '&amp;', '&'
    $t = $t -replace '\s+', ' '
    return $t.Trim()
}

function Get-ReportSummary {
    param([string]$Raw, [int]$Max = 96)

    # 1) 显式覆盖：<!-- rpnav-summary: … -->
    $o = Get-Override -Raw $Raw -Key "summary"
    if (-not [string]::IsNullOrWhiteSpace($o)) { return $o }

    # 2) 报告头部的副标题 <p class="sub">…</p>（本工作区报告的标准写法）
    $plain = ""
    $m = [regex]::Match($Raw, '(?is)<p[^>]*class="[^"]*\bsub\b[^"]*"[^>]*>(.*?)</p>')
    if ($m.Success) {
        $plain = ConvertFrom-Html -Text $m.Groups[1].Value
    } else {
        # 3) 退而求其次：第一个足够长的正文段落
        foreach ($x in [regex]::Matches($Raw, '(?is)<p[^>]*>(.*?)</p>')) {
            $cand = ConvertFrom-Html -Text $x.Groups[1].Value
            if ($cand.Length -ge 40) { $plain = $cand; break }
        }
    }
    if ([string]::IsNullOrWhiteSpace($plain)) { return "" }
    if ($plain.Length -gt $Max) { $plain = $plain.Substring(0, $Max).TrimEnd() + "…" }
    return $plain
}

function Set-MarkedBlock {
    # 把 $Text 中 $Begin … $End 之间的内容替换为 $Body（保留标记行本身）
    param([string]$Text, [string]$Begin, [string]$End, [string[]]$Body,
          [string]$Indent = "    ")
    $b = $Text.IndexOf($Begin)
    $e = $Text.IndexOf($End)
    if ($b -lt 0 -or $e -lt 0 -or $e -lt $b) {
        throw "在目标文件中找不到标记 $Begin / $End"
    }
    return $Text.Substring(0, $b + $Begin.Length) + "`r`n" +
           ($Body -join "`r`n") + "`r`n" + $Indent + $Text.Substring($e)
}

function Get-ReportKeywords {
    # 抽取报告的小节标题作为“可检索关键词”，让首页搜索能命中正文里的
    # 公司名/主题（例如“内蒙一机”），但不占用卡片显示空间。
    # 关键词只用于搜索、不参与显示，因此尽量多收：覆盖到公司名/主题级小节标题
    param([string]$Raw, [int]$MaxChars = 2800)

    $o = Get-Override -Raw $Raw -Key "keywords"
    if (-not [string]::IsNullOrWhiteSpace($o)) { return $o }

    $parts = New-Object System.Collections.ArrayList

    # 第一优先：表格每行首列通常就是标的/公司名（本工作区报告的写法），
    # 检索价值最高，先占预算，避免被通用小节标题挤掉。
    $cellStop = @('公司','代码','指标','期间','日期','时间','项目','名称','环节',
                  '层级','维度','子公司','类别','序号','股票','板块','标的','年份',
                  '证券','说明','参数','口径','要点','来源','状态')
    foreach ($x in [regex]::Matches($Raw, '(?is)<tr[^>]*>\s*<t[dh][^>]*>(.*?)</t[dh]>')) {
        $t = ConvertFrom-Html -Text $x.Groups[1].Value
        if ([string]::IsNullOrWhiteSpace($t)) { continue }
        # 长单元格（如一行列多家公司）按分隔符拆开，逐段收取
        $frags = if ($t.Length -gt 24) { $t -split '\s*[/、,，]\s*' } else { @($t) }
        foreach ($fr in $frags) {
            $fr = $fr.Trim()
            if ($fr.Length -lt 2 -or $fr.Length -gt 24) { continue }
            if ($cellStop -contains $fr) { continue }
            if ($fr -match '^[\d\.,\-—%+（）()]+$') { continue }
            if (-not $parts.Contains($fr)) { [void]$parts.Add($fr) }
        }
        if ($parts.Count -ge 55) { break }
    }

    # 第二优先：小节标题（主题级）。通用标题（目录、反方理由之类）不含标的特征，跳过
    $generic = @('目录','先说判断','研究优先级','反方理由','下一步','资料范围',
                 '结论','风险','附录','免责','小结','概览','方法论','数据来源',
                 '证据','比较与','如何','背景','导读','摘要')

    foreach ($x in [regex]::Matches($Raw, '(?is)<h[23][^>]*>(.*?)</h[23]>')) {
        $t = ConvertFrom-Html -Text $x.Groups[1].Value
        if ([string]::IsNullOrWhiteSpace($t)) { continue }
        $t = $t -replace '^\s*\d+(\.\d+)*\s*', ''      # 去掉 “01 ”“2.1 ” 之类编号
        if ([string]::IsNullOrWhiteSpace($t)) { continue }

        $skip = $false
        foreach ($g in $generic) { if ($t -match [regex]::Escape($g)) { $skip = $true; break } }
        if ($skip) { continue }

        if (-not $parts.Contains($t)) { [void]$parts.Add($t) }
        if ($parts.Count -ge 95) { break }
    }

    if ($parts.Count -eq 0) { return "" }

    $s = ($parts -join ' / ')
    if ($s.Length -gt $MaxChars) {
        $s = $s.Substring(0, $MaxChars)
        $cut = $s.LastIndexOf(' / ')
        if ($cut -gt 0) { $s = $s.Substring(0, $cut) }
    }
    return $s.Trim()
}

$navRaw = Get-Content -LiteralPath $navPath -Raw -Encoding UTF8
$existingPublished = @{}
$existingEntryPattern = '(?m)^\s*\{\s*f:\s*"(?<f>(?:[^"\\]|\\.)*)"(?<rest>[^\r\n]*)\}\s*$'
foreach ($match in [regex]::Matches($navRaw, $existingEntryPattern)) {
    $publishedMatch = [regex]::Match($match.Groups['rest'].Value, ',\s*p:\s*"(?<p>[^"]*)"')
    if ($publishedMatch.Success) {
        $file = ConvertFrom-JsString $match.Groups['f'].Value
        $existingPublished[$file] = $publishedMatch.Groups['p'].Value
    }
}

$rows = New-Object System.Collections.ArrayList
$scanned = 0

foreach ($f in (Get-ChildItem -LiteralPath $reportPath -Filter *.html -File | Sort-Object Name)) {
    if ($Exclude -contains $f.Name) { continue }
    if ($f.Name -eq $IndexFile) { continue }        # 首页不是报告
    if ($f.Name.StartsWith("_")) { continue }       # 下划线前缀 = 临时/测试文件
    $scanned++

    $raw = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) { continue }
    if ($raw -notmatch "(?is)<body") { continue }   # 不是一篇完整报告就跳过

    # --- 标题（可被 <!-- rpnav-title: … --> 覆盖）---
    $title = Get-Override -Raw $raw -Key "title"
    if ([string]::IsNullOrWhiteSpace($title)) {
        $m = [regex]::Match($raw, "(?is)<title>(.*?)</title>")
        if ($m.Success) { $title = $m.Groups[1].Value.Trim() }
        if ([string]::IsNullOrWhiteSpace($title)) {
            $title = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
        } else {
            $title = Clear-TitleNoise -Text $title
        }
    }

    $date = Get-ReportDate -FileName $f.Name -Fallback $f.LastWriteTime
    $publishedAt = Get-ReportPublishedAt -Raw $raw -Fallback $f.LastWriteTime -Existing $existingPublished[$f.Name]

    # --- 标签（可被 <!-- rpnav-tag: … --> 覆盖）---
    $tag = Get-Override -Raw $raw -Key "tag"
    if ([string]::IsNullOrWhiteSpace($tag)) {
        $tag = Get-ReportTag -Text ($f.Name + " " + $title)
    }

    # --- 摘要（首页卡片用；可被 <!-- rpnav-summary: … --> 覆盖）---
    $summary = Get-ReportSummary -Raw $raw

    # --- 关键词（首页搜索用；可被 <!-- rpnav-keywords: … --> 覆盖）---
    $keywords = Get-ReportKeywords -Raw $raw

    [void]$rows.Add([pscustomobject]@{
        File     = $f.Name
        Title    = $title
        Date     = $date
        PublishedAt = $publishedAt
        Tag      = $tag
        Summary  = $summary
        Keywords = $keywords
    })
}

# 排序：发布时间倒序；同一时刻再按调研日期和标题稳定排序
$ordered = $rows | Sort-Object @{Expression = "PublishedAt"; Descending = $true },
                                 @{Expression = "Date"; Descending = $true },
                                 @{Expression = "Title"; Descending = $false }

$lines = @()
foreach ($r in $ordered) {
    $line = '    { f: "' + (ConvertTo-JsString $r.File) + '", t: "' +
            (ConvertTo-JsString $r.Title) + '", d: "' + $r.Date +
            '", p: "' + $r.PublishedAt +
            '", g: "' + (ConvertTo-JsString $r.Tag) + '", s: "' +
            (ConvertTo-JsString $r.Summary) + '"'
    if (-not [string]::IsNullOrWhiteSpace($r.Keywords)) {
        $line += ', k: "' + (ConvertTo-JsString $r.Keywords) + '"'
    }
    $lines += ($line + ' },')
}
if ($lines.Count -eq 0) { $lines = @('    /* 暂无报告 */') }

$newNav = Set-MarkedBlock -Text $navRaw -Begin $BEGIN -End $END -Body $lines

$metaBody = @('    generated: "' + (Get-Date -Format "yyyy-MM-dd HH:mm") + '"')
$newNav = Set-MarkedBlock -Text $newNav -Begin $META_BEGIN -End $META_END -Body $metaBody

# UTF-8 带 BOM：中文标题在 file:// 下不依赖 HTML 的 charset 也能正确解码
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText($navPath, $newNav, $utf8Bom)

Write-Host ("[update-nav] 工作区：{0}" -f $Dir)
Write-Host ("[update-nav] 报告目录：{0}" -f $reportPath)
Write-Host ("[update-nav] 扫描 HTML：{0} 篇，写入清单：{1} 条 -> {2}" -f
            $scanned, $ordered.Count, $NavFile)
foreach ($r in $ordered) {
    Write-Host ("             {0}  发布 {1}  [{2}]  {3}" -f $r.Date, $r.PublishedAt, $r.Tag, $r.Title)
    if ([string]::IsNullOrWhiteSpace($r.Summary)) {
        Write-Host ("               ! 未取到摘要（建议在报告中加 <!-- rpnav-summary: … -->）")
    }
}
Write-Host ("[update-nav] 独立报告库 research/{0} 直接读取该清单；应用清单与 Vue 文档由 npm run research:publish 统一更新。" -f $IndexFile)
