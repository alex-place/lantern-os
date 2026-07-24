#Requires -Version 5.1
<#
.SYNOPSIS
    Lantern OS / Dream Journal — One-Click Installer
    Idempotent: safe to run multiple times. Updates existing installs.

.DESCRIPTION
    Installs or updates Dream Journal (Lantern OS) on Windows.
    - Validates prerequisites
    - Clones or pulls the repo
    - Creates Python venv and installs dependencies
    - Pulls required Ollama models
    - Installs Node dependencies for legacy lantern-garage surface
    - Creates a desktop shortcut
    - Optionally starts the server

.EXAMPLE
    # Run from the web (Administrator PowerShell recommended)
    irm https://raw.githubusercontent.com/alex-place/lantern-os/master/scripts/install-dream-journal.ps1 | iex

.EXAMPLE
    # Run locally after cloning
    powershell -ExecutionPolicy Bypass -File .\scripts\install-dream-journal.ps1

.PARAMETER SkipOllama
    Skip Ollama model downloads (useful if models are already present).

.PARAMETER SkipNode
    Skip Node.js dependency installation.

.PARAMETER StartApp
    Automatically start the Dream Journal server after install.

.PARAMETER InstallDir
    Override the default installation directory.
    Default: $env:USERPROFILE\lantern-os
#>
param(
    [switch]$SkipOllama,
    [switch]$SkipNode,
    [switch]$StartApp,
    [string]$InstallDir = ""
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
$RepoUrl      = "https://github.com/alex-place/lantern-os.git"
$RepoBranch   = "master"
$VenvName     = ".venv"
$ShortcutName = "Dream Journal"
$ServerPort   = 4177

$Models = @(
    @{ Name = "llama3.2:3b";       Desc = "Chat / inference";      Size = "~2.0 GB" },
    @{ Name = "nomic-embed-text";  Desc = "Text embeddings / RAG"; Size = "~274 MB" }
)

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    $InstallDir = Join-Path $env:USERPROFILE "lantern-os"
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Write-Header {
    param([string]$Text, [string]$Color = "Cyan")
    Write-Host ""
    Write-Host "========================================" -ForegroundColor $Color
    Write-Host "  $Text" -ForegroundColor $Color
    Write-Host "========================================" -ForegroundColor $Color
}

function Write-Step {
    param([string]$Text, [string]$Color = "White")
    Write-Host "  [+] $Text" -ForegroundColor $Color
}

function Write-Warn {
    param([string]$Text)
    Write-Host "  [!] $Text" -ForegroundColor Yellow
}

function Write-Err {
    param([string]$Text)
    Write-Host "  [X] $Text" -ForegroundColor Red
}

function Test-Command {
    param([string]$Name)
    $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-Version {
    param([string]$Command, [version]$Minimum)
    try {
        $raw = & $Command --version 2>$null
        if ($raw -match '(\d+\.\d+(?:\.\d+)?)') {
            return [version]$Matches[1] -ge $Minimum
        }
    } catch {}
    return $false
}

function Test-OllamaModel {
    param([string]$ModelName)
    try {
        $list = ollama list 2>$null
        return $list -match [regex]::Escape($ModelName)
    } catch {
        return $false
    }
}

function New-DesktopShortcut {
    param(
        [string]$Name,
        [string]$Target,
        [string]$Arguments,
        [string]$WorkingDir,
        [string]$Description
    )
    $desktop = [Environment]::GetFolderPath("Desktop")
    if (-not (Test-Path $desktop)) {
        Write-Warn "Desktop folder not found; skipping shortcut creation."
        return
    }
    $lnkPath = Join-Path $desktop "$Name.lnk"
    try {
        $wsh = New-Object -ComObject WScript.Shell
        $lnk = $wsh.CreateShortcut($lnkPath)
        $lnk.TargetPath       = $Target
        $lnk.Arguments        = $Arguments
        $lnk.WorkingDirectory = $WorkingDir
        $lnk.Description      = $Description
        $lnk.IconLocation     = "%SystemRoot%\System32\SHELL32.dll,14"
        $lnk.Save()
        Write-Step "Desktop shortcut created: $lnkPath" "Green"
    } catch {
        Write-Warn "Could not create desktop shortcut: $_"
    }
}

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
Write-Header "Lantern OS / Dream Journal Installer"
Write-Host "  InstallDir : $InstallDir" -ForegroundColor Gray
Write-Host "  Branch     : $RepoBranch" -ForegroundColor Gray
Write-Host "  Date       : $(Get-Date -Format 'yyyy-MM-dd HH:mm')" -ForegroundColor Gray
Write-Host ""

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------
Write-Header "Checking Prerequisites"

$prereqOk = $true

# PowerShell version
if ($PSVersionTable.PSVersion.Major -lt 5) {
    Write-Err "PowerShell 5.1+ required. You have $($PSVersionTable.PSVersion)"
    $prereqOk = $false
} else {
    Write-Step "PowerShell $($PSVersionTable.PSVersion) — OK" "Green"
}

# Git
if (-not (Test-Command "git")) {
    Write-Err "Git not found. Install from https://git-scm.com/download/win"
    $prereqOk = $false
} else {
    Write-Step "Git — OK" "Green"
}

# Python
if (-not (Test-Command "python")) {
    Write-Err "Python not found. Install 3.10+ from https://www.python.org/downloads/"
    Write-Err "   Make sure to check 'Add Python to PATH' during installation."
    $prereqOk = $false
} elseif (-not (Test-Version "python" "3.10.0")) {
    $pyVer = & python --version 2>&1
    Write-Err "Python 3.10+ required. Found: $pyVer"
    $prereqOk = $false
} else {
    $pyVer = & python --version 2>&1
    Write-Step "$pyVer — OK" "Green"
}

# Ollama
if (-not (Test-Command "ollama")) {
    Write-Err "Ollama not found. Install from https://ollama.com/download"
    $prereqOk = $false
} else {
    Write-Step "Ollama — OK" "Green"
}

# Node.js (optional)
$hasNode = Test-Command "node"
if ($hasNode) {
    $nodeVer = & node --version 2>&1
    if ($nodeVer -match '^v(\d+)') {
        if ([int]$Matches[1] -ge 20) {
            Write-Step "Node.js $nodeVer — OK" "Green"
        } else {
            Write-Warn "Node.js $nodeVer found; 20+ recommended for legacy surfaces."
        }
    }
} else {
    if ($SkipNode) {
        Write-Step "Node.js check skipped." "Gray"
    } else {
        Write-Warn "Node.js not found. Legacy lantern-garage Node surface will be skipped."
    }
}

if (-not $prereqOk) {
    Write-Host ""
    Write-Err "Prerequisite checks failed. Please install missing items and re-run."
    exit 1
}

# ---------------------------------------------------------------------------
# 2. Clone or update repo
# ---------------------------------------------------------------------------
Write-Header "Repository Setup"

if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Step "Existing repo found at $InstallDir — pulling latest..."
    Push-Location $InstallDir
    try {
        git fetch origin $RepoBranch | Out-Null
        git reset --hard "origin/$RepoBranch" | Out-Null
        Write-Step "Updated to latest $RepoBranch" "Green"
    } catch {
        Write-Warn "Git pull failed. Continuing with existing files..."
    } finally {
        Pop-Location
    }
} else {
    if (Test-Path $InstallDir) {
        Write-Warn "Directory exists but is not a git repo. Renaming to .backup"
        $backup = "$InstallDir.backup.$(Get-Date -Format 'yyyyMMddHHmmss')"
        Rename-Item $InstallDir $backup
    }
    Write-Step "Cloning $RepoUrl into $InstallDir ..."
    git clone --branch $RepoBranch --single-branch $RepoUrl $InstallDir
    Write-Step "Clone complete." "Green"
}

# ---------------------------------------------------------------------------
# 3. Python virtual environment
# ---------------------------------------------------------------------------
Write-Header "Python Environment"

$venvPath = Join-Path $InstallDir $VenvName
$venvPython = Join-Path $venvPath "Scripts\python.exe"
$venvPip    = Join-Path $venvPath "Scripts\pip.exe"

if (-not (Test-Path $venvPython)) {
    Write-Step "Creating virtual environment..."
    python -m venv $venvPath
    Write-Step "Virtual environment created at $venvPath" "Green"
} else {
    Write-Step "Virtual environment already exists." "Gray"
}

# ---------------------------------------------------------------------------
# 4. Install Python dependencies
# ---------------------------------------------------------------------------
Write-Header "Installing Python Dependencies"

$requirements = Join-Path $InstallDir "requirements.txt"
if (Test-Path $requirements) {
    Write-Step "Installing from requirements.txt..."
    & $venvPip install --upgrade pip | Out-Null
    & $venvPip install -r $requirements --quiet
    Write-Step "requirements.txt installed." "Green"
} else {
    Write-Warn "No requirements.txt found at repo root. Skipping base requirements."
}

# Core AI/ML stack
Write-Step "Installing PyTorch (CPU) + transformers + FAISS..."
& $venvPip install --quiet sentence-transformers faiss-cpu torch torchvision torchaudio `
    --index-url https://download.pytorch.org/whl/cpu
Write-Step "AI/ML stack installed." "Green"

# uvicorn if not already present
Write-Step "Ensuring uvicorn + fastapi are available..."
& $venvPip install --quiet uvicorn fastapi
Write-Step "Server packages installed." "Green"

# ---------------------------------------------------------------------------
# 5. Ollama models
# ---------------------------------------------------------------------------
if (-not $SkipOllama) {
    Write-Header "Pulling Ollama Models"
    foreach ($model in $Models) {
        if (Test-OllamaModel $model.Name) {
            Write-Step "$($model.Name) already present." "Gray"
        } else {
            Write-Step "Pulling $($model.Name) ($($model.Desc), $($model.Size))..."
            ollama pull $model.Name
            if ($LASTEXITCODE -ne 0) {
                Write-Warn "Model pull exited with code $LASTEXITCODE. You may need to pull manually."
            } else {
                Write-Step "$($model.Name) pulled." "Green"
            }
        }
    }
} else {
    Write-Header "Ollama Models"
    Write-Step "Skipped (--SkipOllama)" "Gray"
}

# ---------------------------------------------------------------------------
# 6. Node.js legacy surface (optional)
# ---------------------------------------------------------------------------
if (-not $SkipNode -and $hasNode) {
    Write-Header "Legacy Node Surface (lantern-garage)"
    $appDir = Join-Path $InstallDir "."
    if (Test-Path (Join-Path $appDir "package.json")) {
        Push-Location $appDir
        try {
            Write-Step "Running npm install..."
            npm install --loglevel=error 2>&1 | Out-Null
            Write-Step "npm install OK." "Green"
        } catch {
            Write-Warn "npm install failed: $_"
        } finally {
            Pop-Location
        }
    } else {
        Write-Warn "No package.json found in .. Skipping Node install."
    }
} else {
    Write-Header "Legacy Node Surface"
    Write-Step "Skipped." "Gray"
}

# ---------------------------------------------------------------------------
# 7. Desktop shortcut
# ---------------------------------------------------------------------------
Write-Header "Creating Shortcuts"

$startScript = Join-Path $InstallDir "scripts\Start-DreamJournal.ps1"
if (-not (Test-Path $startScript)) {
    # Fallback: create an inline launcher if the dedicated start script doesn't exist yet
    $startScript = Join-Path $InstallDir "Start-DreamJournal.ps1"
    $launcher = @"
# Auto-generated Dream Journal launcher
`$env:LANTERN_GARAGE_PORT = "$ServerPort"
`$root = Split-Path `$MyInvocation.MyCommand.Path -Parent
`$venvPython = Join-Path `$root "$VenvName\Scripts\python.exe"
if (-not (Test-Path `$venvPython)) {
    Write-Error "Virtual environment not found. Run the installer again."
    exit 1
}
Set-Location `$root
& `$venvPython -m uvicorn apps.lantern-garage.server:app --host 127.0.0.1 --port $ServerPort --reload
"@
    Set-Content -Path $startScript -Value $launcher -Encoding UTF8
    Write-Step "Generated launcher: $startScript" "Green"
}

New-DesktopShortcut `
    -Name $ShortcutName `
    -Target "powershell.exe" `
    -Arguments "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`"" `
    -WorkingDir $InstallDir `
    -Description "Start Dream Journal (Lantern OS) at http://127.0.0.1:$ServerPort"

# ---------------------------------------------------------------------------
# 8. Done
# ---------------------------------------------------------------------------
Write-Header "Installation Complete" "Green"
Write-Host "  Install Dir : $InstallDir" -ForegroundColor White
Write-Host "  Venv        : $venvPath" -ForegroundColor White
Write-Host "  Start URL   : http://127.0.0.1:$ServerPort" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Start commands:" -ForegroundColor Yellow
Write-Host "    Shortcut : Double-click '$ShortcutName' on your Desktop" -ForegroundColor White
Write-Host "    PowerShell: & `"$startScript`"" -ForegroundColor White
Write-Host "    Manual   : .venv\Scripts\Activate.ps1 ; python -m uvicorn apps.lantern-garage.server:app --host 127.0.0.1 --port $ServerPort --reload" -ForegroundColor White
Write-Host ""

# ---------------------------------------------------------------------------
# 9. Optional auto-start
# ---------------------------------------------------------------------------
if ($StartApp) {
    Write-Header "Starting Dream Journal" "Green"
    Set-Location $InstallDir
    . $venvPath\Scripts\Activate.ps1
    Start-Process powershell -ArgumentList "-NoExit", "-Command", ". '$venvPath\Scripts\Activate.ps1'; python -m uvicorn apps.lantern-garage.server:app --host 127.0.0.1 --port $ServerPort --reload" -WorkingDirectory $InstallDir
    Start-Sleep 3
    try {
        $health = Invoke-WebRequest -Uri "http://127.0.0.1:$ServerPort/api/health" -UseBasicParsing -TimeoutSec 5
        if ($health.StatusCode -eq 200) {
            Write-Step "Server is healthy. Opening browser..." "Green"
            Start-Process "http://127.0.0.1:$ServerPort"
        }
    } catch {
        Write-Warn "Server may still be starting. Open http://127.0.0.1:$ServerPort manually in a few moments."
    }
} else {
    Write-Host "  Tip: Re-run with -StartApp to launch the server automatically." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Happy journaling. Light the lantern." -ForegroundColor Cyan
Write-Host ""
