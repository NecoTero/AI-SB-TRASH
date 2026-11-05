param(
    [string]$SourcePath = (Join-Path (Get-Location) 'Исходные данные\заполненные шаблоны\SB_Шаблон для импорта КСП_МАН16_L3_Факт на 27092026 — с этапами.xlsx'),
    [string]$DestinationPath = (Join-Path (Get-Location) 'Исходные данные\заполненные шаблоны\SB_Шаблон для импорта КСП_МАН16_L3_Факт на 27092026 — с этапами.xlsx')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-Stage([string]$level2) {
    switch -Regex ($level2.Trim()) {
        '^Устройство фундаментных плит и свайного поля$' { return 'Фундамент' }
        '^(Металлоконструкции|Монолитный ж/б каркас)$' { return 'Shell&Core' }
        '^(Устройство перегородок и черновая отделка|Чистовая отделка|Оснащение мебелью и декором|Устройство инженерных сетей и систем|Технологическое оборудование)$' { return 'FitOut' }
        '^Наружние сети$' { return '-' }
        '^(Устройство кровли|Кровля)$' { return 'Кровля' }
        '^(Устройство фасадов|Фасадная часть)$' { return 'Фасады' }
        default { return '-' }
    }
}

function Get-CellText($cell, [string[]]$sharedStrings, $namespaceManager) {
    if ($null -eq $cell) { return '' }
    if ($cell.GetAttribute('t') -eq 'inlineStr') {
        return (($cell.SelectNodes('.//m:t', $namespaceManager) | ForEach-Object { $_.InnerText }) -join '')
    }
    $value = $cell.SelectSingleNode('./m:v', $namespaceManager)
    if ($null -eq $value) { return '' }
    if ($cell.GetAttribute('t') -eq 's') { return $sharedStrings[[int]$value.InnerText] }
    return $value.InnerText
}

function Add-InlineCell($document, $row, [string]$reference, [string]$style, [string]$text) {
    $namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    $cell = $document.CreateElement('c', $namespace)
    $cell.SetAttribute('r', $reference)
    if ($style) { $cell.SetAttribute('s', $style) }
    $cell.SetAttribute('t', 'inlineStr')
    $inline = $document.CreateElement('is', $namespace)
    $value = $document.CreateElement('t', $namespace)
    $value.InnerText = $text
    [void]$inline.AppendChild($value)
    [void]$cell.AppendChild($inline)
    [void]$row.AppendChild($cell)
}

$sourceFull = [IO.Path]::GetFullPath($SourcePath)
$destinationFull = [IO.Path]::GetFullPath($DestinationPath)
$destinationDir = Split-Path -Parent $destinationFull
$tempDir = Join-Path $destinationDir ('.stage-xlsx-' + [guid]::NewGuid().ToString('N'))
$tempFull = [IO.Path]::GetFullPath($tempDir)
$destinationDirFull = [IO.Path]::GetFullPath($destinationDir).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $tempFull.StartsWith($destinationDirFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Временная папка вышла за границы каталога назначения.'
}

try {
    [IO.Compression.ZipFile]::ExtractToDirectory($sourceFull, $tempFull)
    $sharedStringsPath = Join-Path $tempFull 'xl\sharedStrings.xml'
    [xml]$sharedXml = Get-Content -LiteralPath $sharedStringsPath -Encoding utf8 -Raw
    $sharedNs = New-Object Xml.XmlNamespaceManager($sharedXml.NameTable)
    $sharedNs.AddNamespace('m', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
    [string[]]$sharedStrings = @($sharedXml.SelectNodes('//m:si', $sharedNs) | ForEach-Object {
        (($_.SelectNodes('.//m:t', $sharedNs) | ForEach-Object { $_.InnerText }) -join '')
    })

    $sheetPath = Join-Path $tempFull 'xl\worksheets\sheet1.xml'
    [xml]$sheet = Get-Content -LiteralPath $sheetPath -Encoding utf8 -Raw
    $ns = New-Object Xml.XmlNamespaceManager($sheet.NameTable)
    $ns.AddNamespace('m', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')

    $dimension = $sheet.SelectSingleNode('//m:dimension', $ns)
    $dimension.SetAttribute('ref', ($dimension.GetAttribute('ref') -replace ':AJ', ':AK'))
    $autoFilter = $sheet.SelectSingleNode('//m:autoFilter', $ns)
    if ($null -ne $autoFilter) { $autoFilter.SetAttribute('ref', ($autoFilter.GetAttribute('ref') -replace ':AJ', ':AK')) }

    $headerRow = $sheet.SelectSingleNode('//m:row[@r="3"]', $ns)
    $headerStyle = $sheet.SelectSingleNode('//m:c[@r="AJ3"]', $ns).GetAttribute('s')
    $oldHeader = $headerRow.SelectSingleNode('./m:c[@r="AK3"]', $ns)
    if ($null -ne $oldHeader) { [void]$headerRow.RemoveChild($oldHeader) }
    Add-InlineCell $sheet $headerRow 'AK3' $headerStyle 'Constraction Stages'

    $counts = @{}
    foreach ($row in $sheet.SelectNodes('//m:sheetData/m:row[number(@r) >= 4]', $ns)) {
        $rowNumber = $row.GetAttribute('r')
        $level2Cell = $row.SelectSingleNode('./m:c[@r="AA' + $rowNumber + '"]', $ns)
        $level2 = Get-CellText $level2Cell $sharedStrings $ns
        $stage = Get-Stage $level2
        $styleCell = $row.SelectSingleNode('./m:c[@r="AJ' + $rowNumber + '"]', $ns)
        $style = if ($null -ne $styleCell) { $styleCell.GetAttribute('s') } else { '3' }
        $oldCell = $row.SelectSingleNode('./m:c[@r="AK' + $rowNumber + '"]', $ns)
        if ($null -ne $oldCell) { [void]$row.RemoveChild($oldCell) }
        Add-InlineCell $sheet $row ('AK' + $rowNumber) $style $stage
        $counts[$stage] = 1 + [int]($counts[$stage])
    }

    $settings = New-Object Xml.XmlWriterSettings
    $settings.Encoding = New-Object Text.UTF8Encoding($false)
    $settings.Indent = $false
    $writer = [Xml.XmlWriter]::Create($sheetPath, $settings)
    try { $sheet.Save($writer) } finally { $writer.Dispose() }

    $archivePath = Join-Path $destinationDir ('.stage-result-' + [guid]::NewGuid().ToString('N') + '.xlsx')
    $archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in Get-ChildItem -LiteralPath $tempFull -Recurse -File) {
            $relative = $file.FullName.Substring($tempFull.Length).TrimStart('\', '/') -replace '\\', '/'
            $entry = $archive.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
            $entryStream = $entry.Open()
            $fileStream = $file.OpenRead()
            try { $fileStream.CopyTo($entryStream) } finally { $fileStream.Dispose(); $entryStream.Dispose() }
        }
    }
    finally { $archive.Dispose() }
    Move-Item -LiteralPath $archivePath -Destination $destinationFull -Force
    Write-Output ('created=' + $destinationFull)
    foreach ($name in @('Фундамент','Shell&Core','Фасады','Кровля','FitOut','-')) {
        Write-Output ($name + '=' + [int]$counts[$name])
    }
}
finally {
    if (Test-Path -LiteralPath $tempFull) { Remove-Item -LiteralPath $tempFull -Recurse -Force }
}
