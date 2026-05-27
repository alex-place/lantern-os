<#
.SYNOPSIS
  Imports a manually exported Apple Wallet / Apple Card / Apple Cash CSV into the
  Lantern local cash wallet ledger format.

.DESCRIPTION
  This script does NOT move money. It does not log in to Apple, Apple Wallet,
  Apple Cash, Apple Card, banks, cards, or payment networks. It imports a CSV
  that the operator manually exported or requested through official channels,
  normalizes transaction rows, writes a local JSONL import ledger, and can
  optionally append reviewed import events to data/wallet/ledger.jsonl.

  Lantern wallet type remains: local_ledger_not_bank_or_crypto_wallet.

  Default mode is safe/dry local import only. Use -AppendToLedger only when the
  CSV has been reviewed and the operator wants local ledger rows appended.

.PARAMETER CsvPath
  Path to the manually exported CSV file.

.PARAMETER SourceType
  apple_card_statement, apple_cash_statement, apple_wallet_manual, or generic_csv.

.PARAMETER OutputPath
  JSONL output file for normalized import rows. Defaults to data/wallet/imports.

.PARAMETER SummaryPath
  JSON summary output. Defaults next to OutputPath.

.PARAMETER LedgerPath
  Lantern wallet ledger path. Defaults to data/wallet/ledger.jsonl.

.PARAMETER AppendToLedger
  Append normalized import events to the Lantern local wallet ledger.

.PARAMETER ImportId
  Stable import ID. Defaults to timestamped apple-wallet import ID.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Import-AppleWalletExport.ps1 `
    -CsvPath "$env:USERPROFILE\Downloads\apple-card-statement.csv" `
    -SourceType apple_card_statement

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Import-AppleWalletExport.ps1 `
    -CsvPath "$env:USERPROFILE\Downloads\apple-cash-statement.csv" `
    -SourceType apple_cash_statement `
    -AppendToLedger
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$CsvPath,

  [Parameter(Mandatory = $false)]
  [ValidateSet('apple_card_statement', 'apple_cash_statement', 'apple_wallet_manual', 'generic_csv')]
  [string]$SourceType = 'generic_csv',

  [Parameter(Mandatory = $false)]
  [string]$OutputPath,

  [Parameter(Mandatory = $false)]
  [string]$SummaryPath,

  [Parameter(Mandatory = $false)]
  [string]$LedgerPath = 'data/wallet/ledger.jsonl',

  [Parameter(Mandatory = $false)]
  [switch]$AppendToLedger,

  [Parameter(Mandatory = $false)]
  [string]$ImportId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-RepoRoot {
  $here = (Get-Location).Path
  $dir = Get-Item -LiteralPath $here
  while ($null -ne $dir) {
    if (Test-Path -LiteralPath (Join-Path $dir.FullName '.git')) {
      return $dir.FullName
    }
    $dir = $dir.Parent
  }
  return $here
}

function New-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Text)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $hash = $sha.ComputeHash($bytes)
    return (($hash | ForEach-Object { $_.ToString('x2') }) -join '')
  }
  finally {
    $sha.Dispose()
  }
}

function Get-FirstValue {
  param(
    [Parameter(Mandatory = $true)]$Row,
    [Parameter(Mandatory = $true)][string[]]$Names
  )
  foreach ($name in $Names) {
    if ($Row.PSObject.Properties.Name -contains $name) {
      $value = [string]$Row.$name
      if (-not [string]::IsNullOrWhiteSpace($value)) {
        return $value.Trim()
      }
    }
  }
  return $null
}

function Convert-ToNullableDecimal {
  param([AllowNull()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $clean = $Value.Trim()
  $clean = $clean -replace '\$', ''
  $clean = $clean -replace ',', ''
  $clean = $clean -replace '^\((.*)\)$', '-$1'
  $out = 0.0
  if ([decimal]::TryParse($clean, [System.Globalization.NumberStyles]::Number -bor [System.Globalization.NumberStyles]::AllowLeadingSign -bor [System.Globalization.NumberStyles]::AllowDecimalPoint, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$out)) {
    return [decimal]::Round($out, 2)
  }
  return $null
}

function Convert-ToIsoDateOrOriginal {
  param([AllowNull()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $dt = [datetime]::MinValue
  $styles = [System.Globalization.DateTimeStyles]::AssumeLocal
  if ([datetime]::TryParse($Value, [System.Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$dt)) {
    return $dt.ToString('yyyy-MM-dd')
  }
  return $Value.Trim()
}

function Remove-UnsafeText {
  param([AllowNull()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $s = $Value.Trim()
  # Redact long numeric sequences that may be account/card/token fragments.
  $s = $s -replace '\b\d{6,}\b', '[redacted-number]'
  # Remove control chars except tab/newline are not expected in CSV fields.
  $s = $s -replace '[\x00-\x08\x0B\x0C\x0E-\x1F]', ''
  return $s
}

function Convert-RowToLanternEvent {
  param(
    [Parameter(Mandatory = $true)]$Row,
    [Parameter(Mandatory = $true)][int]$Index,
    [Parameter(Mandatory = $true)][string]$ImportId,
    [Parameter(Mandatory = $true)][string]$SourceType
  )

  $date = Get-FirstValue $Row @('Transaction Date', 'Date', 'Posting Date', 'Clearing Date', 'Created Date', 'Time', 'Timestamp')
  $clearingDate = Get-FirstValue $Row @('Clearing Date', 'Posted Date', 'Posting Date')
  $description = Get-FirstValue $Row @('Description', 'Name', 'Merchant', 'Payee', 'Memo', 'Transaction')
  $merchant = Get-FirstValue $Row @('Merchant', 'Name', 'Payee')
  $category = Get-FirstValue $Row @('Category', 'Type', 'Transaction Type')
  $status = Get-FirstValue $Row @('Status', 'State')
  $amountRaw = Get-FirstValue $Row @('Amount (USD)', 'Amount', 'Debit', 'Credit', 'Net Amount', 'Total')
  $amount = Convert-ToNullableDecimal $amountRaw

  # Some CSVs split debit/credit into separate columns.
  if ($null -eq $amount) {
    $debit = Convert-ToNullableDecimal (Get-FirstValue $Row @('Debit', 'Withdrawal', 'Outflow'))
    $credit = Convert-ToNullableDecimal (Get-FirstValue $Row @('Credit', 'Deposit', 'Inflow'))
    if ($null -ne $debit) { $amount = -1 * [math]::Abs($debit) }
    elseif ($null -ne $credit) { $amount = [math]::Abs($credit) }
  }

  $rawJson = $Row | ConvertTo-Json -Compress -Depth 8
  $rawHash = New-Sha256Hex $rawJson

  $direction = 'unknown'
  if ($null -ne $amount) {
    if ($amount -lt 0) { $direction = 'outflow' }
    elseif ($amount -gt 0) { $direction = 'inflow' }
    else { $direction = 'zero' }
  }

  [ordered]@{
    timestamp = (Get-Date).ToString('o')
    event = 'apple_wallet_export_imported_transaction'
    importId = $ImportId
    rowIndex = $Index
    sourceType = $SourceType
    transactionDate = Convert-ToIsoDateOrOriginal $date
    clearingDate = Convert-ToIsoDateOrOriginal $clearingDate
    description = Remove-UnsafeText $description
    merchant = Remove-UnsafeText $merchant
    category = Remove-UnsafeText $category
    amountUsd = $amount
    direction = $direction
    sourceStatus = Remove-UnsafeText $status
    reviewStatus = 'imported_pending_operator_review'
    evidenceClass = 'operator_exported_csv'
    rawRowSha256 = $rawHash
    rawSecretsStored = $false
    walletType = 'local_ledger_not_bank_or_crypto_wallet'
    note = 'Imported from manually supplied CSV. This event does not move money or prove cleared funds.'
  }
}

$repoRoot = Resolve-RepoRoot
if (-not [System.IO.Path]::IsPathRooted($CsvPath)) {
  $CsvPath = Join-Path $repoRoot $CsvPath
}
if (-not (Test-Path -LiteralPath $CsvPath)) {
  throw "CSV not found: $CsvPath"
}

if ([string]::IsNullOrWhiteSpace($ImportId)) {
  $ImportId = 'apple-wallet-import-' + (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssZ')
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $OutputPath = Join-Path $repoRoot ("data/wallet/imports/$ImportId.jsonl")
} elseif (-not [System.IO.Path]::IsPathRooted($OutputPath)) {
  $OutputPath = Join-Path $repoRoot $OutputPath
}

if ([string]::IsNullOrWhiteSpace($SummaryPath)) {
  $SummaryPath = [System.IO.Path]::ChangeExtension($OutputPath, '.summary.json')
} elseif (-not [System.IO.Path]::IsPathRooted($SummaryPath)) {
  $SummaryPath = Join-Path $repoRoot $SummaryPath
}

if (-not [System.IO.Path]::IsPathRooted($LedgerPath)) {
  $LedgerPath = Join-Path $repoRoot $LedgerPath
}

$outputDir = Split-Path -Parent $OutputPath
$summaryDir = Split-Path -Parent $SummaryPath
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
New-Item -ItemType Directory -Force -Path $summaryDir | Out-Null

$rows = Import-Csv -LiteralPath $CsvPath
if ($rows.Count -eq 0) {
  throw "CSV contains no data rows: $CsvPath"
}

$events = New-Object System.Collections.Generic.List[object]
$i = 0
foreach ($row in $rows) {
  $i += 1
  $events.Add((Convert-RowToLanternEvent -Row $row -Index $i -ImportId $ImportId -SourceType $SourceType))
}

if ($PSCmdlet.ShouldProcess($OutputPath, 'write normalized Lantern wallet import JSONL')) {
  $events | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 } | Set-Content -LiteralPath $OutputPath -Encoding UTF8
}

$totalIn = 0.0
$totalOut = 0.0
$unknownAmount = 0
foreach ($event in $events) {
  if ($null -eq $event.amountUsd) { $unknownAmount += 1; continue }
  if ($event.amountUsd -gt 0) { $totalIn += [decimal]$event.amountUsd }
  elseif ($event.amountUsd -lt 0) { $totalOut += [math]::Abs([decimal]$event.amountUsd) }
}

$summary = [ordered]@{
  generatedAt = (Get-Date).ToString('o')
  importId = $ImportId
  sourceType = $SourceType
  sourceCsv = $CsvPath
  outputPath = $OutputPath
  appendToLedger = [bool]$AppendToLedger
  rowCount = $events.Count
  inflowUsd = [decimal]::Round($totalIn, 2)
  outflowUsd = [decimal]::Round($totalOut, 2)
  netUsd = [decimal]::Round(($totalIn - $totalOut), 2)
  unknownAmountRows = $unknownAmount
  rawSecretsStored = $false
  moneyMoved = $false
  status = 'import_created_pending_operator_review'
  safety = @(
    'No Apple credentials read or requested.',
    'No bank/card/private-key secrets stored.',
    'No funds moved.',
    'Amounts are imported facts from CSV, not proof of cleared Lantern revenue.',
    'Use official Apple/bank apps for actual transfers.'
  )
}

if ($PSCmdlet.ShouldProcess($SummaryPath, 'write import summary JSON')) {
  $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $SummaryPath -Encoding UTF8
}

if ($AppendToLedger) {
  $ledgerDir = Split-Path -Parent $LedgerPath
  New-Item -ItemType Directory -Force -Path $ledgerDir | Out-Null
  if ($PSCmdlet.ShouldProcess($LedgerPath, 'append imported events to Lantern local ledger')) {
    $events | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 } | Add-Content -LiteralPath $LedgerPath -Encoding UTF8
  }
}

Write-Host "Lantern Apple wallet import complete."
Write-Host "Import ID: $ImportId"
Write-Host "Rows: $($events.Count)"
Write-Host "Inflow USD: $([decimal]::Round($totalIn, 2))"
Write-Host "Outflow USD: $([decimal]::Round($totalOut, 2))"
Write-Host "Net USD: $([decimal]::Round(($totalIn - $totalOut), 2))"
Write-Host "Output: $OutputPath"
Write-Host "Summary: $SummaryPath"
if ($AppendToLedger) {
  Write-Host "Ledger appended: $LedgerPath"
} else {
  Write-Host "Ledger append: skipped. Re-run with -AppendToLedger after review."
}
