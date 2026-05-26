param(
    [switch]$OpenDiskManagement,
    [string]$ValidationOutput = "manifests/validation/DUAL-BOOT-READINESS-LATEST.json"
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$validationPath = Join-Path $root $ValidationOutput
$validationDir = Split-Path -Parent $validationPath
New-Item -ItemType Directory -Force -Path $validationDir | Out-Null

Write-Output "Lantern OS dual boot prep launcher"
Write-Output "This script is non-destructive. It does not resize, format, mutate BCD, change firmware, or install an OS."
Write-Output ""

$resultJson = powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "dual-boot\Test-DualBootReadiness.ps1") -Json
$resultJson | Set-Content -LiteralPath $validationPath -Encoding UTF8
$result = $resultJson | ConvertFrom-Json

Write-Output ("readyForPrep:    {0}" -f $result.readyForPrep)
Write-Output ("readyForInstall: {0}" -f $result.readyForInstall)
Write-Output ("failures:        {0}" -f $result.fail)
Write-Output ("warnings:        {0}" -f $result.warn)
Write-Output ("held:            {0}" -f $result.held)
Write-Output ("saved:           {0}" -f $validationPath)
Write-Output ""

if (-not $result.readyForInstall) {
    Write-Output "Next physical action:"
    Write-Output "1. Run this from an elevated PowerShell for final BitLocker/Secure Boot checks."
    Write-Output "2. Back up recovery keys and important files."
    Write-Output "3. Open Disk Management."
    Write-Output "4. Shrink D: by 100-250 GB."
    Write-Output "5. Leave the new space unallocated."
    Write-Output "6. Rerun this script and confirm readyForInstall becomes True."
}

if ($OpenDiskManagement) {
    Write-Output ""
    Write-Output "Opening Disk Management for operator-controlled physical action."
    Start-Process -FilePath "diskmgmt.msc"
}
