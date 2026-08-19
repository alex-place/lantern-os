<#
.SYNOPSIS
  Paste the prod secrets once, install them all on the VM, verify each.

.DESCRIPTION
  One prompt per secret, input hidden. Values go straight from the prompt to the
  GCE box and are never echoed, never written to your environment, never logged,
  and never left on disk. Press Enter on a prompt to skip that service.

  This exists so you don't have to `setx` three values and open a new shell. It
  installs the same systemd drop-ins as Push-StripeKey.ps1 / Push-ResendKey.ps1
  and runs the same verification, in one pass.

  WHAT IT SETS
    stripe.conf   STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET
    mail.conf     RESEND_API_KEY + MAIL_FROM + PUBLIC_BASE_URL

  Both Stripe values are required together. With only the secret key, checkout
  succeeds and /api/billing/webhook returns 503 -- the customer is charged and
  never receives the tier they paid for. The script refuses that half-config.

  Transport is `gcloud compute scp`, never a pipe into `gcloud compute ssh`: on
  Windows gcloud is a PowerShell wrapper that does not forward stdin to ssh, and
  silently writes "y" into the file instead (#3117). Secrets therefore touch a
  local temp file for a moment -- ACL'd to you, zero-overwritten, deletion
  verified -- which is a smaller exposure than argv, readable by every user on
  the VM for the life of a process.

  Drop-ins live in /etc/systemd/system/lantern.service.d/, outside the git
  checkout, so `git checkout -f <tag>` on release cannot touch them. Set once.

  ASCII-only on purpose: PowerShell 5.1 reads a BOM-less .ps1 as ANSI and
  corrupts non-ASCII characters mid-string.

.EXAMPLE
  .\ops\gce\Set-ProdSecrets.ps1
#>
[CmdletBinding()]
param(
    [string]$Vm      = 'lantern-app',
    [string]$Zone    = 'us-central1-a',
    [string]$Project = 'project-2f747c41-d0f3-4de9-b48',
    [string]$MailFrom = 'unisona.ai <no-reply@unisona.ai>',
    [string]$PublicBaseUrl = 'https://unisona.ai'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    throw "gcloud not found on PATH."
}

# Read a secret without echoing it. Returns plain text in memory only.
function Read-Secret([string]$Label) {
    $sec = Read-Host -Prompt $Label -AsSecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b).Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

# Write $Body to $RemotePath on the VM via scp, then install it as a root-owned
# 0600 drop-in. Returns $true on confirmed install.
function Install-DropIn([string]$Body, [string]$DropIn, [string]$Label) {
    $tmp = Join-Path $env:TEMP ("sec-" + [guid]::NewGuid().ToString('N') + ".conf")
    $remote = "/tmp/sec-$([guid]::NewGuid().ToString('N')).conf"
    try {
        Set-Content -Path $tmp -Value $Body -NoNewline -Encoding ascii
        # (F) not (R,W): read/write alone blocks our own delete below.
        & icacls $tmp /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null

        $null = & gcloud compute scp $tmp "${Vm}:$remote" "--zone=$Zone" "--project=$Project" 2>&1
        if ($LASTEXITCODE -ne 0) { Write-Warning "$Label - scp failed (exit $LASTEXITCODE)."; return $false }

        $cmd = "sudo install -d -m 755 /etc/systemd/system/lantern.service.d && " +
               "sudo install -o root -g root -m 600 $remote $DropIn; rc=`$?; " +
               "shred -u $remote 2>/dev/null || rm -f $remote; " +
               "test `$rc -eq 0 && echo INSTALLED_$Label"
        $out = & gcloud compute ssh $Vm "--zone=$Zone" "--project=$Project" '--command' $cmd 2>&1
        if ($out -notmatch "INSTALLED_$Label") { Write-Warning "$Label - install did not confirm:`n$out"; return $false }
        return $true
    }
    finally {
        if (Test-Path $tmp) {
            try { [IO.File]::WriteAllBytes($tmp, (New-Object byte[] 4096)) } catch { }
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
            if (Test-Path $tmp) { Write-Warning "Could not delete temp file $tmp - remove it by hand." }
        }
    }
}

Write-Host ""
Write-Host "Paste each secret at its prompt. Input is hidden and never echoed."
Write-Host "Press Enter on a prompt to skip that service."
Write-Host ""

# ── Stripe ───────────────────────────────────────────────────────────────────
$sk    = Read-Secret "Stripe secret key   (sk_live_... / sk_test_..., Enter to skip)"
$whsec = ''
if ($sk) {
    switch -Wildcard ($sk) {
        'sk_live_*' { Write-Host "  -> LIVE key, real money." }
        'rk_live_*' { Write-Host "  -> LIVE restricted key." }
        'sk_test_*' { Write-Host "  -> test mode, no real charges." }
        'rk_test_*' { Write-Host "  -> test mode, restricted." }
        default     { throw "That is not a Stripe secret key (expected sk_/rk_ prefix). Nothing sent." }
    }
    if ($sk.Length -lt 20) { throw "Stripe key implausibly short. Nothing sent." }

    $whsec = Read-Secret "Stripe WEBHOOK signing secret (whsec_...)"
    if (-not $whsec) {
        throw ("The webhook secret is required.`n" +
               "Without it /api/billing/webhook returns 503: the customer completes checkout, " +
               "is charged, and never receives the tier. Get it from Stripe -> Developers -> " +
               "Webhooks -> your endpoint -> Signing secret, then re-run.")
    }
    if ($whsec -notlike 'whsec_*') { throw "That is not a webhook signing secret (expected whsec_ prefix). Nothing sent." }
}

# ── Resend ───────────────────────────────────────────────────────────────────
$re = Read-Secret "Resend API key      (re_..., Enter to skip)"
if ($re -and ($re -notlike 're_*')) { throw "That is not a Resend API key (expected re_ prefix). Nothing sent." }

if (-not $sk -and -not $re) { Write-Host "Nothing to do."; return }

# ── Install ──────────────────────────────────────────────────────────────────
Write-Host ""
$did = @()

if ($sk) {
    $body = "[Service]`nEnvironment=`"STRIPE_SECRET_KEY=$sk`"`nEnvironment=`"STRIPE_WEBHOOK_SECRET=$whsec`"`n"
    if (Install-DropIn $body '/etc/systemd/system/lantern.service.d/stripe.conf' 'STRIPE') {
        Write-Host "stripe.conf installed (0600 root)." -ForegroundColor Green
        $did += 'stripe'
    }
}
if ($re) {
    $body = "[Service]`nEnvironment=`"RESEND_API_KEY=$re`"`nEnvironment=`"MAIL_FROM=$MailFrom`"`nEnvironment=`"PUBLIC_BASE_URL=$PublicBaseUrl`"`n"
    if (Install-DropIn $body '/etc/systemd/system/lantern.service.d/mail.conf' 'MAIL') {
        Write-Host "mail.conf installed (0600 root)." -ForegroundColor Green
        $did += 'mail'
    }
}

Remove-Variable sk, whsec, re, body -ErrorAction SilentlyContinue
if (-not $did) { Write-Warning "Nothing installed."; return }

# One restart covers both drop-ins.
Write-Host "Restarting lantern.service ..."
$null = & gcloud compute ssh $Vm "--zone=$Zone" "--project=$Project" '--command' `
    "sudo systemctl daemon-reload && sudo systemctl restart lantern.service && echo RESTARTED" 2>&1

# ── Verify (don't trust the restart) ─────────────────────────────────────────
if ($did -contains 'stripe') {
    Write-Host -NoNewline "Verifying billing "
    $cfg = $null
    foreach ($i in 1..20) {
        Start-Sleep -Seconds 3
        try { $cfg = Invoke-RestMethod -Uri 'https://unisona.ai/api/billing/config' -TimeoutSec 8; if ($cfg.configured) { break } } catch { }
        Write-Host -NoNewline '.'
    }
    Write-Host ''
    if ($cfg -and $cfg.configured) {
        Write-Host "Billing CONFIGURED. pro=$($cfg.tiers.pro) pilot=$($cfg.tiers.pilot)" -ForegroundColor Green
    } else {
        Write-Warning "Billing still reports NOT configured. Check: journalctl -u lantern.service -n 50"
    }
}

if ($did -contains 'mail') {
    Start-Sleep -Seconds 4
    $log = & gcloud compute ssh $Vm "--zone=$Zone" "--project=$Project" '--command' `
        "sudo journalctl -u lantern.service -n 80 --no-pager | grep -i 'no mail provider' | tail -2" 2>&1
    if ("$log" -match 'no mail provider') {
        Write-Warning "Mailer still reports NO MAIL PROVIDER - the drop-in did not take."
    } else {
        Write-Host "Mailer configured (no 'no mail provider' warning)." -ForegroundColor Green
        Write-Host "Sender domain must be verified in Resend or sends fail silently."
    }
}

Write-Host ""
Write-Host "Done. Nothing was written to your environment and no secret was echoed."
