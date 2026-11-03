param(
    [string]$OutputFolder = 'заполненные шаблоны'
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$inputDir = Join-Path $projectRoot 'Исходные данные\as is'
$outputDir = Join-Path (Join-Path $projectRoot 'Исходные данные') $OutputFolder
$pairs = @(
    @('МАН16_L3_Базовый план.xlsx', 'SB_Шаблон для импорта КСП_МАН16_L3_Базовый план.xlsx'),
    @('МАН16_L3_Факт на 27092026.xlsx', 'SB_Шаблон для импорта КСП_МАН16_L3_Факт на 27092026.xlsx')
)
$mappedHeaders = @(
    'Code', 'Name', 'SB_Project_code', 'SB_Project', 'SB_Object_code',
    'SB_Object', 'SB_Phase', 'BSC', 'SB_CBS_code', 'SB_CBS', 'SB_KQ_code',
    'SB_KQ', 'SB_Document_number', 'Unit', 'VolSum', 'VolPlan', 'VolFact',
    'Start', 'Fin', 'FactStart', 'FactFin'
)
$validCorpus = @('Корпус А', 'Корпус Б', 'Корпус В')
$validFloor = @('Этаж -1', 'Этаж 1', 'Этаж 2', 'Этаж 3', 'Этаж 4', 'Этаж 5', 'Этаж 6', 'Этаж 7', 'Этаж 8')

function Same-Value($left, $right) {
    if ([string]::IsNullOrEmpty([string]$left) -and [string]::IsNullOrEmpty([string]$right)) { return $true }
    if ($null -eq $left -and $null -eq $right) { return $true }
    if ($null -eq $left -or $null -eq $right) { return $false }
    if ($left -is [double] -and $right -is [double]) { return [Math]::Abs($left - $right) -lt 0.0000001 }
    return [string]$left -eq [string]$right
}

$excel = $null
$failed = $false
try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false

    foreach ($pair in $pairs) {
        $sourcePath = Join-Path $inputDir $pair[0]
        $targetPath = Join-Path $outputDir $pair[1]
        $sourceBook = $excel.Workbooks.Open($sourcePath, 0, $true)
        $targetBook = $excel.Workbooks.Open($targetPath, 0, $true)
        try {
            $sourceSheet = $sourceBook.Worksheets.Item(1)
            $targetSheet = $targetBook.Worksheets.Item('Шаблон')
            $sourceLastRow = $sourceSheet.UsedRange.Rows.Count
            $targetLastRow = $targetSheet.UsedRange.Rows.Count
            $errors = New-Object System.Collections.Generic.List[string]
            $sourceHeaders = @{}
            for ($column = 1; $column -le $sourceSheet.UsedRange.Columns.Count; $column++) {
                $header = [string]$sourceSheet.Cells.Item(1, $column).Value2
                if ($header) { $sourceHeaders[$header.Trim()] = $column }
            }
            $targetHeaders = @{}
            for ($column = 1; $column -le 36; $column++) {
                $header = [string]$targetSheet.Cells.Item(3, $column).Value2
                if ($header) { $targetHeaders[$header.Trim()] = $column }
            }

            $sourceData = $sourceSheet.Range(
                $sourceSheet.Cells.Item(3, 1),
                $sourceSheet.Cells.Item($sourceLastRow, $sourceSheet.UsedRange.Columns.Count)
            ).Value2
            $sourceRowLower = $sourceData.GetLowerBound(0)
            $sourceColumnLower = $sourceData.GetLowerBound(1)
            $sourceDataRowCount = $sourceLastRow - 2
            $sourceKfoColumn = $sourceColumnLower + $sourceHeaders['SB_KQ_code'] - 1
            $selectedOffsets = New-Object System.Collections.Generic.List[int]
            for ($sourceOffset = 0; $sourceOffset -lt $sourceDataRowCount; $sourceOffset++) {
                $value = $sourceData[($sourceRowLower + $sourceOffset), $sourceKfoColumn]
                if (-not [string]::IsNullOrWhiteSpace([string]$value)) { $selectedOffsets.Add($sourceOffset) }
            }
            $dataRowCount = $selectedOffsets.Count
            $expectedTargetLastRow = $dataRowCount + 3
            if ($targetLastRow -lt $expectedTargetLastRow) {
                $errors.Add("Недостаточно строк: $targetLastRow вместо минимум $expectedTargetLastRow.")
            }
            $targetData = $targetSheet.Range(
                $targetSheet.Cells.Item(4, 1),
                $targetSheet.Cells.Item($expectedTargetLastRow, 36)
            ).Value2
            $targetRowLower = $targetData.GetLowerBound(0)
            $targetColumnLower = $targetData.GetLowerBound(1)
            $sourceBscTexts = New-Object 'string[]' $sourceDataRowCount
            for ($rowOffset = 0; $rowOffset -lt $sourceDataRowCount; $rowOffset++) {
                $sourceBscTexts[$rowOffset] = [string]$sourceSheet.Cells.Item(
                    $rowOffset + 3, $sourceHeaders['BSC']
                ).Text
            }

            $reportDate = [datetime]::FromOADate([double]$targetSheet.Range('B1').Value2)
            if ($pair[0] -like '*Факт*') {
                $expectedReportDate = [datetime]'2026-09-27'
            }
            else {
                $minimumSerial = $null
                foreach ($dateHeader in @('Start', 'Fin', 'FactStart', 'FactFin')) {
                    if (-not $sourceHeaders.ContainsKey($dateHeader)) { continue }
                    $dateColumn = $sourceColumnLower + $sourceHeaders[$dateHeader] - 1
                    for ($rowOffset = 0; $rowOffset -lt $sourceDataRowCount; $rowOffset++) {
                        $value = $sourceData[($sourceRowLower + $rowOffset), $dateColumn]
                        if ($value -is [double] -or $value -is [int] -or $value -is [decimal]) {
                            $serial = [double]$value
                            if ($serial -gt 0 -and ($null -eq $minimumSerial -or $serial -lt $minimumSerial)) {
                                $minimumSerial = $serial
                            }
                        }
                    }
                }
                $expectedReportDate = [datetime]::FromOADate([Math]::Floor($minimumSerial)).Date
            }
            if ($reportDate.Date -ne $expectedReportDate.Date) {
                $errors.Add("Некорректная отчетная дата: $($reportDate.ToString('dd.MM.yyyy')); ожидалась $($expectedReportDate.ToString('dd.MM.yyyy')).")
            }

            foreach ($header in $mappedHeaders) {
                if (-not $targetHeaders.ContainsKey($header)) {
                    $errors.Add("В шаблоне отсутствует колонка $header.")
                    continue
                }
                if (-not $sourceHeaders.ContainsKey($header)) { continue }
                for ($targetRowOffset = 0; $targetRowOffset -lt $dataRowCount; $targetRowOffset++) {
                    $sourceOffset = $selectedOffsets[$targetRowOffset]
                    $sourceRow = $sourceOffset + 3
                    $left = if ($header -eq 'BSC') {
                        $sourceBscTexts[$sourceOffset]
                    }
                    else {
                        $sourceData[($sourceRowLower + $sourceOffset), ($sourceColumnLower + $sourceHeaders[$header] - 1)]
                    }
                    $right = $targetData[($targetRowLower + $targetRowOffset), ($targetColumnLower + $targetHeaders[$header] - 1)]
                    if (-not (Same-Value $left $right)) {
                        $errors.Add("${header}: расхождение в исходной строке $sourceRow.")
                        break
                    }
                }
            }

            $summaryCount = 0
            $operationCount = 0
            $rowsWithKfo = 0
            $rowsWithCorpus = 0
            $rowsWithFloor = 0
            for ($rowOffset = 0; $rowOffset -lt $dataRowCount; $rowOffset++) {
                $targetRow = $rowOffset + 4
                $arrayRow = $targetRowLower + $rowOffset
                $code = [string]$targetData[$arrayRow, $targetColumnLower]
                $bsc = [string]$targetData[$arrayRow, ($targetColumnLower + 7)]
                $summary = [bool]$targetData[$arrayRow, ($targetColumnLower + 21)]
                $depth = [int]$targetData[$arrayRow, ($targetColumnLower + 22)]
                $corpus = [string]$targetData[$arrayRow, ($targetColumnLower + 34)]
                $floor = [string]$targetData[$arrayRow, ($targetColumnLower + 35)]
                $expectedDepth = if ($bsc -eq '0' -or [string]::IsNullOrWhiteSpace($bsc)) { 0 } else { ($bsc -split '\.').Count }
                if ($depth -ne $expectedDepth) { $errors.Add("Неверная глубина в строке $targetRow.") }
                if ($corpus -and $corpus -notin $validCorpus) { $errors.Add("Неизвестный корпус '$corpus' в строке $targetRow.") }
                if ($floor -and $floor -notin $validFloor) { $errors.Add("Неизвестный этаж '$floor' в строке $targetRow.") }
                $expectedSummary = -not ($code -match '^[AaАа]')
                if ($summary -ne $expectedSummary) { $errors.Add("Неверный тип строки в строке $targetRow.") }
                if ($summary) {
                    $summaryCount++
                }
                else {
                    $operationCount++
                }
                if ($targetData[$arrayRow, ($targetColumnLower + 10)]) { $rowsWithKfo++ }
                if ($corpus) { $rowsWithCorpus++ }
                if ($floor) { $rowsWithFloor++ }
                if ($errors.Count -ge 30) { break }
            }

            $status = if ($errors.Count) { 'FAIL' } else { 'OK' }
            Write-Output "$status | $($pair[1]) | rows=$dataRowCount | source_summary=$summaryCount | source_leaf=$operationCount | kfo=$rowsWithKfo | corpus=$rowsWithCorpus | floor=$rowsWithFloor"
            foreach ($error in $errors) { Write-Output "  - $error" }
            if ($errors.Count) { $failed = $true }
        }
        finally {
            $targetBook.Close($false)
            $sourceBook.Close($false)
            [Runtime.InteropServices.Marshal]::ReleaseComObject($targetBook) | Out-Null
            [Runtime.InteropServices.Marshal]::ReleaseComObject($sourceBook) | Out-Null
        }
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

if ($failed) { exit 1 }
