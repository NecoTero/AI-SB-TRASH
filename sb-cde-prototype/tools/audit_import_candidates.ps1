$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$inputDir = Join-Path $projectRoot 'Исходные данные\as is'
$excel = $null

try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false

    Get-ChildItem -LiteralPath $inputDir -Filter 'МАН16*.xlsx' | Sort-Object Name | ForEach-Object {
        $workbook = $excel.Workbooks.Open($_.FullName, 0, $true)
        try {
            $sheet = $workbook.Worksheets.Item(1)
            $headers = @{}
            for ($column = 1; $column -le $sheet.UsedRange.Columns.Count; $column++) {
                $value = [string]$sheet.Cells.Item(1, $column).Value2
                if ($value) { $headers[$value.Trim()] = $column }
            }

            $counts = @{
                Total = 0
                MissingName = 0
                MissingStart = 0
                MissingFinish = 0
                PlanOrder = 0
                FactWithoutStart = 0
                FactOrder = 0
            }
            $maxFact = 0.0

            for ($row = 3; $row -le $sheet.UsedRange.Rows.Count; $row++) {
                if (-not $sheet.Cells.Item($row, $headers['SB_KQ_code']).Value2) { continue }
                $counts.Total++
                if (-not $sheet.Cells.Item($row, $headers['Name']).Value2) { $counts.MissingName++ }
                $planStart = $sheet.Cells.Item($row, $headers['Start']).Value2
                $planFinish = $sheet.Cells.Item($row, $headers['Fin']).Value2
                if (-not $planStart) { $counts.MissingStart++ }
                if (-not $planFinish) { $counts.MissingFinish++ }
                if ($planStart -and $planFinish -and [double]$planFinish -lt [double]$planStart) { $counts.PlanOrder++ }

                if ($headers.ContainsKey('FactStart')) {
                    $factStart = $sheet.Cells.Item($row, $headers['FactStart']).Value2
                    $factFinish = $sheet.Cells.Item($row, $headers['FactFin']).Value2
                    if ($factFinish -and -not $factStart) { $counts.FactWithoutStart++ }
                    if ($factStart -and $factFinish -and [double]$factFinish -lt [double]$factStart) { $counts.FactOrder++ }
                    if ($factStart -and [double]$factStart -gt $maxFact) { $maxFact = [double]$factStart }
                    if ($factFinish -and [double]$factFinish -gt $maxFact) { $maxFact = [double]$factFinish }
                }
            }

            $maxFactText = if ($maxFact) { [datetime]::FromOADate($maxFact).ToString('dd.MM.yyyy') } else { '-' }
            Write-Output (
                "$($_.Name) | kfo_rows=$($counts.Total) | missing_name=$($counts.MissingName) " +
                "| missing_start=$($counts.MissingStart) | missing_fin=$($counts.MissingFinish) " +
                "| plan_order=$($counts.PlanOrder) | fact_without_start=$($counts.FactWithoutStart) " +
                "| fact_order=$($counts.FactOrder) | max_fact=$maxFactText"
            )
        }
        finally {
            $workbook.Close($false)
            [Runtime.InteropServices.Marshal]::ReleaseComObject($workbook) | Out-Null
        }
    }
}
finally {
    if ($null -ne $excel) {
        $excel.Quit()
        [Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
    }
}
