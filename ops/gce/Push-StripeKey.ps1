<#
.SYNOPSIS
  Push the Stripe API key from THIS machine's environment to the prod VM.

.DESCRIPTION
  Reads STRIPE_SECRET_KEY from the local environment (User scope by default --
  where `setx` puts it), validates its shape, installs it on the GCE box as a
  systemd drop-in, restarts the app, and verifies billing came up configured.

  The key is streamed over the SSH connection's STDIN. It is never placed in a
  command line on either side: argv is world-readable through `ps` and /proc, so
  a key passed that way leaks to every local user on the VM for the life of the
  process. It is also never echoed, and never written to a temp file here.

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

Write-Host "Source : $Scope environment on $env:COMPUTERNAME"
Write-Host "Key    : $mode, $($key.Length) chars (value not shown)"
Write-Host "Note   : $note"
Write-Host "Target : $Vm ($Zone) -> $DropIn"

if (-not $PSCmdlet.ShouldProcess("$Vm ($Zone)", "install STRIPE_SECRET_KEY and restart lantern.service")) { return }

# --- Install. The drop-in body goes over STDIN, so the key never enters argv.
# umask 077 means the file is 0600 from birth, never briefly world-readable.
$dropInBody = "[Service]`nEnvironment=`"STRIPE_SECRET_KEY=$key`"`n"
$install = "sudo install -d -m 755 /etc/systemd/system/lantern.service.d && " +
           "sudo sh -c 'umask 077; cat > $DropIn' && " +
           "sudo chown root:root $DropIn && sudo chmod 600 $DropIn && " +
           "sudo systemctl daemon-reload && sudo systemctl restart lantern.service && echo INSTALLED"

$result = Invoke-Remote -Command $install -StdIn $dropInBody
Remove-Variable key, dropInBody -ErrorAction SilentlyContinue

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
