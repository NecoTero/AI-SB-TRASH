param(
    [string]$SourcePath = (Join-Path (Get-Location) 'Исходные данные\as is\Справочники_Работ.xlsx'),
    [string]$DestinationPath = (Join-Path (Get-Location) 'Исходные данные\as is\Справочники_Работ — этапы и BIM.xlsx')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-StageMapping([string]$code) {
    if ($code -match '^204\.02\.01\.') { return @('-', '', '') }
    if ($code -match '^204\.02\.02\.') { return @('Фундамент', 'Высокая', 'Сваи и монолитные конструкции ниже нулевой отметки относятся к фундаментам.') }
    if ($code -match '^204\.02\.03\.') { return @('Shell&Core', 'Высокая', 'Несущие конструкции, основной каркас и его защитные покрытия относятся к Shell&Core.') }
    if ($code -match '^204\.02\.04\.') { return @('FitOut', 'Средняя', 'Внутренние инженерные сети и оборудование отнесены к FitOut по проектному справочнику этапов.') }
    if ($code -match '^204\.02\.05\.') { return @('Фасады', 'Высокая', 'Остекление, наружные двери и ограждающие фасадные конструкции относятся к фасадам.') }
    if ($code -match '^204\.02\.06\.') { return @('Кровля', 'Высокая', 'Кровельные конструкции и покрытия напрямую относятся к этапу «Кровля».') }
    if ($code -match '^204\.02\.07\.') { return @('FitOut', 'Средняя', 'Лифты, эскалаторы и траволаторы отнесены к технологическому оснащению FitOut.') }
    if ($code -match '^204\.03\.') { return @('FitOut', 'Высокая', 'Внутренние двери, перегородки, потолки, стены, полы и оконечные устройства относятся к FitOut.') }
    if ($code -match '^204\.04\.') { return @('FitOut', 'Высокая', 'Мебель, декор и интерьерное оснащение относятся к FitOut.') }
    if ($code -match '^204\.05\.') { return @('FitOut', 'Высокая', 'Мультимедиа, специализированное оборудование и умный дом относятся к FitOut.') }
    if ($code -match '^204\.06\.') { return @('-', 'Высокая', 'Наружные инженерные сети и оборудование относятся к внешнему контуру и не входят в пять строительных этапов здания.') }
    if ($code -match '^204\.07\.') { return @('-', 'Высокая', 'Инженерная защита относится к внешнему контуру и не входит в пять строительных этапов здания.') }
    if ($code -match '^204\.08\.') { return @('-', 'Высокая', 'Благоустройство и наружные покрытия не входят в пять строительных этапов здания.') }
    if ($code -match '^204\.10\.03\.') { return @('-', 'Высокая', 'Покрытия спортивных объектов не входят в пять строительных этапов здания.') }
    if ($code -match '^205\.') { return @('-', 'Высокая', 'Пусконаладочные и испытательные работы не являются строительным этапом, даже если связаны с BIM-элементом.') }
    return @('-', 'Высокая', 'Работа относится к подготовке площадки, наружной инфраструктуре, благоустройству, специальным или временным сооружениям и не входит в пять строительных этапов.')
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

function Save-Xml($document, [string]$path) {
    $settings = New-Object Xml.XmlWriterSettings
    $settings.Encoding = New-Object Text.UTF8Encoding($false)
    $settings.Indent = $false
    $writer = [Xml.XmlWriter]::Create($path, $settings)
    try { $document.Save($writer) } finally { $writer.Dispose() }
}

function Write-InlineCell($writer, [string]$reference, [string]$text, [string]$style = '') {
    $writer.WriteStartElement('c')
    $writer.WriteAttributeString('r', $reference)
    if ($style) { $writer.WriteAttributeString('s', $style) }
    $writer.WriteAttributeString('t', 'inlineStr')
    $writer.WriteStartElement('is')
    $writer.WriteStartElement('t')
    if ($text -match '^\s|\s$') { $writer.WriteAttributeString('xml', 'space', $null, 'preserve') }
    $writer.WriteString($text)
    $writer.WriteEndElement()
    $writer.WriteEndElement()
    $writer.WriteEndElement()
}

$sourceFull = [IO.Path]::GetFullPath($SourcePath)
$destinationFull = [IO.Path]::GetFullPath($DestinationPath)
$destinationDir = Split-Path -Parent $destinationFull
$tempDir = Join-Path $destinationDir ('.kfo-stage-' + [guid]::NewGuid().ToString('N'))
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

    $sourceSheetPath = Join-Path $tempFull 'xl\worksheets\sheet2.xml'
    [xml]$sourceSheet = Get-Content -LiteralPath $sourceSheetPath -Encoding utf8 -Raw
    $sourceNs = New-Object Xml.XmlNamespaceManager($sourceSheet.NameTable)
    $sourceNs.AddNamespace('m', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
    $sourceRows = New-Object System.Collections.Generic.List[object]
    foreach ($row in $sourceSheet.SelectNodes('//m:sheetData/m:row[number(@r) >= 4]', $sourceNs)) {
        $rowNumber = $row.GetAttribute('r')
        $code = (Get-CellText $row.SelectSingleNode('./m:c[@r="A' + $rowNumber + '"]', $sourceNs) $sharedStrings $sourceNs).Trim()
        $name = (Get-CellText $row.SelectSingleNode('./m:c[@r="B' + $rowNumber + '"]', $sourceNs) $sharedStrings $sourceNs).Trim()
        if ($code) { $sourceRows.Add([pscustomobject]@{ Code = $code; Name = $name }) }
    }
    $duplicates = @{}
    foreach ($group in $sourceRows | Group-Object Code | Where-Object Count -gt 1) { $duplicates[$group.Name] = $group.Count }

    $dataSheetPath = Join-Path $tempFull 'xl\worksheets\sheet5.xml'
    [xml]$dataSheet = Get-Content -LiteralPath $dataSheetPath -Encoding utf8 -Raw
    $dataNs = New-Object Xml.XmlNamespaceManager($dataSheet.NameTable)
    $dataNs.AddNamespace('m', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
    $bimByCode = @{}
    foreach ($row in $dataSheet.SelectNodes('//m:sheetData/m:row[number(@r) >= 4]', $dataNs)) {
        $rowNumber = $row.GetAttribute('r')
        $code = (Get-CellText $row.SelectSingleNode('./m:c[@r="A' + $rowNumber + '"]', $dataNs) $sharedStrings $dataNs).Trim()
        $flag = (Get-CellText $row.SelectSingleNode('./m:c[@r="E' + $rowNumber + '"]', $dataNs) $sharedStrings $dataNs).Trim()
        if ($code -and (-not $bimByCode.ContainsKey($code) -or $flag -eq '✅')) {
            $bimByCode[$code] = if ($flag -eq '✅') { 'BIM' } else { 'без BIM' }
        }
    }

    $workbookPath = Join-Path $tempFull 'xl\workbook.xml'
    $relationsPath = Join-Path $tempFull 'xl\_rels\workbook.xml.rels'
    $contentTypesPath = Join-Path $tempFull '[Content_Types].xml'
    [xml]$workbook = Get-Content -LiteralPath $workbookPath -Encoding utf8 -Raw
    [xml]$relations = Get-Content -LiteralPath $relationsPath -Encoding utf8 -Raw
    [xml]$contentTypes = Get-Content -LiteralPath $contentTypesPath -Encoding utf8 -Raw
    $workbookNs = New-Object Xml.XmlNamespaceManager($workbook.NameTable)
    $workbookNs.AddNamespace('m', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
    $workbookNs.AddNamespace('r', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')

    $sheetIds = @($workbook.SelectNodes('//m:sheets/m:sheet', $workbookNs) | ForEach-Object { [int]$_.GetAttribute('sheetId') })
    $newSheetId = (($sheetIds | Measure-Object -Maximum).Maximum + 1)
    $worksheetNumbers = @(Get-ChildItem -LiteralPath (Join-Path $tempFull 'xl\worksheets') -Filter 'sheet*.xml' -File | ForEach-Object {
        if ($_.BaseName -match '^sheet(\d+)$') { [int]$Matches[1] }
    })
    $newSheetNumber = (($worksheetNumbers | Measure-Object -Maximum).Maximum + 1)
    $newSheetRelative = 'worksheets/sheet' + $newSheetNumber + '.xml'
    $newSheetPath = Join-Path $tempFull ('xl\worksheets\sheet' + $newSheetNumber + '.xml')
    $relationNumbers = @($relations.Relationships.Relationship | ForEach-Object {
        if ($_.Id -match '^rId(\d+)$') { [int]$Matches[1] }
    })
    $newRelationId = 'rId' + (($relationNumbers | Measure-Object -Maximum).Maximum + 1)

    $headerStyle = $sourceSheet.SelectSingleNode('//m:c[@r="A1"]', $sourceNs).GetAttribute('s')
    $dataStyle = $sourceSheet.SelectSingleNode('//m:c[@r="A4"]', $sourceNs).GetAttribute('s')
    $settings = New-Object Xml.XmlWriterSettings
    $settings.Encoding = New-Object Text.UTF8Encoding($false)
    $settings.Indent = $false
    $writer = [Xml.XmlWriter]::Create($newSheetPath, $settings)
    try {
        $writer.WriteStartDocument()
        $writer.WriteStartElement('worksheet', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
        $writer.WriteStartElement('dimension'); $writer.WriteAttributeString('ref', 'A1:G' + ($sourceRows.Count + 1)); $writer.WriteEndElement()
        $writer.WriteStartElement('sheetViews'); $writer.WriteStartElement('sheetView'); $writer.WriteAttributeString('workbookViewId', '0')
        $writer.WriteStartElement('pane'); $writer.WriteAttributeString('ySplit', '1'); $writer.WriteAttributeString('topLeftCell', 'A2'); $writer.WriteAttributeString('activePane', 'bottomLeft'); $writer.WriteAttributeString('state', 'frozen'); $writer.WriteEndElement()
        $writer.WriteEndElement(); $writer.WriteEndElement()
        $writer.WriteStartElement('sheetFormatPr'); $writer.WriteAttributeString('defaultRowHeight', '15'); $writer.WriteEndElement()
        $writer.WriteStartElement('cols')
        foreach ($column in @(@(1,1,18),@(2,2,58),@(3,3,14),@(4,4,18),@(5,5,25),@(6,6,72),@(7,7,42))) {
            $writer.WriteStartElement('col'); $writer.WriteAttributeString('min', [string]$column[0]); $writer.WriteAttributeString('max', [string]$column[1]); $writer.WriteAttributeString('width', [string]$column[2]); $writer.WriteAttributeString('customWidth', '1'); $writer.WriteEndElement()
        }
        $writer.WriteEndElement()
        $writer.WriteStartElement('sheetData')
        $writer.WriteStartElement('row'); $writer.WriteAttributeString('r', '1')
        $headers = @('Код КФО', 'Расшифровка КФО', 'BIM / без BIM', 'Строительный этап', 'Уверенность', 'Основание маппинга', 'Примечание')
        for ($index = 0; $index -lt $headers.Count; $index++) { Write-InlineCell $writer ([char](65 + $index) + '1') $headers[$index] $headerStyle }
        $writer.WriteEndElement()
        for ($index = 0; $index -lt $sourceRows.Count; $index++) {
            $excelRow = $index + 2
            $item = $sourceRows[$index]
            $mapping = Get-StageMapping $item.Code
            $bim = if ($bimByCode[$item.Code] -eq 'BIM') { 'BIM' } else { 'без BIM' }
            if ($bim -eq 'без BIM') { $mapping = @('-', '', '') }
            $note = if ($duplicates.ContainsKey($item.Code)) { 'Дублирующийся код в исходном справочнике; сохранены все варианты расшифровки.' } else { '' }
            $writer.WriteStartElement('row'); $writer.WriteAttributeString('r', [string]$excelRow)
            $values = @($item.Code, $item.Name, $bim, $mapping[0], $mapping[1], $mapping[2], $note)
            for ($columnIndex = 0; $columnIndex -lt $values.Count; $columnIndex++) { Write-InlineCell $writer ([char](65 + $columnIndex) + [string]$excelRow) ([string]$values[$columnIndex]) $dataStyle }
            $writer.WriteEndElement()
        }
        $writer.WriteEndElement()
        $writer.WriteStartElement('autoFilter'); $writer.WriteAttributeString('ref', 'A1:G' + ($sourceRows.Count + 1)); $writer.WriteEndElement()
        $writer.WriteEndElement()
        $writer.WriteEndDocument()
    }
    finally { $writer.Dispose() }

    $sheetNode = $workbook.CreateElement('sheet', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
    [void]$sheetNode.SetAttribute('name', 'КФО — этапы')
    [void]$sheetNode.SetAttribute('sheetId', [string]$newSheetId)
    [void]$sheetNode.SetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', $newRelationId)
    [void]$workbook.SelectSingleNode('//m:sheets', $workbookNs).AppendChild($sheetNode)

    $relationship = $relations.CreateElement('Relationship', 'http://schemas.openxmlformats.org/package/2006/relationships')
    [void]$relationship.SetAttribute('Id', $newRelationId)
    [void]$relationship.SetAttribute('Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet')
    [void]$relationship.SetAttribute('Target', $newSheetRelative)
    [void]$relations.Relationships.AppendChild($relationship)

    $override = $contentTypes.CreateElement('Override', 'http://schemas.openxmlformats.org/package/2006/content-types')
    [void]$override.SetAttribute('PartName', '/xl/' + $newSheetRelative)
    [void]$override.SetAttribute('ContentType', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml')
    [void]$contentTypes.Types.AppendChild($override)

    Save-Xml $workbook $workbookPath
    Save-Xml $relations $relationsPath
    Save-Xml $contentTypes $contentTypesPath

    $archivePath = Join-Path $destinationDir ('.kfo-stage-result-' + [guid]::NewGuid().ToString('N') + '.xlsx')
    $archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in Get-ChildItem -LiteralPath $tempFull -Recurse -File) {
            $relative = $file.FullName.Substring($tempFull.Length).TrimStart('\', '/') -replace '\\', '/'
            $entry = $archive.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
            $entryStream = $entry.Open(); $fileStream = $file.OpenRead()
            try { $fileStream.CopyTo($entryStream) } finally { $fileStream.Dispose(); $entryStream.Dispose() }
        }
    }
    finally { $archive.Dispose() }
    Move-Item -LiteralPath $archivePath -Destination $destinationFull -Force

    $stageCounts = @{}
    foreach ($item in $sourceRows) {
        $stage = if ($bimByCode[$item.Code] -eq 'BIM') { (Get-StageMapping $item.Code)[0] } else { '-' }
        $stageCounts[$stage] = 1 + [int]$stageCounts[$stage]
    }
    Write-Output ('created=' + $destinationFull)
    Write-Output ('rows=' + $sourceRows.Count)
    Write-Output ('unique_codes=' + (($sourceRows.Code | Sort-Object -Unique).Count))
    Write-Output ('BIM=' + (($sourceRows | Where-Object { $bimByCode[$_.Code] -eq 'BIM' }).Count))
    Write-Output ('без BIM=' + (($sourceRows | Where-Object { $bimByCode[$_.Code] -ne 'BIM' }).Count))
    foreach ($name in @('Фундамент','Shell&Core','Фасады','Кровля','FitOut','-')) { Write-Output ($name + '=' + [int]$stageCounts[$name]) }
}
finally {
    if (Test-Path -LiteralPath $tempFull) { Remove-Item -LiteralPath $tempFull -Recurse -Force }
}
