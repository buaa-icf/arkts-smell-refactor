#Requires -Version 5.1
<#
.SYNOPSIS
Run a range of ArkTS Skill experiments, one case at a time.
.DESCRIPTION
Supply the JSON file via -Dataset. Set workspaceRoot in that file to the
directory containing the source repositories, or pass -Workspace explicitly.
With no range specified, the runner processes the entire dataset.
.PARAMETER Recover
Recover the last interrupted case after confirming that its agent, build and
device processes have all exited. Run this without a dataset or range.
.PARAMETER Config
Optional JSON tool settings for the portable Skill.
.EXAMPLE
.\run_batch_100.ps1 -Dataset .\batch-100.json -ListOnly
.EXAMPLE
.\run_batch_100.ps1 -Dataset .\batch-100.json -StartOrdinal 21 -EndOrdinal 40
.EXAMPLE
.\run_batch_100.ps1 -Recover
#>
[CmdletBinding(DefaultParameterSetName = 'Run')]
param(
  [Parameter(Mandatory = $true, ParameterSetName = 'Run')]
  [Alias('DatasetPath')]
  [string]$Dataset,
  [Parameter(ParameterSetName = 'Run')][string]$Workspace,
  [Parameter(ParameterSetName = 'Run')]
  [ValidateRange(1, 2147483647)]
  [int]$StartOrdinal = 1,
  [Parameter(ParameterSetName = 'Run')][ValidateRange(0, 2147483647)]
  [int]$EndOrdinal = 0,
  [Parameter(ParameterSetName = 'Run')][switch]$ListOnly,
  [Parameter(Mandatory = $true, ParameterSetName = 'Recover')][switch]$Recover,
  [string]$SkillDirectory,
  [Parameter(ParameterSetName = 'Run')][Alias('LogDirectory')]
  [string]$OutputDirectory,
  [Parameter(ParameterSetName = 'Run')][string]$Config,
  [string]$NodeExe = 'node'
)

$ErrorActionPreference = 'Stop'
if (-not $SkillDirectory) {
  $SkillDirectory = Join-Path $PSScriptRoot 'arkts-smell-refactor'
  if (-not (Test-Path -LiteralPath (Join-Path $SkillDirectory 'scripts/batch-100-runner.mjs') -PathType Leaf)) {
    $configHome = $env:XDG_CONFIG_HOME
    if (-not $configHome) { $configHome = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.config' }
    $SkillDirectory = Join-Path $configHome 'deveco/skills/arkts-smell-refactor'
  }
}
$runner = Join-Path $SkillDirectory 'scripts/batch-100-runner.mjs'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
  throw "Batch runner missing at '$runner'. Extract the complete Skill release next to this script, or pass -SkillDirectory."
}
$node = Get-Command $NodeExe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) { throw 'Node.js 20.19 or newer is required. Set PATH or pass -NodeExe.' }

if ($Recover) {
  & $node.Source $runner '--recover'
  exit $LASTEXITCODE
}
$runnerArgs = @($runner, '--dataset', $Dataset, '--skill-dir', $SkillDirectory, '--start', "$StartOrdinal")
if ($EndOrdinal -gt 0) { $runnerArgs += @('--end', "$EndOrdinal") }
if ($Workspace) { $runnerArgs += @('--workspace', $Workspace) }
if ($OutputDirectory) { $runnerArgs += @('--output', $OutputDirectory) }
if ($Config) { $runnerArgs += @('--config', $Config) }
if ($ListOnly) { $runnerArgs += '--list' }
& $node.Source @runnerArgs
exit $LASTEXITCODE
