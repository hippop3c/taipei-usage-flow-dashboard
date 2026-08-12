param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$City,
  [Parameter(Mandatory = $true)][string]$OutputRows,
  [Parameter(Mandatory = $true)][string]$OutputAudit,
  [string]$Period = '2026/06'
)
$ErrorActionPreference = 'Stop'

function S([int[]]$Points) { return -join @($Points | ForEach-Object { [char]$_ }) }
function Q([string]$Value) { return '[' + $Value.Replace(']', ']]') + ']' }
function Normalize-StationId([string]$Value) {
  $id = ($Value -replace '[^0-9]', '')
  if ($id -match '^0[0-9]{6}$') { return '500' + $id.Substring(1) }
  return $id
}

$n = @{
  claim = S @(0x8ACB,0x6B3E,0x8CC7,0x6599)
  tpassTable = S @(0x5317,0x5317,0x57FA,0x6843,0x5B9A,0x671F,0x7968)
  single = S @(0x55AE,0x6B21,0x79DF,0x8ECA)
  noSubsidy = S @(0x4E0D,0x88DC,0x52A9)
  voucher = S @(0x9A0E,0x4E58,0x5238)
  compensation = S @(0x88DC,0x511F,0x5238)
  multiPay = S @(0x591A,0x5143,0x652F,0x4ED8,0x88DC,0x7E73)
  activityAt = S @(0x501F,0x8ECA,0x6642,0x9593)
  originId = S @(0x501F,0x8ECA,0x7AD9,0x4EE3,0x865F)
  destinationId = S @(0x9084,0x8ECA,0x7AD9,0x4EE3,0x865F)
}

$connection = New-Object System.Data.OleDb.OleDbConnection("Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$Path;Mode=Read;")
$connection.Open()
$temporaryRows = $OutputRows + '.tmp'
try {
  $allColumns = @($connection.GetSchema('Columns'))
  $allTables = @($connection.GetSchema('Tables') | Where-Object { $_.TABLE_TYPE -eq 'TABLE' -and ([string]$_.TABLE_NAME) -notlike 'MSys*' } | ForEach-Object { [string]$_.TABLE_NAME })
  $isTpass = @($allTables | Where-Object { $_.Contains($n.tpassTable) }).Count -gt 0
  $candidateNames = if ($isTpass) { @($allTables | Where-Object { $_.Contains($n.tpassTable) }) } else { @($allTables | Where-Object { $_.Contains($n.claim) }) }
  $selected = @(); $excluded = @()
  foreach ($table in $allTables) {
    $columns = @($allColumns | Where-Object { [string]$_.TABLE_NAME -eq $table } | Sort-Object ORDINAL_POSITION | ForEach-Object { [string]$_.COLUMN_NAME })
    if ($candidateNames -notcontains $table) { $excluded += [ordered]@{table=$table;reason='not-a-claim-table'}; continue }
    $blocked = $table.Contains($n.single) -or $table.Contains($n.noSubsidy) -or $table.Contains($n.voucher) -or $table.Contains($n.compensation) -or $table.Contains($n.multiPay)
    if ($blocked) { $excluded += [ordered]@{table=$table;reason='derived-or-non-subsidy-table'}; continue }
    if (($columns -notcontains $n.activityAt) -or ($columns -notcontains $n.originId) -or ($columns -notcontains $n.destinationId)) {
      $excluded += [ordered]@{table=$table;reason='missing-od-columns'}; continue
    }
    $selected += [ordered]@{Name=$table;Columns=$columns}
  }
  if ($selected.Count -eq 0) { throw "No eligible OD table found in $Path" }

  $directory = Split-Path -Parent $OutputRows; if ($directory) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
  $writer = New-Object IO.StreamWriter($temporaryRows,$false,(New-Object Text.UTF8Encoding($false)))
  $tableAudit = @(); $allClaims = 0L; $allDistinct = 0L; $missingEndpointClaims = 0L
  try {
    foreach ($item in $selected) {
      $table = [string]$item.Name
      $sourceCountCmd = $connection.CreateCommand(); $sourceCountCmd.CommandTimeout = 0; $sourceCountCmd.CommandText = 'SELECT Count(*) FROM ' + (Q $table)
      $sourceRows = [long]$sourceCountCmd.ExecuteScalar()
      $sql = 'SELECT Left(' + (Q $n.activityAt) + ',10) AS activity_date, Mid(' + (Q $n.activityAt) + ',12,2) AS activity_hour, ' +
        (Q $n.originId) + ' AS origin_id, ' + (Q $n.destinationId) + ' AS destination_id, Count(*) AS claim_count FROM ' +
        (Q $table) + ' WHERE ' + (Q $n.activityAt) + " Like '$Period/%' GROUP BY Left(" + (Q $n.activityAt) + ',10), Mid(' +
        (Q $n.activityAt) + ',12,2), ' + (Q $n.originId) + ', ' + (Q $n.destinationId)
      $cmd = $connection.CreateCommand(); $cmd.CommandTimeout = 0; $cmd.CommandText = $sql
      $reader = $cmd.ExecuteReader(); $tableClaims = 0L; $tableDistinct = 0L; $tableMissing = 0L
      try {
        while ($reader.Read()) {
          $date = ([string]$reader['activity_date']).Replace('/','-'); $hour = [int]([string]$reader['activity_hour'])
          $originId = Normalize-StationId ([string]$reader['origin_id']); $destinationId = Normalize-StationId ([string]$reader['destination_id'])
          $count = [long]$reader['claim_count']; $tableClaims += $count; $tableDistinct++
          if (-not $originId -or -not $destinationId) { $tableMissing += $count; continue }
          $writer.Write($date); $writer.Write("`t"); $writer.Write($hour); $writer.Write("`t"); $writer.Write($originId)
          $writer.Write("`t"); $writer.Write($destinationId); $writer.Write("`t"); $writer.WriteLine($count)
        }
      } finally { $reader.Close() }
      $allClaims += $tableClaims; $allDistinct += $tableDistinct; $missingEndpointClaims += $tableMissing
      $tableAudit += [ordered]@{table=$table;sourceRows=$sourceRows;claims=$tableClaims;excludedActivityOutsidePeriod=($sourceRows-$tableClaims);distinctOdRows=$tableDistinct;missingEndpointClaims=$tableMissing}
    }
  } finally { $writer.Close() }

  if ([IO.File]::Exists($OutputRows)) { [IO.File]::Delete($OutputRows) }
  [IO.File]::Move($temporaryRows,$OutputRows)
  $audit = [ordered]@{source=$Path;city=$City;period=$Period.Replace('/','-');tables=$tableAudit;excludedTables=$excluded;claims=$allClaims;distinctOdRows=$allDistinct;missingEndpointClaims=$missingEndpointClaims}
  [IO.File]::WriteAllText($OutputAudit,($audit|ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
  Write-Output ("DONE`t$Path`t$allDistinct OD rows`t$allClaims claims")
} finally {
  $connection.Close()
  if ([IO.File]::Exists($temporaryRows)) { [IO.File]::Delete($temporaryRows) }
}
