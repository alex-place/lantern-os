param(
    [Parameter(Mandatory = $true)]
    [string]$Event,
    [string]$Status = "recorded",
    [decimal]$AmountUsd = 0,
    [string]$InvoiceId = "",
    [string]$Offer = "",
    [string]$Evidence = "",
    [string]$Ledger = "data/wallet/ledger.jsonl"
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ledgerPath = Join-Path $root $Ledger
$ledgerDir = Split-Path -Parent $ledgerPath
New-Item -ItemType Directory -Force -Path $ledgerDir | Out-Null

$balance = 0
if (Test-Path $ledgerPath) {
    $lastBalance = Get-Content -LiteralPath $ledgerPath |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object {
            try { ($_ | ConvertFrom-Json).balanceUsd } catch { $null }
        } |
        Where-Object { $null -ne $_ } |
        Select-Object -Last 1
    if ($null -ne $lastBalance) { $balance = [decimal]$lastBalance }
}

if ($Event -eq "payment_cleared") {
    $balance += $AmountUsd
}

$record = [ordered]@{
    timestamp = (Get-Date).ToString("o")
    event = $Event
    status = $Status
    amountUsd = $AmountUsd
    balanceUsd = $balance
    invoiceId = $InvoiceId
    offer = $Offer
    evidence = $Evidence
}

($record | ConvertTo-Json -Compress) | Add-Content -LiteralPath $ledgerPath -Encoding UTF8
Write-Output $ledgerPath
