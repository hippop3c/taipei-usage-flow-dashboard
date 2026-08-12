[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9]{4}-(0[1-9]|1[0-2])$')]
  [string]$Period,
  [string]$DriveRoot = 'E:\',
  [string]$StationData = '',
  [string]$Output = '',
  [switch]$Force,
  [ValidateRange(0, 10000)][int]$LimitFiles = 0
)

$ErrorActionPreference = 'Stop'

function S([int[]]$Points) { return -join @($Points | ForEach-Object { [char]$_ }) }

$project = Split-Path -Parent $PSScriptRoot
$culture = [Globalization.CultureInfo]::InvariantCulture
$firstDay = [datetime]::ParseExact(($Period + '-01'), 'yyyy-MM-dd', $culture)
$lastDay = $firstDay.AddMonths(1).AddDays(-1)
$sourcePattern = $firstDay.ToString('yyyyMMdd', $culture) + '-' + $lastDay.ToString('yyyyMMdd', $culture) + '_*.accdb'
$workerPeriod = $Period.Replace('-', '/')

if (-not $StationData) { $StationData = Join-Path (Split-Path -Parent $project) 'youbike-hourly-heatmap\data.js' }
if (-not $Output) { $Output = Join-Path $project 'public\subsidy-data.js' }
$monthOutput = Join-Path (Join-Path (Join-Path $project 'public\months') $Period) 'usage.json'

$monthsRoot = Join-Path $project 'work\months'
$checkpointDir = Join-Path (Join-Path $monthsRoot $Period) 'usage'
$auditDir = Join-Path $project 'work\audits'
$audit = Join-Path $auditDir ($Period + '-usage-merge.json')
[IO.Directory]::CreateDirectory($checkpointDir) | Out-Null
[IO.Directory]::CreateDirectory($auditDir) | Out-Null

$worker = Join-Path $PSScriptRoot 'read-accdb-fast.ps1'
$merge = Join-Path $PSScriptRoot 'merge-data.mjs'
$ps32 = Join-Path $env:WINDIR 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
$node = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
if (-not $node) { $node = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Node.js not found' }
if (-not (Test-Path -LiteralPath $ps32 -PathType Leaf)) { throw '32-bit Windows PowerShell not found' }
if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) { throw 'Usage worker not found' }
if (-not (Test-Path -LiteralPath $StationData -PathType Leaf)) { throw "Station data not found: $StationData" }
if (-not (Test-Path -LiteralPath $DriveRoot -PathType Container)) { throw "Drive root not found: $DriveRoot" }

$files = @(Get-ChildItem -LiteralPath $DriveRoot -Recurse -File -Filter $sourcePattern | Sort-Object FullName)
if ($LimitFiles -gt 0) { $files = @($files | Select-Object -First $LimitFiles) }
if ($files.Count -eq 0) { throw "No Access reports matched $sourcePattern under $DriveRoot" }

Write-Output "USAGE PERIOD $Period pattern=$sourcePattern files=$($files.Count)"
$utf8 = [Text.Encoding]::UTF8
$sha = [Security.Cryptography.SHA256]::Create()
$i = 0
try {
  foreach ($file in $files) {
    $i++
    $hash = [BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($file.FullName))).Replace('-', '').Substring(0, 16).ToLowerInvariant()
    $checkpoint = Join-Path $checkpointDir ($hash + '.json')
    if ((Test-Path -LiteralPath $checkpoint -PathType Leaf) -and -not $Force) {
      Write-Output "RESUME [$i/$($files.Count)] $($file.Name)"
      continue
    }
    $newTaipei = S @(0x65B0, 0x5317, 0x5E02)
    $taipei = S @(0x53F0, 0x5317, 0x5E02)
    $city = if ($file.FullName.Contains($newTaipei)) { $newTaipei } else { $taipei }
    Write-Output "READ [$i/$($files.Count)] $($file.Name)"
    & $ps32 -NoProfile -ExecutionPolicy Bypass -File $worker -Path $file.FullName -City $city -Output $checkpoint -Period $workerPeriod
    if ($LASTEXITCODE -ne 0) { throw "Worker failed: $($file.FullName)" }
  }
}
finally {
  $sha.Dispose()
}

$extraStations = Join-Path $project 'work\station-master.json'
if (Test-Path -LiteralPath $extraStations -PathType Leaf) {
  & $node $merge $Period $checkpointDir $StationData $monthOutput $Output $audit $extraStations
}
else {
  & $node $merge $Period $checkpointDir $StationData $monthOutput $Output $audit
}
if ($LASTEXITCODE -ne 0) { throw 'Usage merge failed' }
Write-Output "USAGE COMPLETE period=$Period checkpoints=$checkpointDir month=$monthOutput manifest=$Output audit=$audit"
