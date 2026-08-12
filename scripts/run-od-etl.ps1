[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9]{4}-(0[1-9]|1[0-2])$')]
  [string]$Period,
  [string]$DriveRoot = 'E:\',
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
$checkpointDir = Join-Path (Join-Path (Join-Path $project 'work\months') $Period) 'od'
[IO.Directory]::CreateDirectory($checkpointDir) | Out-Null

$worker = Join-Path $PSScriptRoot 'read-od-fast.ps1'
$ps32 = Join-Path $env:WINDIR 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $ps32 -PathType Leaf)) { throw '32-bit Windows PowerShell not found' }
if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) { throw 'OD worker not found' }
if (-not (Test-Path -LiteralPath $DriveRoot -PathType Container)) { throw "Drive root not found: $DriveRoot" }

$files = @(Get-ChildItem -LiteralPath $DriveRoot -Recurse -File -Filter $sourcePattern | Sort-Object FullName)
if ($LimitFiles -gt 0) { $files = @($files | Select-Object -First $LimitFiles) }
if ($files.Count -eq 0) { throw "No Access reports matched $sourcePattern under $DriveRoot" }

Write-Output "OD PERIOD $Period pattern=$sourcePattern files=$($files.Count)"
$utf8 = [Text.Encoding]::UTF8
$sha = [Security.Cryptography.SHA256]::Create()
$i = 0
try {
  foreach ($file in $files) {
    $i++
    $hash = [BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($file.FullName))).Replace('-', '').Substring(0, 16).ToLowerInvariant()
    $rows = Join-Path $checkpointDir ($hash + '.tsv')
    $audit = Join-Path $checkpointDir ($hash + '.audit.json')
    if ((Test-Path -LiteralPath $rows -PathType Leaf) -and (Test-Path -LiteralPath $audit -PathType Leaf) -and -not $Force) {
      Write-Output "RESUME [$i/$($files.Count)] $($file.Name)"
      continue
    }
    $newTaipei = S @(0x65B0, 0x5317, 0x5E02)
    $taipei = S @(0x53F0, 0x5317, 0x5E02)
    $city = if ($file.FullName.Contains($newTaipei)) { $newTaipei } else { $taipei }
    Write-Output "READ [$i/$($files.Count)] $($file.Name)"
    & $ps32 -NoProfile -ExecutionPolicy Bypass -File $worker -Path $file.FullName -City $city -OutputRows $rows -OutputAudit $audit -Period $workerPeriod
    if ($LASTEXITCODE -ne 0) { throw "OD worker failed: $($file.FullName)" }
  }
}
finally {
  $sha.Dispose()
}

Write-Output "OD COMPLETE period=$Period files=$($files.Count) checkpoints=$checkpointDir"
