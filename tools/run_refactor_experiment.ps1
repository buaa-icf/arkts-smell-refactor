# Shared implementation for the four dataset-specific experiment entry points.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('long-method', 'code-clone')]
  [string]$SmellType,
  [Parameter(Mandatory = $true)]
  [ValidateSet('local-test', 'instrument-test')]
  [string]$DatasetKind,
  [ValidateRange(1, 2147483647)]
  [int]$StartOrdinal = 1,
  [ValidateRange(0, 2147483647)]
  [int]$EndOrdinal = 0,
  [ValidateSet('required', 'skip')]
  [string]$LinterMode = 'skip',
  [switch]$ListOnly,
  [string]$DatasetRoot = '',
  [string]$Workspace = 'D:\arktsProgram',
  [string]$HomeCheckRoot = '',
  [string]$NodeExe = 'node',
  [string]$LogDirectory = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Path $PSScriptRoot -Parent
$groupRoot = Split-Path -Path $repoRoot -Parent
. (Join-Path $PSScriptRoot 'task_source_rollback.ps1')

if (-not $DatasetRoot) {
  $DatasetRoot = Join-Path $groupRoot 'arkts-code-smell\dataset\positive'
}
$dataset = Join-Path (Join-Path $DatasetRoot $DatasetKind) "$SmellType.json"
$dataset = (Resolve-Path -LiteralPath $dataset).Path
# Do not wrap ConvertFrom-Json in @(...): Windows PowerShell 5.1 emits
# a JSON array as one pipeline object, which would nest all source records.
$records = Get-Content -LiteralPath $dataset -Raw -Encoding utf8 | ConvertFrom-Json
$flattened = [System.Collections.Generic.List[object]]::new()
foreach ($record in $records) {
  if (-not $record.filePath -or -not $record.messages) {
    throw 'Each dataset record must contain filePath and non-empty messages.'
  }
  foreach ($message in @($record.messages)) {
    [void]$flattened.Add([pscustomobject]@{
      filePath = [string]$record.filePath
      sourceProject = [string]$record.sourceProject
      commitHash = [string]$record.commitHash
      messages = @($message)
    })
  }
}
if ($EndOrdinal -eq 0) { $EndOrdinal = $flattened.Count }
if ($EndOrdinal -lt $StartOrdinal -or $EndOrdinal -gt $flattened.Count) {
  throw "Invalid ordinal range $StartOrdinal..$EndOrdinal; dataset contains $($flattened.Count) flattened smells."
}

function Get-HarmonyProjectRoot([string]$TargetPath, [string]$WorkspaceRoot) {
  $current = Split-Path -Path $TargetPath -Parent
  while ($current) {
    if ((Test-Path -LiteralPath (Join-Path $current 'build-profile.json5')) -and
        (Test-Path -LiteralPath (Join-Path $current 'hvigor\hvigor-config.json5'))) {
      return $current
    }
    if ($current -eq $WorkspaceRoot) { break }
    $parent = Split-Path -Path $current -Parent
    if ($parent -eq $current) { break }
    $current = $parent
  }
  return $null
}

function Invoke-ExperimentBatch {
  Write-Output "EXPERIMENT smell=$SmellType datasetKind=$DatasetKind linterMode=$LinterMode"
  Write-Output "DATASET=$dataset"
  Write-Output "FLATTENED count=$($flattened.Count)"
  if ($ListOnly) {
    for ($ordinal = $StartOrdinal; $ordinal -le $EndOrdinal; $ordinal++) {
      Write-Output "SELECTED ordinal=$ordinal file=$($flattened[$ordinal - 1].filePath)"
    }
    return
  }

  $workspaceRoot = (Resolve-Path -LiteralPath $Workspace).Path
  $checkerRoot = $HomeCheckRoot
  if (-not $checkerRoot) { $checkerRoot = $repoRoot }
  $checkerRoot = (Resolve-Path -LiteralPath $checkerRoot).Path
  $nodeCommand = (Get-Command $NodeExe -ErrorAction Stop).Source
  $cliPath = Join-Path $repoRoot 'dist\cli.js'
  if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    throw "Missing $cliPath. Run 'npm install' and 'npm run build' in $repoRoot first."
  }
  $runsRoot = Join-Path $repoRoot 'runs'
  $tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
  Push-Location -LiteralPath $checkerRoot
  try {
    for ($ordinal = $StartOrdinal; $ordinal -le $EndOrdinal; $ordinal++) {
      $item = $flattened[$ordinal - 1]
      $selection = ConvertTo-Json -InputObject @($item) -Depth 12 -Compress
      Write-Output "SELECTED ordinal=$ordinal file=$($item.filePath)"
      $started = Get-Date
      $targetPath = Get-RollbackTargetPath $workspaceRoot $item.filePath
      if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
        throw "Target source file does not exist: $targetPath"
      }
      $sourceRoot = Get-HarmonyProjectRoot $targetPath $workspaceRoot
      if (-not $sourceRoot) { throw "No Harmony project root found for ordinal $ordinal." }
      $snapshotName = "arkts-$SmellType-$DatasetKind-snapshot-$PID-$ordinal-$([guid]::NewGuid().ToString('N'))"
      $snapshotTemp = Get-RollbackTargetPath $tempRoot $snapshotName
      New-TaskSourceSnapshot $sourceRoot $snapshotTemp | Write-Output
      Write-Output "BEGIN ordinal=$ordinal at=$($started.ToString('o'))"
      Write-Output "INPUT ordinal=$ordinal bytes=$([System.Text.Encoding]::UTF8.GetByteCount($selection))"
      $rollbackCompleted = $false
      try {
        $beforeRuns = @()
        if (Test-Path -LiteralPath $runsRoot) {
          $beforeRuns = @(Get-ChildItem -LiteralPath $runsRoot -Directory | ForEach-Object { $_.FullName })
        }
        # UTF-8 is set before the pipeline, including PowerShell 5.1 native stdin.
        # Pass arguments directly, without interpolating dataset text into shell code.
        $selection | & $nodeCommand $cliPath start --workspace $workspaceRoot --linter-mode $LinterMode
        $exitCode = $LASTEXITCODE
        # The TS CLI returns 2 for a completed non-PASS task as well as errors.
        # Continue only after checking this invocation's result and task identity.
        if ($exitCode -notin @(0, 2)) { throw "Pipeline exited with code $exitCode for ordinal $ordinal." }
        $newRuns = @(Get-ChildItem -LiteralPath $runsRoot -Directory | Where-Object { $beforeRuns -notcontains $_.FullName })
        if ($newRuns.Count -ne 1) {
          throw "Expected one new run for ordinal $ordinal, found $($newRuns.Count). Run experiment batches sequentially."
        }
        $tasks = @(Get-ChildItem -LiteralPath $newRuns[0].FullName -Directory)
        if ($tasks.Count -ne 1) { throw "Expected one task directory for ordinal $ordinal." }
        $task = $tasks[0]
        $resultFile = Join-Path $task.FullName 'result.json'
        if (-not (Test-Path -LiteralPath $resultFile)) { throw "Task $ordinal ended without result.json." }
        $result = Get-Content -LiteralPath $resultFile -Raw -Encoding utf8 | ConvertFrom-Json
        $taskSpec = Get-Content -LiteralPath (Join-Path $task.FullName 'task.json') -Raw -Encoding utf8 | ConvertFrom-Json
        if ($result.verdict -notin @('PASS', 'FAIL', 'BLOCKED', 'INCOMPLETE')) {
          throw "Invalid task verdict for ordinal ${ordinal}: $($result.verdict)"
        }
        $expectedExitCode = if ($result.verdict -eq 'PASS') { 0 } else { 2 }
        if ($exitCode -ne $expectedExitCode) {
          throw "Pipeline exit code $exitCode contradicts verdict $($result.verdict) for ordinal $ordinal."
        }
        if ($result.taskId -ne $taskSpec.task_id) {
          throw "Result task identity does not match task.json for ordinal $ordinal."
        }
        if ($taskSpec.target.file_path -ne $item.filePath -or $taskSpec.smell_type -ne $SmellType) {
          throw "Task output does not match the selected dataset item for ordinal $ordinal."
        }
        $actualRoot = Get-HarmonyProjectRoot (Get-RollbackTargetPath $workspaceRoot $taskSpec.target.file_path) $workspaceRoot
        if ($actualRoot -ne $sourceRoot) { throw "Task source root differs from its pre-run snapshot for ordinal $ordinal." }

        $metadata = [pscustomobject]@{
          dataset = $dataset; datasetKind = $DatasetKind; smellType = $SmellType
          ordinal = $ordinal; linterMode = $LinterMode; batchSourceMode = 'powershell-snapshot'
        }
        [System.IO.File]::WriteAllText((Join-Path $task.FullName 'experiment.json'), ($metadata | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
        $completed = (Get-Item -LiteralPath $resultFile).LastWriteTime
        Write-Output "RESULT ordinal=$ordinal verdict=$($result.verdict) pipelineExit=$exitCode totalSeconds=$([math]::Round(($completed - $started).TotalSeconds, 3)) task=$($task.FullName)"
        # Keep the only recovery copy at its known location until restoration has succeeded.
        Restore-TaskSourceSnapshot $sourceRoot $snapshotTemp
        $rollbackCompleted = $true
        [void](Get-RollbackRelativePath $tempRoot $snapshotTemp)
        [void](Get-RollbackRelativePath $runsRoot $task.FullName)
        $snapshotPath = Get-RollbackTargetPath $runsRoot (Join-Path (Get-RollbackRelativePath $runsRoot $task.FullName) 'pre-run-production-baseline')
        Move-Item -LiteralPath $snapshotTemp -Destination $snapshotPath -ErrorAction Stop
        Write-Output "END ordinal=$ordinal"
      } finally {
        if (-not $rollbackCompleted) {
          Write-Output "ROLLBACK=RECOVERY_FROM_SNAPSHOT path=$snapshotTemp"
          Restore-TaskSourceSnapshot $sourceRoot $snapshotTemp
        }
      }
    }
  } finally {
    Pop-Location
  }
}

$previousInputEncoding = [Console]::InputEncoding
$previousOutputEncoding = [Console]::OutputEncoding
$previousPipeEncoding = $OutputEncoding
try {
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  [Console]::InputEncoding = $utf8
  [Console]::OutputEncoding = $utf8
  $OutputEncoding = $utf8
  if ($LogDirectory) {
    New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
    $log = Join-Path (Resolve-Path -LiteralPath $LogDirectory).Path ('output' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.log')
    if (Test-Path -LiteralPath $log) { throw "Log file already exists: $log" }
    Write-Host "LOG_FILE=$log"
    & { Invoke-ExperimentBatch } *>&1 | Tee-Object -FilePath $log
  } else {
    Invoke-ExperimentBatch
  }
} finally {
  [Console]::InputEncoding = $previousInputEncoding
  [Console]::OutputEncoding = $previousOutputEncoding
  $OutputEncoding = $previousPipeEncoding
}
