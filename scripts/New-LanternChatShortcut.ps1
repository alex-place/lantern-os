[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Url = "",
    [string]$DesktopPath = "$env:USERPROFILE\OneDrive\Desktop",
    [string]$StartMenuPath = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Lantern",
    [string]$Name = "Lantern Chat",
    [switch]$StartMenu,
    [switch]$AllowVerifiedRemote
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tester = Join-Path $PSScriptRoot "Test-LanternChatEndpoint.ps1"

$testArgs = @{}
if (-not [string]::IsNullOrWhiteSpace($Url)) { $testArgs.Url = $Url }
if ($AllowVerifiedRemote) { $testArgs.AllowVerifiedRemote = $true }

$validation = & $tester @testArgs
if (-not $validation.ok) {
    $checked = ($validation.results | ForEach-Object { "$($_.url) [$($_.reason)]" }) -join "; "
    throw "No validated Lantern chat URL found. Checked: $checked"
}

$targetUrl = $validation.selectedUrl
$shortcutDirectory = if ($StartMenu) { $StartMenuPath } else { $DesktopPath }
$shortcutPath = Join-Path $shortcutDirectory "$Name.url"

$content = @"
[InternetShortcut]
URL=$targetUrl
Comment=Lantern OS fixed chat entrypoint; validated before shortcut creation.
"@

if ($PSCmdlet.ShouldProcess($shortcutPath, "Create or refresh Lantern chat shortcut")) {
    New-Item -ItemType Directory -Path $shortcutDirectory -Force | Out-Null
    Set-Content -LiteralPath $shortcutPath -Value $content -Encoding ASCII
}

[pscustomobject]@{
    ok = $true
    shortcutPath = $shortcutPath
    targetUrl = $targetUrl
    startMenu = [bool]$StartMenu
    validation = $validation
    repoRoot = $root
}
