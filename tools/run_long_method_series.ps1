param(
  [int]$StartOrdinal = 1,
  [int]$EndOrdinal = 17,
  [switch]$ListOnly
)

$ErrorActionPreference = 'Stop'

$repoRoot = 'C:\Users\RoyCai\Desktop\group_project\arkts-smell-refactor'
$dataset = 'C:\Users\RoyCai\Desktop\group_project\arkts-code-smell\dataset\positive\instrument-test\long-method.json'
$workspace = 'D:\arktsProgram'
$homecheckFolder = 'arkts' + [string]([char]0x5F02) + [string]([char]0x5473) + [string]([char]0x68C0) + [string]([char]0x67E5) + [string]([char]0x5DE5) + [string]([char]0x5177)
$homecheckParent = Join-Path 'C:\Users\RoyCai\Desktop\group_project' $homecheckFolder

function Get-HarmonyProjectRoot([string]$TargetPath, [string]$ProjectRoot) {
  $current = Split-Path -Path $TargetPath -Parent
  while ($true) {
    if ((Test-Path -LiteralPath (Join-Path $current 'build-profile.json5')) -and
        (Test-Path -LiteralPath (Join-Path $current 'hvigor\hvigor-config.json5'))) {
      return $current
    }
    if ($current -eq $ProjectRoot) { return $null }
    $parent = Split-Path -Path $current -Parent
    if ($parent -eq $current) { return $null }
    $current = $parent
  }
}

function Restore-ChangedProductionFiles([string]$TaskDirectory, [string]$SourceRoot) {
  $changesFile = Join-Path $TaskDirectory 'refactor-changes.json'
  if (-not (Test-Path -LiteralPath $changesFile)) {
    Write-Output 'ROLLBACK=NOT_NEEDED (no refactor-changes.json)'
    return
  }
  $changes = (Get-Content -LiteralPath $changesFile -Raw -Encoding utf8 | ConvertFrom-Json).changedProductionFiles
  if (-not $changes) {
    Write-Output 'ROLLBACK=NOT_NEEDED (no changed production files)'
    return
  }
  foreach ($relativePath in $changes) {
    $source = Join-Path $SourceRoot $relativePath
    $baseline = Join-Path (Join-Path $TaskDirectory 'baseline-production') $relativePath
    $workspaceCandidates = Get-ChildItem -LiteralPath $TaskDirectory -Directory |
      Where-Object { $_.Name -like 'refactor-workspace*' } |
      ForEach-Object { Join-Path $_.FullName $relativePath } |
      Where-Object { Test-Path -LiteralPath $_ }
    if (-not (Test-Path -LiteralPath $baseline)) {
      if (-not (Test-Path -LiteralPath $source)) {
        Write-Output "ROLLBACK=NOT_NEEDED_NEW_FILE_NOT_SYNCED path=$relativePath"
        continue
      }
      $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
      $mirror = @($workspaceCandidates | Where-Object {
        (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash -eq $sourceHash
      } | Select-Object -Last 1)
      if ($mirror.Count -ne 1) {
        Write-Output "ROLLBACK=NOT_NEEDED_NEW_FILE_NOT_SYNCED path=$relativePath"
        continue
      }
      Remove-Item -LiteralPath $source -Force
      if (Test-Path -LiteralPath $source) { throw "Removal verification failed for $relativePath." }
      Write-Output "REMOVED_NEW=$relativePath"
      continue
    }
    if (-not (Test-Path -LiteralPath $source)) {
      throw "Cannot safely restore ${relativePath}: source is absent despite a baseline file."
    }
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    $mirror = @($workspaceCandidates | Where-Object {
      (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash -eq $sourceHash
    } | Select-Object -Last 1)
    if ($mirror.Count -ne 1) {
      throw "Cannot safely restore ${relativePath}: source no longer matches a task refactor mirror."
    }
    Copy-Item -LiteralPath $baseline -Destination $source -Force
    $restoredHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    $baselineHash = (Get-FileHash -LiteralPath $baseline -Algorithm SHA256).Hash
    if ($restoredHash -ne $baselineHash) { throw "Restore verification failed for $relativePath." }
    Write-Output "RESTORED=$relativePath"
  }
}

if ($StartOrdinal -lt 1 -or $EndOrdinal -lt $StartOrdinal) { throw 'Ordinal range is invalid.' }

$env:PYTHONPATH = Join-Path $repoRoot 'src'
$records = Get-Content -LiteralPath $dataset -Raw -Encoding utf8 | ConvertFrom-Json
$flattened = [System.Collections.Generic.List[object]]::new()
for ($recordIndex = 0; $recordIndex -lt $records.Count; $recordIndex++) {
  $inputRecord = $records[$recordIndex]
  foreach ($inputMessage in @($inputRecord.messages)) {
    [void]$flattened.Add([pscustomobject]@{
      filePath = ([string]$inputRecord.filePath)
      sourceProject = ([string]$inputRecord.sourceProject)
      commitHash = ([string]$inputRecord.commitHash)
      messages = @($inputMessage)
    })
  }
}
if ($EndOrdinal -gt $flattened.Count) { throw "Dataset contains only $($flattened.Count) flattened smells." }

Set-Location -LiteralPath $homecheckParent
Write-Output "FLATTENED count=$($flattened.Count)"
$pythonExe = (Get-Command python -ErrorAction Stop).Source
for ($ordinal = $StartOrdinal; $ordinal -le $EndOrdinal; $ordinal++) {
  $selectedItem = $flattened[($ordinal - 1)]
  $selection = (@($selectedItem) | ConvertTo-Json -Depth 12 -Compress) -join ''
  Write-Output "SELECTED ordinal=$ordinal file=$($selectedItem.filePath)"
  if ($ListOnly) { continue }
  $started = Get-Date
  Write-Output "BEGIN ordinal=$ordinal at=$($started.ToString('o'))"
  $inputFile = Join-Path $env:TEMP "arkts-long-method-input-$PID-$ordinal.json"
  [System.IO.File]::WriteAllText($inputFile, $selection + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
  $command = "type `"$inputFile`" | `"$pythonExe`" -m arkts_smell_refactor start --workspace `"$workspace`""
  & $env:ComSpec /d /c $command
  $exitCode = $LASTEXITCODE
  Remove-Item -LiteralPath $inputFile -Force
  $run = Get-ChildItem -LiteralPath (Join-Path $repoRoot 'runs') -Directory |
    Where-Object { $_.CreationTime -ge $started.AddSeconds(-2) } |
    Sort-Object CreationTime -Descending | Select-Object -First 1
  if (-not $run) { throw "No run directory found for ordinal $ordinal." }
  $task = Get-ChildItem -LiteralPath $run.FullName -Directory | Select-Object -First 1
  $resultFile = Join-Path $task.FullName 'result.json'
  if (-not (Test-Path -LiteralPath $resultFile)) { throw "Task $ordinal ended without result.json." }
  $result = Get-Content -LiteralPath $resultFile -Raw -Encoding utf8 | ConvertFrom-Json
  $taskSpec = Get-Content -LiteralPath (Join-Path $task.FullName 'task.json') -Raw -Encoding utf8 | ConvertFrom-Json
  $targetPath = Join-Path $workspace $taskSpec.target.file_path
  $sourceRoot = Get-HarmonyProjectRoot $targetPath $taskSpec.project_root
  if (-not $sourceRoot) { throw "No Harmony project root found for ordinal $ordinal." }
  $completed = (Get-Item -LiteralPath $resultFile).LastWriteTime
  Write-Output "RESULT ordinal=$ordinal verdict=$($result.verdict) pipelineExit=$exitCode totalSeconds=$([math]::Round(($completed - $started).TotalSeconds, 3)) task=$($task.FullName)"
  Restore-ChangedProductionFiles $task.FullName $sourceRoot
  Write-Output "END ordinal=$ordinal"
}
