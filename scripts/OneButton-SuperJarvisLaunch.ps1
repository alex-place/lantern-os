[CmdletBinding()]
param(
    [int]$Port = 8787,
    [int]$Passes = 10,
    [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$backupRoot = Join-Path $repoRoot 'data\local-backups'
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $backupRoot "pre-onebutton-$stamp"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

function Write-Step {
    param([string]$Message)
    Write-Host "[OneButton] $Message"
}

Push-Location $repoRoot
try {
    Write-Step "Repo root: $repoRoot"
    Write-Step "Saving git status before sync."
    git status --short --branch | Tee-Object -FilePath (Join-Path $backupDir 'git-status-before.txt')

    $dirty = git status --porcelain
    if ($dirty) {
        Write-Step "Dirty worktree detected. Creating non-destructive stash including untracked files."
        git stash push -u -m "onebutton-before-pull-$stamp" | Tee-Object -FilePath (Join-Path $backupDir 'stash-result.txt')
        git stash list | Tee-Object -FilePath (Join-Path $backupDir 'stash-list-after.txt')
    } else {
        Write-Step "Worktree clean before pull."
    }

    Write-Step "Pulling origin/master with --ff-only."
    git pull --ff-only | Tee-Object -FilePath (Join-Path $backupDir 'git-pull.txt')

    Write-Step "Running Super Jarvis perfect validation loop ($Passes passes)."
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-SuperJarvisPerfectLoop.ps1 -Passes $Passes

    if ($dirty) {
        Write-Step "Local work was stashed. It is preserved, not reapplied automatically."
        Write-Step "Review later with: git stash list ; git stash show --stat stash@{0} ; git stash apply stash@{0}"
    }

    Write-Step "Launching Lantern repo app."
    if ($NoBrowser) {
        powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-LanternRepoApp.ps1 -Port $Port -NoBrowser
    } else {
        powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-LanternRepoApp.ps1 -Port $Port
    }

    Write-Step "Done. App URL: http://127.0.0.1:$Port/surfaces/tony-garage/index.html"
    Write-Step "Backup/log folder: $backupDir"
} finally {
    Pop-Location
}
