<#
.SYNOPSIS
  Push the Resend mail config from THIS machine's environment to the prod VM.

.DESCRIPTION
  Installs /etc/systemd/system/lantern.service.d/mail.conf with RESEND_API_KEY,
  MAIL_FROM and PUBLIC_BASE_URL, restarts the app, and verifies the mailer
  actually came up rather than assuming the restart worked.

  Why this matters more than a normal config: with no mail provider configured,
  lib/local-auth.js takes the no-mailer path from #2065 and AUTO-ADMITS a public
  signup with emailVerified/emailAssumed set -- anyone can register an address
  they do not control. Loopback requests are exempt, so this does NOT reproduce
  when you test over 127.0.0.1; it only bites real, proxied traffic. Installing a
  key is what closes it.

  PUBLIC_BASE_URL is not optional here. Without it lib/base-url.js builds
  confirmation links from the request Host header, which is spoofable (#2604) --
  inert while no mail goes out, live the moment Resend is on.

  Transport: `gcloud compute scp`, NOT a pipe into `gcloud compute ssh --command`.
  On Windows gcloud is a PowerShell wrapper that does not forward stdin to ssh --
  it answers a prompt with "y" and that single character lands in the file, which
  looks like success and silently writes a broken drop-in (see #3117). The key
  therefore touches a local temp file briefly: ACL'd to the current user,
  zero-overwritten before unlink, deletion verified. Still a smaller exposure
  than argv, which every local user on the VM can read via ps/proc.

  Secrets live in /etc/systemd/system/lantern.service.d/ by convention -- outside
  the git checkout, so the release deploy's `git checkout -f <tag>` cannot touch
  them. Set once; survives every future release.

  NOTE: ASCII-only on purpose. Windows PowerShell 5.1 reads a BOM-less .ps1 as
  ANSI, which corrupts non-ASCII characters mid-string and breaks parsing.

.EXAMPLE
  .\ops\gce\Push-ResendKey.ps1
  Pull RESEND_API_KEY from the User environment and install it on prod.

.EXAMPLE
  .\ops\gce\Push-ResendKey.ps1 -WhatIf
  Show what would happen without changing anything on the VM.

.EXAMPLE
  .\ops\gce\Push-ResendKey.ps1 -Remove
  Tear the mail config back out (returns the box to the auto-admit state).

.NOTES
  Companion to Push-StripeKey.ps1. See docs/ops/gce-cloud-deploy-runbook.md.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('User', 'Machine', 'Process')]
    [string]$Scope = 'User',

    # Must be on a domain verified in the Resend dashboard, or sends fail silently.
    [string]$MailFrom = 'unisona.ai <no-reply@unisona.ai>',
    [string]$PublicBaseUrl = 'https://unisona.ai',

    [string]$Vm      = 'lantern-app',
    [string]$Zone    = 'us-central1-a',
    [string]$Project = 'project-2f747c41-d0f3-4de9-b48',

    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$DropIn = '/etc/systemd/system/lantern.service.d/mail.conf'

function Invoke-Remote {
    param([string]$Command)
    return (& gcloud compute ssh $Vm "--zone=$Zone" "--project=$Project" '--command' $Command 2>&1)
}

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    throw "gcloud not found on PATH. Install the Google Cloud SDK, or run ops/gce/set-resend-key.sh directly on the VM."
}

# --- Remove mode ------------------------------------------------------------
if ($Remove) {
    if ($PSCmdlet.ShouldProcess("$Vm ($Zone)", "remove $DropIn and restart lantern.service")) {
        Invoke-Remote -Command "sudo rm -f $DropIn && sudo systemctl daemon-reload && sudo systemctl restart lantern.service && echo REMOVED"
        Write-Warning "Mail config removed. Public signups will AUTO-ADMIT again without proving email ownership (#2065)."
    }
    return
}

# --- Read the key from this machine's environment ---------------------------
$key = if ($Scope -eq 'Process') { $env:RESEND_API_KEY }
       else { [Environment]::GetEnvironmentVariable('RESEND_API_KEY', $Scope) }

if ([string]::IsNullOrWhiteSpace($key)) {
    throw "RESEND_API_KEY is not set in the $Scope environment. Set it with: setx RESEND_API_KEY `"re_...`" (then open a new shell), or pass -Scope Machine/Process."
}
$key = $key.Trim()

if ($key -notlike 're_*') { throw "That value does not look like a Resend API key (expected an re_ prefix). Nothing sent." }
if ($key.Length -lt 20)   { throw "Key is implausibly short ($($key.Length) chars). Nothing sent." }
if ($PublicBaseUrl -notmatch '^https://') { throw "PublicBaseUrl must be https:// -- confirmation links are built from it (#2604)." }

Write-Host "Source   : $Scope environment on $env:COMPUTERNAME"
Write-Host "Key      : Resend, $($key.Length) chars (value not shown)"
Write-Host "MailFrom : $MailFrom"
Write-Host "BaseUrl  : $PublicBaseUrl"
Write-Host "Target   : $Vm ($Zone) -> $DropIn"

if (-not $PSCmdlet.ShouldProcess("$Vm ($Zone)", "install mail.conf and restart lantern.service")) { return }

# --- Install via scp (see the transport note in the header) -----------------
$body = "[Service]`nEnvironment=`"RESEND_API_KEY=$key`"`nEnvironment=`"MAIL_FROM=$MailFrom`"`nEnvironment=`"PUBLIC_BASE_URL=$PublicBaseUrl`"`n"
$tmp = Join-Path $env:TEMP ("mail-" + [guid]::NewGuid().ToString('N') + ".conf")
$remoteTmp = "/tmp/mail-$([guid]::NewGuid().ToString('N')).conf"
$result = $null

try {
    Set-Content -Path $tmp -Value $body -NoNewline -Encoding ascii
    # (F) not (R,W): read/write alone blocks our own delete in the finally block.
    & icacls $tmp /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null

    $null = & gcloud compute scp $tmp "${Vm}:$remoteTmp" "--zone=$Zone" "--project=$Project" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "scp of the drop-in failed (exit $LASTEXITCODE)." }

    $install = "sudo install -d -m 755 /etc/systemd/system/lantern.service.d && " +
               "sudo install -o root -g root -m 600 $remoteTmp $DropIn; rc=`$?; " +
               "shred -u $remoteTmp 2>/dev/null || rm -f $remoteTmp; " +
               "test `$rc -eq 0 && sudo systemctl daemon-reload && " +
               "sudo systemctl restart lantern.service && echo INSTALLED"
    $result = Invoke-Remote -Command $install
}
finally {
    if (Test-Path $tmp) {
        try { [IO.File]::WriteAllBytes($tmp, (New-Object byte[] 4096)) } catch { }
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        if (Test-Path $tmp) { Write-Warning "Could not delete the temp file $tmp -- remove it by hand." }
    }
    Remove-Variable key, body -ErrorAction SilentlyContinue
}

if ($result -notmatch 'INSTALLED') {
    Write-Error "Install did not confirm. Remote output:`n$result"
    return
}
Write-Host "Installed and lantern.service restarted." -ForegroundColor Green

# --- Verify the mailer actually came up -------------------------------------
# "no mail provider is configured" in the journal means the drop-in did not take.
Start-Sleep -Seconds 6
$check = "sudo journalctl -u lantern.service -n 60 --no-pager | grep -i -e 'no mail provider' -e 'mailer' | tail -5; echo '---DROPIN---'; sudo test -f $DropIn && echo present || echo missing"
$log = Invoke-Remote -Command $check

if ($log -match 'no mail provider') {
    Write-Warning "The app still reports NO MAIL PROVIDER -- the drop-in did not take."
    Write-Warning ($log | Out-String)
    return
}
if ($log -notmatch 'present') {
    Write-Warning "Drop-in not found on the VM after install."
    return
}

Write-Host "Mailer is configured (no 'no mail provider' warning in the journal)." -ForegroundColor Green
Write-Host ""
Write-Host "Confirm the sender domain is verified in Resend, or sends fail silently:"
Write-Host "  curl -H 'Authorization: Bearer <key>' https://api.resend.com/domains"
Write-Host "Then register a throwaway address on https://unisona.ai and confirm a code arrives."
