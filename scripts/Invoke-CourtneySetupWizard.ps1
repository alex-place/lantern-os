# Courtney Lantern OS Setup Wizard
# Interactive setup wizard for Courtney's Windows desktop

param(
    [switch]$SkipChecks
)

$ErrorActionPreference = "Stop"

function Write-Header {
    param([string]$Text)
    Write-Host "`n=== $Text ===" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Text)
    Write-Host "✓ $Text" -ForegroundColor Green
}

function Write-Error {
    param([string]$Text)
    Write-Host "✗ $Text" -ForegroundColor Red
}

function Write-Info {
    param([string]$Text)
    Write-Host "  $Text" -ForegroundColor Gray
}

function Test-Command {
    param([string]$Command)
    $null = Get-Command $Command -ErrorAction SilentlyContinue
    return $?
}

function Get-UserInput {
    param(
        [string]$Prompt,
        [string]$Default
    )
    if ($Default) {
        $promptText = "${Prompt} [$Default]: "
    } else {
        $promptText = "${Prompt}: "
    }
    $userInput = Read-Host $promptText
    if ([string]::IsNullOrWhiteSpace($userInput)) {
        return $Default
    }
    return $userInput
}

function Get-YesNo {
    param([string]$Prompt, [bool]$Default = $true)
    $defaultText = if ($Default) { "Y/n" } else { "y/N" }
    $userInput = Read-Host "$Prompt [$defaultText]"
    if ([string]::IsNullOrWhiteSpace($userInput)) {
        return $Default
    }
    return $userInput -eq "Y" -or $userInput -eq "y"
}

# Clear screen
Clear-Host

Write-Header "Lantern OS Setup Wizard for Courtney"
Write-Info "This wizard will guide you through setting up Lantern OS on your Windows desktop."
Write-Info "Press Ctrl+C at any time to cancel."
Write-Host ""

# Step 1: Prerequisites Check
Write-Header "Step 1: Checking Prerequisites"

$prereqsOk = $true

# Check Node.js
if (Test-Command "node") {
    $nodeVersion = node --version
    Write-Success "Node.js installed: $nodeVersion"
} else {
    Write-Error "Node.js not found"
    Write-Info "Please install Node.js from https://nodejs.org (LTS version recommended)"
    Write-Info "After installation, restart PowerShell and run this wizard again."
    $prereqsOk = $false
}

# Check Git
if (Test-Command "git") {
    $gitVersion = git --version
    Write-Success "Git installed: $gitVersion"
} else {
    Write-Error "Git not found"
    Write-Info "Please install Git from https://git-scm.com/download/win"
    Write-Info "After installation, restart PowerShell and run this wizard again."
    $prereqsOk = $false
}

# Check PowerShell execution policy
$policy = Get-ExecutionPolicy -Scope CurrentUser
if ($policy -eq "Restricted" -or $policy -eq "Undefined") {
    Write-Error "PowerShell execution policy is restricted"
    Write-Info "The wizard will fix this for you."
    $fixPolicy = Get-YesNo "Fix execution policy now?" $true
    if ($fixPolicy) {
        Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
        Write-Success "Execution policy set to RemoteSigned"
    } else {
        $prereqsOk = $false
    }
} else {
    Write-Success "PowerShell execution policy: $policy"
}

if (-not $prereqsOk -and -not $SkipChecks) {
    Write-Host ""
    Write-Error "Prerequisites not met. Please install missing software and run this wizard again."
    exit 1
}

Write-Host ""

# Step 2: Installation Directory
Write-Header "Step 2: Choose Installation Directory"

$defaultDir = "C:\LanternOS"
$installDir = Get-UserInput "Installation directory" $defaultDir

if (-not (Test-Path $installDir)) {
    Write-Info "Creating directory: $installDir"
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    Write-Success "Directory created"
} else {
    Write-Success "Directory exists: $installDir"
}

Write-Host ""

# Step 3: Repository Setup
Write-Header "Step 3: Repository Setup"

$repoPath = Join-Path $installDir "lantern-os"

if (Test-Path $repoPath) {
    Write-Info "Repository already exists at: $repoPath"
    $useExisting = Get-YesNo "Use existing repository?" $true
    if (-not $useExisting) {
        Write-Info "Removing existing directory..."
        Remove-Item -Path $repoPath -Recurse -Force
    }
}

if (-not (Test-Path $repoPath)) {
    Write-Info "Cloning repository from GitHub..."
    Push-Location $installDir
    try {
        git clone https://github.com/alex-place/lantern-os.git
        Write-Success "Repository cloned successfully"
    } catch {
        Write-Error "Failed to clone repository"
        Write-Info "Error: $_"
        exit 1
    } finally {
        Pop-Location
    }
} else {
    Write-Info "Pulling latest changes..."
    Push-Location $repoPath
    try {
        git pull origin master
        Write-Success "Repository updated successfully"
    } catch {
        Write-Error "Failed to pull latest changes"
        Write-Info "Error: $_"
    } finally {
        Pop-Location
    }
}

Write-Host ""

# Step 4: Git Configuration
Write-Header "Step 4: Git Configuration"

$currentName = git config --global user.name
$currentEmail = git config --global user.email

Write-Info "Current git user.name: $currentName"
Write-Info "Current git user.email: $currentEmail"

$configGit = Get-YesNo "Configure git user info?" ($null -eq $currentName)

if ($configGit) {
    $userName = Get-UserInput "Your name" "Courtney Blasioli"
    $userEmail = Get-UserInput "Your email" "courtney@example.com"
    
    git config --global user.name $userName
    git config --global user.email $userEmail
    
    Write-Success "Git configured:"
    Write-Info "  user.name: $userName"
    Write-Info "  user.email: $userEmail"
}

Write-Host ""

# Step 5: Verify Setup
Write-Header "Step 5: Verifying Setup"

Push-Location $repoPath

# Check if start script exists
$startScript = Join-Path $repoPath "scripts\Start-LanternDesktopTester.ps1"
if (Test-Path $startScript) {
    Write-Success "Start script found"
} else {
    Write-Error "Start script not found"
}

# Check git status
git status | Out-Null
Write-Success "Git repository is valid"

Pop-Location

Write-Host ""

# Step 6: Create Desktop Shortcut
Write-Header "Step 6: Create Desktop Shortcut"

$createShortcut = Get-YesNo "Create desktop shortcut?" $true

if ($createShortcut) {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $shortcutPath = Join-Path $desktop "Lantern OS.lnk"
    
    $wsh = New-Object -ComObject WScript.Shell
    $shortcut = $wsh.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = "powershell.exe"
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`""
    $shortcut.WorkingDirectory = $repoPath
    $shortcut.Description = "Lantern OS - Local AI Control Plane"
    $shortcut.Save()
    
    Write-Success "Desktop shortcut created"
} else {
    Write-Info "Skipped desktop shortcut"
}

Write-Host ""

# Step 7: Summary
Write-Header "Setup Complete!"

Write-Success "Lantern OS is ready to use"
Write-Host ""
Write-Info "Installation directory: $repoPath"
Write-Info "Start script: $startScript"
Write-Info "Desktop shortcut: $shortcutPath"
Write-Host ""
Write-Host "To start Lantern OS:" -ForegroundColor Cyan
Write-Info "  1. Double-click the desktop shortcut, OR"
Write-Info "  2. Run: $startScript"
Write-Host ""
Write-Info "The browser will open to: http://127.0.0.1:4177"
Write-Host ""
Write-Info "For help, see:"
Write-Info "  - docs/COURTNEY-QUICK-SYNC-2026-05-30.md"
Write-Info "  - docs/COURTNEY-DESKTOP-BRIDGE-SETUP-2026-05-30.md"
Write-Host ""

$startNow = Get-YesNo "Start Lantern OS now?" $false
if ($startNow) {
    Write-Info "Starting Lantern OS..."
    & $startScript
}
