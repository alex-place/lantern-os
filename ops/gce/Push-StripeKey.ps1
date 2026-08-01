<#
.SYNOPSIS
  Push the Stripe API key from THIS machine's environment to the prod VM.

.DESCRIPTION
  Reads STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET from the local environment
  (User scope by default -- where `setx` puts them), validates their shape,
  installs them on the GCE box as a systemd drop-in, restarts the app, and
  verifies billing came up configured.

  BOTH matter. The secret key alone turns the Subscribe buttons on, but
  /api/billing/webhook returns 503 without STRIPE_WEBHOOK_SECRET, and that
  webhook is the SOURCE OF TRUTH for entitlements -- a customer would complete
  checkout, be charged, and never receive the role they paid for. The script
  warns loudly rather than silently installing half a config.

  The key is transferred with `gcloud compute scp`. It is never placed in a
  command line on either side: argv is world-readable through `ps` and /proc, so
  a key passed that way leaks to every local user on the VM for the life of the
  process. It is also never echoed.

  Transport note: piping the key over `gcloud compute ssh --command`'s STDIN does
  NOT work on Windows. `gcloud` here is a PowerShell wrapper (gcloud.ps1) which
  does not forward stdin to ssh -- it answers a prompt with "y", and that single
  character is what lands in the file. That silently produced a drop-in
  containing `y` and an app that still reported billing unconfigured. scp is the
  reliable path.

  The key therefore touches a local temp file briefly. It is created with an ACL
  restricted to the current user, overwritten with zeros before deletion, and the
  deletion is verified. That is a smaller exposure than argv, which is readable
  by every user on the box for the life of the process.

  Secrets live in /etc/systemd/system/lantern.service.d/ by convention -- outside
  the git checkout, so the release deploy's `git checkout -f <tag>` cannot touch
  them. Set it once and it survives every future release.

  NOTE: this file is deliberately ASCII-only. Windows PowerShell 5.1 reads a .ps1
  without a BOM as ANSI, which corrupts non-ASCII characters mid-string and makes
  the script fail to parse.

.EXAMPLE
  .\ops\gce\Push-StripeKey.ps1
  Pull STRIPE_SECRET_KEY from the User environment and install it on prod.

.EXAMPLE
  .\ops\gce\Push-StripeKey.ps1 -WhatIf
  Show what would happen without changing anything on the VM.

.EXAMPLE
  .\ops\gce\Push-StripeKey.ps1 -Remove
  Tear the key back out of prod.

.NOTES
  Requires gcloud, authenticated. See docs/ops/gce-cloud-deploy-runbook.md.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('User', 'Machine', 'Process')]
    [string]$Scope = 'User',

    [string]$Vm      = 'lantern-app',
    [string]$Zone    = 'us-central1-a',
    [string]$Project = 'project-2f747c41-d0f3-4de9-b48',

    # Verified against the public site, since prod sits behind Cloudflare.
    [string]$VerifyUrl = 'https://unisona.ai/api/billing/config',

    # Set -AllowNoWebhook to install the secret key WITHOUT the webhook secret.
    # Only sensible for a test-mode dry run: in that state a real payment is taken
    # and no entitlement is granted.
    [switch]$AllowNoWebhook,

    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$DropIn = '/etc/systemd/system/lantern.service.d/stripe.conf'

function Invoke-Remote {
    param([string]$Command, [string]$StdIn)
    $sshArgs = @('compute', 'ssh', $Vm, "--zone=$Zone", "--project=$Project", '--command', $Command)
    if ($PSBoundParameters.ContainsKey('StdIn')) { return ($StdIn | & gcloud @sshArgs 2>&1) }
    return (& gcloud @sshArgs 2>&1)
}

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    throw "gcloud not found on PATH. Install the Google Cloud SDK, or run ops/gce/set-stripe-key.sh directly on the VM."
}

# --- Remove mode ------------------------------------------------------------
if ($Remove) {
    if ($PSCmdlet.ShouldProcess("$Vm ($Zone)", "remove $DropIn and restart lantern.service")) {
        Invoke-Remote -Command "sudo rm -f $DropIn && sudo systemctl daemon-reload && sudo systemctl restart lantern.service && echo REMOVED"
        Write-Host "Stripe drop-in removed; lantern.service restarted." -ForegroundColor Yellow
    }
    return
}

# --- Read the key from this machine's environment ---------------------------
$key = if ($Scope -eq 'Process') { $env:STRIPE_SECRET_KEY }
       else { [Environment]::GetEnvironmentVariable('STRIPE_SECRET_KEY', $Scope) }

if ([string]::IsNullOrWhiteSpace($key)) {
    throw "STRIPE_SECRET_KEY is not set in the $Scope environment. Set it with: setx STRIPE_SECRET_KEY `"sk_live_...`" (then open a new shell), or pass -Scope Machine/Process."
}
$key = $key.Trim()

# --- Validate shape locally, before touching prod. Never print the key. -----
switch -Wildcard ($key) {
    'sk_live_*' { $mode = 'LIVE - real money';           $note = 'FULL-ACCESS key. A restricted key (rk_) scoped to Checkout + Billing would be safer.' }
    'rk_live_*' { $mode = 'LIVE - real money';           $note = 'Restricted key - good, least privilege.' }
    'sk_test_*' { $mode = 'test mode - no real charges'; $note = 'Full-access test key.' }
    'rk_test_*' { $mode = 'test mode - no real charges'; $note = 'Restricted test key.' }
    default     { throw "That value does not look like a Stripe secret key (expected an sk_/rk_ prefix). Nothing sent." }
}
if ($key.Length -lt 20) { throw "Key is implausibly short ($($key.Length) chars). Nothing sent." }

# --- Webhook signing secret (entitlements depend on it) ---------------------
$whsec = if ($Scope -eq 'Process') { $env:STRIPE_WEBHOOK_SECRET }
         else { [Environment]::GetEnvironmentVariable('STRIPE_WEBHOOK_SECRET', $Scope) }
if ($whsec) { $whsec = $whsec.Trim() }

if ([string]::IsNullOrWhiteSpace($whsec)) {
    if (-not $AllowNoWebhook) {
        throw ("STRIPE_WEBHOOK_SECRET is not set in the $Scope environment.`n" +
               "Without it /api/billing/webhook returns 503, so a customer can complete checkout, " +
               "be charged, and never receive the role they paid for.`n" +
               "Get it from Stripe -> Developers -> Webhooks -> your endpoint -> Signing secret, then:`n" +
               "  setx STRIPE_WEBHOOK_SECRET `"whsec_...`"   (then open a new shell)`n" +
               "Or pass -AllowNoWebhook to install the secret key alone anyway (test mode only).")
    }
    Write-Warning "No STRIPE_WEBHOOK_SECRET. Checkout will work but entitlements will NOT be applied."
} elseif ($whsec -notlike 'whsec_*') {
    throw "STRIPE_WEBHOOK_SECRET does not look like a signing secret (expected a whsec_ prefix). Nothing sent."
}

Write-Host "Source : $Scope environment on $env:COMPUTERNAME"
Write-Host "Key    : $mode, $($key.Length) chars (value not shown)"
Write-Host "Note   : $note"
Write-Host "Webhook: $(if ($whsec) { "whsec, $($whsec.Length) chars (value not shown)" } else { 'NOT SET - entitlements will not apply' })"
Write-Host "Target : $Vm ($Zone) -> $DropIn"

if (-not $PSCmdlet.ShouldProcess("$Vm ($Zone)", "install STRIPE_SECRET_KEY and restart lantern.service")) { return }

# --- Install via scp (see the transport note in the header) -----------------
$dropInBody = "[Service]`nEnvironment=`"STRIPE_SECRET_KEY=$key`"`n"
if ($whsec) { $dropInBody += "Environment=`"STRIPE_WEBHOOK_SECRET=$whsec`"`n" }
$tmp = Join-Path $env:TEMP ("stripe-" + [guid]::NewGuid().ToString('N') + ".conf")
$remoteTmp = "/tmp/stripe-$([guid]::NewGuid().ToString('N')).conf"
$result = $null

try {
    Set-Content -Path $tmp -Value $dropInBody -NoNewline -Encoding ascii
    # Full control for this user only: no inheritance (so other local users cannot
    # read it) but F rather than R,W, because R,W alone blocks our own delete.
    & icacls $tmp /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null

    $scp = @('compute', 'scp', $tmp, "${Vm}:$remoteTmp", "--zone=$Zone", "--project=$Project")
    $null = & gcloud @scp 2>&1
    if ($LASTEXITCODE -ne 0) { throw "scp of the drop-in failed (exit $LASTEXITCODE)." }

    # install(1) sets owner/mode atomically; shred the staged copy either way.
    $install = "sudo install -d -m 755 /etc/systemd/system/lantern.service.d && " +
               "sudo install -o root -g root -m 600 $remoteTmp $DropIn; rc=`$?; " +
               "shred -u $remoteTmp 2>/dev/null || rm -f $remoteTmp; " +
               "test `$rc -eq 0 && sudo systemctl daemon-reload && " +
               "sudo systemctl restart lantern.service && echo INSTALLED"
    $result = Invoke-Remote -Command $install
}
finally {
    if (Test-Path $tmp) {
        # Overwrite before unlinking so the bytes are not left in free space.
        try { [IO.File]::WriteAllBytes($tmp, (New-Object byte[] 4096)) } catch { }
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        if (Test-Path $tmp) { Write-Warning "Could not delete the temp file $tmp -- remove it by hand." }
    }
    Remove-Variable key, whsec, dropInBody -ErrorAction SilentlyContinue
}

if ($result -notmatch 'INSTALLED') {
    Write-Error "Install did not confirm. Remote output:`n$result"
    return
}
Write-Host "Installed and lantern.service restarted." -ForegroundColor Green

# --- Verify the app actually reports billing configured ---------------------
Write-Host -NoNewline "Verifying $VerifyUrl "
$cfg = $null
foreach ($i in 1..20) {
    Start-Sleep -Seconds 3
    try {
        $cfg = Invoke-RestMethod -Uri $VerifyUrl -TimeoutSec 8
        if ($cfg.configured) { break }
    } catch { }
    Write-Host -NoNewline '.'
}
Write-Host ''

if ($cfg -and $cfg.configured) {
    Write-Host "Billing is CONFIGURED on prod." -ForegroundColor Green
    Write-Host "Tiers buyable: pro=$($cfg.tiers.pro) pilot=$($cfg.tiers.pilot) member=$($cfg.tiers.member)"
    Write-Host "Check https://unisona.ai/pricing.html - the Patreon fallback should now be replaced by Subscribe to Pro / Subscribe to Pilot."
} else {
    Write-Warning "Prod is reachable but billing still reports NOT configured."
    $j = "journalctl -u lantern.service -n 50"
    Write-Warning "Check the service: gcloud compute ssh $Vm --zone=$Zone --project=$Project --command='$j'"
}
