[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9]{4}-(0[1-9]|1[0-2])$')]
  [string]$Period,
  [string]$DriveRoot = 'E:\',
  [string]$StationData = '',
  [switch]$Force,
  [ValidateRange(0, 10000)][int]$LimitFiles = 0
)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$usageRunner = Join-Path $PSScriptRoot 'run-etl-fast.ps1'
$odRunner = Join-Path $PSScriptRoot 'run-od-etl.ps1'
$flowBuilder = Join-Path $PSScriptRoot 'build-flow-files.mjs'
$manifest = Join-Path $project 'public\subsidy-data.js'
$monthRoot = Join-Path (Join-Path $project 'public\months') $Period
$usage = Join-Path $monthRoot 'usage.json'
$flows = Join-Path $monthRoot 'flows'
$workMonth = Join-Path (Join-Path $project 'work\months') $Period
$od = Join-Path $workMonth 'od'
$stage = Join-Path $workMonth 'flow-stage'
$auditDir = Join-Path $project 'work\audits'
$flowAudit = Join-Path $auditDir ($Period + '-flow-build.json')
[IO.Directory]::CreateDirectory($auditDir) | Out-Null

$usageArgs = @{
  Period = $Period
  DriveRoot = $DriveRoot
  LimitFiles = $LimitFiles
}
if ($StationData) { $usageArgs.StationData = $StationData }
if ($Force) { $usageArgs.Force = $true }

$odArgs = @{
  Period = $Period
  DriveRoot = $DriveRoot
  LimitFiles = $LimitFiles
}
if ($Force) { $odArgs.Force = $true }

Write-Output "UPDATE START period=$Period root=$DriveRoot"
& $usageRunner @usageArgs
& $odRunner @odArgs

$node = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
if (-not $node) { $node = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Node.js not found' }

& $node $flowBuilder $Period $od $manifest $usage $flows $flowAudit $stage
if ($LASTEXITCODE -ne 0) { throw 'Monthly flow build failed' }
Write-Output "UPDATE COMPLETE period=$Period usage=$usage flows=$flows manifest=$manifest audits=$auditDir"
