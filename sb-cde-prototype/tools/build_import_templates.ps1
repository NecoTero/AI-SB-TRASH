param(
    [datetime]$FactReportDate = [datetime]'2026-09-27',
    [string]$OutputFolder = 'заполненные шаблоны'
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$inputDir = Join-Path $projectRoot 'Исходные данные\as is'
$outputDir = Join-Path (Join-Path $projectRoot 'Исходные данные') $OutputFolder
$templatePath = Join-Path $inputDir 'SB_Шаблон для импорта КСП.xlsx'
$sourceFiles = @(
    'МАН16_L3_Базовый план.xlsx',
    'МАН16_L3_Факт на 27092026.xlsx'
)
$targetHeaders = @(
    'Code', 'Name', 'SB_Project_code', 'SB_Project', 'SB_Object_code',
    'SB_Object', 'SB_Phase', 'BSC', 'SB_CBS_code', 'SB_CBS', 'SB_KQ_code',
    'SB_KQ', 'SB_Document_number', 'Unit', 'VolSum', 'VolPlan', 'VolFact',
    'Start', 'Fin', 'FactStart', 'FactFin'
)

function Get-HierarchyDepth([string]$bsc) {
    if ([string]::IsNullOrWhiteSpace($bsc) -or $bsc -eq '0') { return 0 }
    return ($bsc -split '\.').Count
}

function Get-ParentBsc([string]$bsc) {
    if ([string]::IsNullOrWhiteSpace($bsc) -or $bsc -eq '0') { return $null }
    $parts = $bsc -split '\.'
    if ($parts.Count -eq 1) { return '0' }
    return ($parts[0..($parts.Count - 2)] -join '.')
}

function Get-LevelBsc([string]$bsc, [int]$level) {
    if ([string]::IsNullOrWhiteSpace($bsc) -or $bsc -eq '0') { return $null }
    $parts = $bsc -split '\.'
    if ($parts.Count -lt $level) { return $null }
    return ($parts[0..($level - 1)] -join '.')
}

function Get-Corpus([string[]]$lineage) {
    for ($index = $lineage.Count - 1; $index -ge 0; $index--) {
        $name = $lineage[$index]
        if ($name -match '^\s*Корпус\s+([АБВ])(?:\s|$)') {
            return "Корпус $($Matches[1].ToUpperInvariant())"
        }
    }
    return $null
}

function Get-Floor([string[]]$lineage) {
    for ($index = $lineage.Count - 1; $index -ge 0; $index--) {
        $name = $lineage[$index]
        if ($name -match '^\s*Подземная\s+часть(?:\s|$)') { return 'Этаж -1' }
        if ($name -match '^\s*(-?\d+)\s+этаж(?:\s|$)') { return "Этаж $($Matches[1])" }
    }
    return $null
}

New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$excel = $null

try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    $excel.ScreenUpdating = $false

    foreach ($sourceName in $sourceFiles) {
        $sourcePath = Join-Path $inputDir $sourceName
        $outputName = "SB_Шаблон для импорта КСП_$sourceName"
        $outputPath = Join-Path $outputDir $outputName

        Copy-Item -LiteralPath $templatePath -Destination $outputPath -Force
        $sourceBook = $excel.Workbooks.Open($sourcePath, 0, $true)
        $targetBook = $excel.Workbooks.Open($outputPath)
        try {
            $sourceSheet = $sourceBook.Worksheets.Item(1)
            $targetSheet = $targetBook.Worksheets.Item('Шаблон')
            $sourceLastRow = $sourceSheet.UsedRange.Rows.Count
            $sourceLastColumn = $sourceSheet.UsedRange.Columns.Count
            $sourceDataRowCount = $sourceLastRow - 2

            $sourceHeaders = @{}
            for ($column = 1; $column -le $sourceLastColumn; $column++) {
                $header = [string]$sourceSheet.Cells.Item(1, $column).Value2
                if (-not [string]::IsNullOrWhiteSpace($header)) { $sourceHeaders[$header.Trim()] = $column }
            }
            foreach ($required in @('BSC', 'Code', 'Name', 'SB_KQ_code')) {
                if (-not $sourceHeaders.ContainsKey($required)) {
                    throw "В файле $sourceName отсутствует обязательная колонка $required."
                }
            }

            $sourceValues = $sourceSheet.Range(
                $sourceSheet.Cells.Item(3, 1),
                $sourceSheet.Cells.Item($sourceLastRow, $sourceLastColumn)
            ).Value2
            $sourceLowerRow = $sourceValues.GetLowerBound(0)
            $sourceLowerColumn = $sourceValues.GetLowerBound(1)
            $bscIndex = $sourceHeaders['BSC'] - 1 + $sourceLowerColumn
            $codeIndex = $sourceHeaders['Code'] - 1 + $sourceLowerColumn
            $nameIndex = $sourceHeaders['Name'] - 1 + $sourceLowerColumn
            $kfoIndex = $sourceHeaders['SB_KQ_code'] - 1 + $sourceLowerColumn
            $selectedOffsets = New-Object System.Collections.Generic.List[int]
            for ($sourceOffset = 0; $sourceOffset -lt $sourceDataRowCount; $sourceOffset++) {
                $sourceRow = $sourceLowerRow + $sourceOffset
                if (-not [string]::IsNullOrWhiteSpace([string]$sourceValues[$sourceRow, $kfoIndex])) {
                    $selectedOffsets.Add($sourceOffset)
                }
            }
            $dataRowCount = $selectedOffsets.Count
            if ($dataRowCount -eq 0) { throw "В файле $sourceName нет строк с заполненным Кодом КФО." }
            $targetLastRow = $dataRowCount + 3

            if ($sourceName -like '*Факт*') {
                $reportDateForBook = $FactReportDate.Date
            }
            else {
                $minimumSerial = $null
                foreach ($dateHeader in @('Start', 'Fin', 'FactStart', 'FactFin')) {
                    if (-not $sourceHeaders.ContainsKey($dateHeader)) { continue }
                    $dateIndex = $sourceHeaders[$dateHeader] - 1 + $sourceLowerColumn
                    for ($rowOffset = 0; $rowOffset -lt $sourceDataRowCount; $rowOffset++) {
                        $sourceRow = $sourceLowerRow + $rowOffset
                        $value = $sourceValues[$sourceRow, $dateIndex]
                        if ($value -is [double] -or $value -is [int] -or $value -is [decimal]) {
                            $serial = [double]$value
                            if ($serial -gt 0 -and ($null -eq $minimumSerial -or $serial -lt $minimumSerial)) {
                                $minimumSerial = $serial
                            }
                        }
                    }
                }
                if ($null -eq $minimumSerial) {
                    throw "В файле $sourceName не найдены календарные даты."
                }
                $reportDateForBook = [datetime]::FromOADate([Math]::Floor($minimumSerial)).Date
            }

            $bscTexts = New-Object 'string[]' $sourceDataRowCount
            for ($rowOffset = 0; $rowOffset -lt $sourceDataRowCount; $rowOffset++) {
                $bscTexts[$rowOffset] = ([string]$sourceSheet.Cells.Item(
                    $rowOffset + 3, $sourceHeaders['BSC']
                ).Text).Trim()
            }

            $nodes = @{}
            for ($rowOffset = 0; $rowOffset -lt $sourceDataRowCount; $rowOffset++) {
                $sourceRow = $sourceLowerRow + $rowOffset
                $bsc = $bscTexts[$rowOffset]
                if (-not [string]::IsNullOrWhiteSpace($bsc)) {
                    $nodes[$bsc] = [pscustomobject]@{
                        Code = [string]$sourceValues[$sourceRow, $codeIndex]
                        Name = [string]$sourceValues[$sourceRow, $nameIndex]
                    }
                }
            }

            $targetValues = New-Object 'object[,]' $dataRowCount, 36
            for ($targetRowOffset = 0; $targetRowOffset -lt $dataRowCount; $targetRowOffset++) {
                $sourceOffset = $selectedOffsets[$targetRowOffset]
                $sourceRow = $sourceLowerRow + $sourceOffset
                for ($targetColumn = 0; $targetColumn -lt $targetHeaders.Count; $targetColumn++) {
                    $header = $targetHeaders[$targetColumn]
                    if ($sourceHeaders.ContainsKey($header)) {
                        $sourceColumn = $sourceHeaders[$header] - 1 + $sourceLowerColumn
                        $targetValues[$targetRowOffset, $targetColumn] = $sourceValues[$sourceRow, $sourceColumn]
                    }
                }

                $bsc = $bscTexts[$sourceOffset]
                $targetValues[$targetRowOffset, 7] = $bsc
                $code = ([string]$sourceValues[$sourceRow, $codeIndex]).Trim()
                $depth = Get-HierarchyDepth $bsc
                $parentBsc = Get-ParentBsc $bsc
                $isSummary = -not ($code -match '^[AaАа]')
                $targetValues[$targetRowOffset, 21] = $isSummary
                $targetValues[$targetRowOffset, 22] = $depth
                if ($parentBsc -and $nodes.ContainsKey($parentBsc)) {
                    $targetValues[$targetRowOffset, 23] = $nodes[$parentBsc].Code
                }

                $lineage = New-Object System.Collections.Generic.List[string]
                if ($nodes.ContainsKey('0')) {
                    $projectName = [string]$nodes['0'].Name
                    $targetValues[$targetRowOffset, 24] = $projectName
                    $lineage.Add($projectName)
                }
                for ($level = 1; $level -le 9; $level++) {
                    $levelBsc = Get-LevelBsc $bsc $level
                    if ($levelBsc -and $nodes.ContainsKey($levelBsc)) {
                        $levelName = [string]$nodes[$levelBsc].Name
                        $targetValues[$targetRowOffset, (24 + $level)] = $levelName
                        $lineage.Add($levelName)
                    }
                }
                $targetValues[$targetRowOffset, 34] = Get-Corpus $lineage.ToArray()
                $targetValues[$targetRowOffset, 35] = Get-Floor $lineage.ToArray()
            }

            $targetSheet.Rows.Item(4).Copy()
            $formatRange = $targetSheet.Range(
                $targetSheet.Cells.Item(4, 1),
                $targetSheet.Cells.Item($targetLastRow, 36)
            )
            $formatRange.PasteSpecial(-4122) | Out-Null
            $excel.CutCopyMode = 0
            $targetRange = $targetSheet.Range(
                $targetSheet.Cells.Item(4, 1),
                $targetSheet.Cells.Item($targetLastRow, 36)
            )
            $targetSheet.Range("H4:H$targetLastRow").NumberFormat = '@'
            $targetRange.Value2 = $targetValues
            $targetSheet.Range("B1").Value2 = $reportDateForBook.ToOADate()
            $targetSheet.Range("B1").NumberFormatLocal = 'ДД.ММ.ГГГГ'
            $targetSheet.Range("R4:U$targetLastRow").NumberFormatLocal = 'ДД.ММ.ГГГГ'
            $targetSheet.UsedRange.Columns.AutoFit() | Out-Null
            $targetSheet.Columns.Item('B').ColumnWidth = 50
            foreach ($column in @('Y','Z','AA','AB','AC','AD','AE','AF','AG','AH')) {
                $targetSheet.Columns.Item($column).ColumnWidth = 35
            }
            $targetBook.Save() | Out-Null

            $corpusCount = 0
            $floorCount = 0
            for ($rowOffset = 0; $rowOffset -lt $dataRowCount; $rowOffset++) {
                if ($null -ne $targetValues[$rowOffset, 34]) { $corpusCount++ }
                if ($null -ne $targetValues[$rowOffset, 35]) { $floorCount++ }
            }
            Write-Output "$outputName | rows=$dataRowCount | corpus=$corpusCount | floor=$floorCount | report_date=$($reportDateForBook.ToString('dd.MM.yyyy'))"
        }
        finally {
            $targetBook.Close($true)
            $sourceBook.Close($false)
            [Runtime.InteropServices.Marshal]::ReleaseComObject($targetBook) | Out-Null
            [Runtime.InteropServices.Marshal]::ReleaseComObject($sourceBook) | Out-Null
        }

        $repairPath = Join-Path $outputDir ("_repaired_" + [guid]::NewGuid().ToString('N') + '.xlsx')
        $repairedBook = $excel.Workbooks.Open(
            $outputPath, 0, $true, 5, '', '', $true, 2, '', $false, $false, 0, $false, $true, 1
        )
        try {
            $repairedBook.SaveAs($repairPath, 51)
        }
        finally {
            $repairedBook.Close($false)
            [Runtime.InteropServices.Marshal]::ReleaseComObject($repairedBook) | Out-Null
        }
        Move-Item -LiteralPath $repairPath -Destination $outputPath -Force
    }
}
finally {
    if ($null -ne $excel) {
        $excel.Quit()
        [Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
