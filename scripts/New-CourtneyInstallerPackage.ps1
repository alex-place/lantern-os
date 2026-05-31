# Create Courtney Installer Package
# Packages the setup wizard and instructions into a distributable zip file

param(
    [string]$OutputDir = (Join-Path $PSScriptRoot "..\artifacts")
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$packageName = "lantern-os-courtney-installer-2026-05-30"
$packageDir = Join-Path $OutputDir $packageName
$zipPath = Join-Path $OutputDir "$packageName.zip"

Write-Host "Creating Courtney installer package..." -ForegroundColor Cyan

# Clean up existing package
if (Test-Path $packageDir) {
    Remove-Item -Path $packageDir -Recurse -Force
}
if (Test-Path $zipPath) {
    Remove-Item -Path $zipPath -Force
}

# Create package directory
New-Item -ItemType Directory -Path $packageDir -Force | Out-Null

# Copy setup wizard
Copy-Item (Join-Path $root "scripts\Invoke-CourtneySetupWizard.ps1") -Destination $packageDir

# Copy documentation
Copy-Item (Join-Path $root "docs\COURTNEY-QUICK-SYNC-2026-05-30.md") -Destination $packageDir
Copy-Item (Join-Path $root "docs\COURTNEY-DESKTOP-BRIDGE-SETUP-2026-05-30.md") -Destination $packageDir

# Create README
$readmeContent = @"
# Lantern OS Installer for Courtney

**Date:** 2026-05-30  
**Version:** 1.0.0

## Quick Start

1. **Double-click:** `Invoke-CourtneySetupWizard.ps1`
2. **Follow the prompts** in the wizard
3. **Start Lantern OS** using the desktop shortcut

## What This Installer Does

- Checks prerequisites (Node.js, Git, PowerShell)
- Clones the Lantern OS repository
- Configures Git for your user
- Creates a desktop shortcut
- Sets up local-cloud bridge

## Prerequisites

Before running the installer, ensure you have:
- **Node.js 20+** - Download from https://nodejs.org (LTS version)
- **Git** - Download from https://git-scm.com/download/win
- **PowerShell** - Included with Windows (no installation needed)

## Manual Setup

If the wizard fails, see:
- `COURTNEY-DESKTOP-BRIDGE-SETUP-2026-05-30.md` - Full bridge setup guide
- `COURTNEY-QUICK-SYNC-2026-05-30.md` - Quick sync commands

## Support

If you encounter issues:
1. Check the troubleshooting section in the bridge setup guide
2. Contact the Lantern OS operator for help

## After Installation

- Local app runs at: http://127.0.0.1:4177
- Cloud chat available via Codex Cloud
- Discord bot in collaboration channel

---

**Prepared for:** Courtney Blasioli  
**Date:** 2026-05-30
"@

$readmeContent | Set-Content (Join-Path $packageDir "README.md") -Encoding UTF8

# Create zip
Write-Host "Creating zip file..." -ForegroundColor Cyan
Compress-Archive -Path "$packageDir\*" -DestinationPath $zipPath -Force

# Clean up package directory
Remove-Item -Path $packageDir -Recurse -Force

Write-Host "Installer package created: $zipPath" -ForegroundColor Green
Write-Host "Size: $((Get-Item $zipPath).Length / 1KB) KB" -ForegroundColor Gray
