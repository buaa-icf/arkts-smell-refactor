# Run the code-clone samples from the local-test dataset.
[CmdletBinding()]
param(
  [int]$StartOrdinal = 1,
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

& (Join-Path $PSScriptRoot 'run_refactor_experiment.ps1') -SmellType 'code-clone' -DatasetKind 'local-test' @PSBoundParameters
