<#
.SYNOPSIS
    Lantern OS Dual-Boot Quickstart (worktree-based).
    Runs two servers from their own dedicated git worktrees:
      :4177 stable / public  <-  C:\dev\lantern-os-stable   (Cloudflare tunnel)
      :4178 dev   / local    <-  C:\dev\lantern-os-dev       (server-dev.js, loopback)

.DESCRIPTION
    Each server runs from a dedicated worktree, NOT the main checkout. The
    autonomous automation does `git checkout` / `git reset --hard origin/master`
    on the main checkout (C:\dev\lantern-os) between turns; a server running there
    would have code and env yanked out from under it mid-request. Dedicated
    worktrees isolate the running servers from that churn.
    See docs/DEV-SERVER-WORKTREE.md.

    API keys and credentials are NOT stored in a committed .env — they live in the
    persistent Machine/User environment. This script hydrates that environment
    into both servers so they come up fully provisioned.

.PARAMETER NoChrome
    Skip auto-launching Chrome.

.PARAMETER NoWatchdog
    Skip launching Watch-DualServers.ps1. By default this launcher also starts the
    watchdog (detached) so a server that later crashes is auto-restarted instead of
    staying dead until a human notices (issue #1785).

.PARAMETER StableRoot
    Worktree that serves :4177 (default C:\dev\lantern-os-stable).

.PARAMETER DevRoot
    Worktree that serves :4178 (default C:\dev\lantern-os-dev).

.EXAMPLE
    pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/Start-DualServers.ps1
    pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/Start-DualServers.ps1 -NoChrome
#>

param(
    [switch]$NoChrome,
    [switch]$NoWatchdog,
    [switch]$RegisterAutoDeploy,
    [switch]$NoAutoDeploy,
    [string]$StableRoot = "C:\dev\lantern-os-stable",
    [string]$DevRoot    = "C:\dev\lantern-os-dev"
)

$ErrorActionPreference = "Continue"
$RepoRoot = Split-Path -Parent $PSScriptRoot | Resolve-Path
$LogDir   = Join-Path $RepoRoot "logs"

Write-Host ""
Write-Host "Lantern OS - Dual Boot Quickstart (worktree-based)" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# --- Prerequisites -----------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "Missing: Node.js" -ForegroundColor Red; exit 1 }
foreach ($wt in @($StableRoot, $DevRoot)) {
    if (-not (Test-Path (Join-Path $wt "apps\lantern-garage\server.js"))) {
        Write-Host "Worktree not found or incomplete: $wt" -ForegroundColor Red
        Write-Host "Create the dual-boot worktrees first (see docs/DEV-SERVER-WORKTREE.md):" -ForegroundColor Yellow
        Write-Host "  git worktree add $StableRoot stable-server" -ForegroundColor Gray
        Write-Host "  git worktree add $DevRoot dev-server" -ForegroundColor Gray
        exit 1
    }
}
Write-Host ("Node {0}; worktrees present." -f (node --version)) -ForegroundColor Green

# --- Dependency preflight: catch node_modules drift BEFORE launch ------------
# The dual-boot's most common silent failure is a worktree whose node_modules is
# missing or drifted from package.json: the server then throws MODULE_NOT_FOUND at
# require() time and the port answers HTTP 000 with nothing but a stack in the err
# log. This preflight resolve-probes a required dependency in each worktree and runs
# `npm install` ONLY when it can't resolve (missing/broken), so a healthy tree is
# untouched and the command stays idempotent. A lockfile-vs-package.json drift is
# surfaced as a warning (non-fatal). Refs the "preview HTTP 000 on node_modules
# drift" gotcha.
function Test-WorktreeDeps($wt) {
    $appDir = Join-Path $wt 'apps\lantern-garage'
    $nm     = Join-Path $appDir 'node_modules'
    $probe  = 'try{require.resolve("express-session");process.exit(0)}catch(e){process.exit(3)}'
    Push-Location $appDir
    try {
        & node -e $probe 2>$null | Out-Null
        $resolved = ($LASTEXITCODE -eq 0)
        if (-not $resolved) {
            Write-Host ("  [deps] {0}: node_modules missing/drifted - running npm install..." -f $wt) -ForegroundColor Yellow
            & npm install --no-audit --no-fund 2>&1 | Out-Null
            & node -e $probe 2>$null | Out-Null
            $resolved = ($LASTEXITCODE -eq 0)
            if ($resolved) { Write-Host ("  [deps] {0}: dependencies installed." -f $wt) -ForegroundColor Green }
            else           { Write-Host ("  [deps] {0}: STILL unresolved after npm install - server may fail to boot (see logs)." -f $wt) -ForegroundColor Red }
        } else {
            # Healthy: warn only if the lockfile is older than package.json (possible drift).
            $pkg  = Join-Path $appDir 'package.json'
            $lock = Join-Path $nm '.package-lock.json'
            if ((Test-Path $pkg) -and (Test-Path $lock) -and
                ((Get-Item $pkg).LastWriteTime -gt (Get-Item $lock).LastWriteTime)) {
                Write-Host ("  [deps] {0}: package.json is newer than the installed lockfile - consider `npm install`." -f $wt) -ForegroundColor Yellow
            } else {
                Write-Host ("  [deps] {0}: dependencies OK." -f $wt) -ForegroundColor Green
            }
        }
    } finally { Pop-Location }
}
foreach ($wt in @($StableRoot, $DevRoot)) { Test-WorktreeDeps $wt }

# --- Workstream hooks (dynamic per-lane PR gate) -----------------------------
# Install the monoworkstream git hooks as part of quickstart so the dynamic
# per-human lanes (alex/, kriskin/, mookman11/, any NAME/ - one open PR each)
# plus the slop + change-record gates are active. The main checkout's .git/hooks
# is shared by every linked worktree (stable :4177, dev :4178) via the common git
# dir, so installing once here covers them all. Best-effort: a hook-install hiccup
# must never block the servers from coming up.
try {
    $hookInstaller = Join-Path $RepoRoot "scripts\Install-MonoworkstreamHooks.ps1"
    if (Test-Path $hookInstaller) {
        Push-Location $RepoRoot
        try { & $hookInstaller | Out-Null } finally { Pop-Location }
        Write-Host "Workstream hooks installed (dynamic per-lane PR gate active)." -ForegroundColor Green
    } else {
        Write-Host "Workstream hook installer not found - skipping (lane gate not enforced locally)." -ForegroundColor Yellow
    }
} catch {
    Write-Host ("Workstream hooks install skipped: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
}

# --- Stable auto-deploy: keep the repo-managed deploy task in sync ------------
# The stable :4177 worktree is brought up to origin/master every 5 min by the
# KeystoneAutoDeployStable scheduled task, which runs scripts/auto-deploy-stable.ps1
# via an out-of-repo running copy + a hidden wscript launcher (no console flash).
# Register-AutoDeployStable.ps1 re-syncs that running copy from the tracked source so
# the two can't drift by hand. We only touch it when this machine IS the deploy host
# (task already exists) or the operator explicitly asks (-RegisterAutoDeploy); a fresh
# contributor's quickstart never silently registers a deploy task. Best-effort: a
# hiccup here must never block the servers from coming up. Skip with -NoAutoDeploy.
if (-not $NoAutoDeploy) {
    try {
        $alreadySetUp = [bool](Get-ScheduledTask -TaskName 'KeystoneAutoDeployStable' -ErrorAction SilentlyContinue)
        if ($RegisterAutoDeploy -or $alreadySetUp) {
            $regAutoDeploy = Join-Path $PSScriptRoot "Register-AutoDeployStable.ps1"
            if (Test-Path $regAutoDeploy) {
                & $regAutoDeploy -RepoRoot $RepoRoot | Out-Null
                Write-Host "Stable auto-deploy synced (KeystoneAutoDeployStable, every 5 min, hidden)." -ForegroundColor Green
            }
        }
    } catch {
        Write-Host ("Stable auto-deploy sync skipped: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
    }
}

# --- Hydrate persistent environment (so the servers get their keys) ----------
# Keys/credentials live in the Machine/User environment, not a committed .env.
foreach ($scope in 'Machine','User') {
    $vars = [Environment]::GetEnvironmentVariables($scope)
    foreach ($k in $vars.Keys) { try { Set-Item -Path ("env:" + $k) -Value $vars[$k] -ErrorAction SilentlyContinue } catch {} }
}

# Neither server should spawn its own cloudflared: the cloudflared Windows service
# (LanternCloudflareTunnel) is the real tunnel to :4177, and dev (:4178) is loopback-only.
# Without this, both boots run `cloudflared tunnel run` against the Unix creds path in
# ~/.cloudflared/config.yml that doesn't exist on Windows -> a failed spawn + log spam on
# every start. Inherited by both Start-Process children below.
$env:LANTERN_CLOUDFLARE_TUNNEL = 'false'

# The chat assistant's capabilities ARE tool calls (apps/lantern-garage/lib/tool-runner.js):
# web search/fetch, files, repo/GitHub, market data, and the live system_status probe all run
# through the native tool-use loop, which is gated by CHAT_TOOL_EXEC. Force it ON here so EVERY
# model (Claude / GPT / Gemini / Grok / local) can actually use tools -- otherwise the assistant
# boots "toolless" and fabricates instead of measuring. Belt-and-suspenders (matches the
# LANTERN_CLOUDFLARE_TUNNEL line above): the tool loop must not be left to the ambient env.
$env:CHAT_TOOL_EXEC = '1'
# The MCP server (:8771) is the shared tool surface -- external agents (Claude Code) plus the
# chat's own live status/skills context (keystone-context.js) and the system_status tool.
# server.js spawns it as a singleton when this is not 'false'; keep it explicitly enabled.
$env:LANTERN_MCP_SERVER = 'true'

# Absolute entry paths so each instance is identifiable by its command line -- this is
# what lets the reap below (and the stable auto-deploy) clean leaked ZOMBIES, not just
# the current port owner.
$StableEntry = Join-Path $StableRoot 'apps\lantern-garage\server.js'
$DevEntry    = Join-Path $DevRoot    'apps\lantern-garage\server-dev.js'

# --- Stop existing servers: tree-kill the port owners + reap leaked zombies --
# The old flow only Stop-Process'd the port LISTENER, which (a) orphaned the child
# services (MCP 8771/8772, trading 5050, discord) and (b) missed ZOMBIES -- a server
# alive but no longer listening (its setInterval collectors keep the event loop up).
# Those leaked instances then contend for the singleton child-service ports and churn
# the next boot (the lantern-os.net 502 failure mode). taskkill /T takes the children
# too; the entry-path sweep catches zombies for BOTH worktrees.
Write-Host "Stopping existing :4177/:4178 servers + child services (tree-kill + zombie reap)..." -ForegroundColor Yellow
$toKill = @()
foreach ($port in 4177,4178,8771,8772,5050) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { $toKill += [int]$_.OwningProcess }
}
foreach ($entry in @($StableEntry, $DevEntry)) {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$entry*") } |
        ForEach-Object { $toKill += [int]$_.ProcessId }
}
foreach ($procId in ($toKill | Sort-Object -Unique)) {
    & taskkill /PID $procId /T /F 2>&1 | Out-Null
}
Start-Sleep -Milliseconds 1200
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

# --- Check for Python (MCP server needs it) --
$pythonExists = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonExists) {
    Write-Host "Warning: Python not found. MCP server (port 8771) will not start." -ForegroundColor Yellow
    Write-Host "To use MCP tools, install Python from python.org and run: pip install -r requirements.txt" -ForegroundColor DarkGray
}

# --- :4177 stable / public (PORT=4177 -> binds 0.0.0.0 for the Cloudflare tunnel)
Write-Host "Starting stable :4177 from $StableRoot ..." -ForegroundColor Blue
$env:PORT = "4177"
$stable = Start-Process -FilePath "node" -ArgumentList $StableEntry `
    -WorkingDirectory $StableRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $LogDir "stable-4177.out.log") `
    -RedirectStandardError  (Join-Path $LogDir "stable-4177.err.log")

# --- :4178 dev / local (server-dev.js forces port 4178 and binds 127.0.0.1) --
Write-Host "Starting dev :4178 from $DevRoot ..." -ForegroundColor Green
Remove-Item env:PORT -ErrorAction SilentlyContinue   # server-dev.js sets its own port/host
$dev = Start-Process -FilePath "node" -ArgumentList $DevEntry `
    -WorkingDirectory $DevRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $LogDir "dev-4178.out.log") `
    -RedirectStandardError  (Join-Path $LogDir "dev-4178.err.log")

# --- :8771 MCP server (shared by both web servers) if Python is available --
if ($pythonExists) {
    Write-Host "Starting MCP :8771 from $StableRoot ..." -ForegroundColor Blue
    $env:MCP_SERVER_PORT = "8771"
    $mcp_stable = Start-Process -FilePath "python" -ArgumentList "src/mcp_server/server.py" `
        -WorkingDirectory $StableRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $LogDir "mcp-8771.out.log") `
        -RedirectStandardError  (Join-Path $LogDir "mcp-8771.err.log")

    Remove-Item env:MCP_SERVER_PORT -ErrorAction SilentlyContinue
}

# --- :11434 local Sigma0 model server (Ouro-1.4B, Ollama-compatible) ---------
# Opt-in: set KEYSTONE_SERVE_OURO=1 in the persistent env to have quickboot bring up
# the local Sigma0 model. scripts/ouro_serve.py binds :11434 and speaks the Ollama
# HTTP API itself (NO Ollama binary needed); the chat reaches it via
# OLLAMA_MODEL=ouro:latest. OURO_4BIT=1 keeps resident VRAM to ~1.85GB so it fits the
# 8GB card. It loads at boot when free RAM is highest -- the mid-session fp16->4bit
# LOAD transient (~4GB) is what OOMs an already-busy desktop, not the resident model.
# The 7.6B models/keystone-sigma0-plt is deliberately NOT auto-served here: it needs a
# >=24GB GPU box (see models/keystone-sigma0-plt/README.md) and thrashes this machine.
# Best-effort: a model-server hiccup must never block the web servers from coming up.
if ($env:KEYSTONE_SERVE_OURO -eq '1') {
    $ouroPy     = Join-Path $RepoRoot '.venv-train\Scripts\python.exe'
    $ouroScript = Join-Path $RepoRoot 'scripts\ouro_serve.py'
    $ouroUp     = [bool](Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue)
    if ($ouroUp) {
        Write-Host "Local model server already up on :11434 - leaving it." -ForegroundColor DarkGray
    } elseif ((Test-Path $ouroPy) -and (Test-Path $ouroScript)) {
        Write-Host "Starting local Sigma0 model server (Ouro-1.4B, 4-bit) on :11434 from $RepoRoot ..." -ForegroundColor Blue
        if (-not $env:HF_HOME) { $env:HF_HOME = 'D:\hf-cache' }
        $env:OURO_4BIT = '1'; $env:OURO_PORT = '11434'
        Start-Process -FilePath $ouroPy -ArgumentList $ouroScript `
            -WorkingDirectory $RepoRoot -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $LogDir 'ouro-serve-11434.out.log') `
            -RedirectStandardError  (Join-Path $LogDir 'ouro-serve-11434.err.log') | Out-Null
        Remove-Item env:OURO_4BIT, env:OURO_PORT -ErrorAction SilentlyContinue
        Write-Host "  (loads in ~30-60s; chat uses it when OLLAMA_MODEL=ouro:latest)" -ForegroundColor DarkGray
    } else {
        Write-Host "KEYSTONE_SERVE_OURO=1 but .venv-train or ouro_serve.py missing - skipping local model." -ForegroundColor Yellow
    }
}

# --- Health check ------------------------------------------------------------
Write-Host "Health check..." -ForegroundColor Yellow
$stableOk = $false; $devOk = $false; $mcpOk = $false
foreach ($i in 1..20) {
    if (-not $stableOk) { try { if ((Invoke-WebRequest "http://127.0.0.1:4177/api/version" -TimeoutSec 2 -ErrorAction SilentlyContinue).StatusCode -eq 200) { $stableOk = $true } } catch {} }
    if (-not $devOk)    { try { if ((Invoke-WebRequest "http://127.0.0.1:4178/api/version" -TimeoutSec 2 -ErrorAction SilentlyContinue).StatusCode -eq 200) { $devOk = $true } } catch {} }
    if ($pythonExists) {
        if (-not $mcpOk)   { try { if ((Invoke-WebRequest "http://127.0.0.1:8771/health" -TimeoutSec 2 -ErrorAction SilentlyContinue).StatusCode -eq 200) { $mcpOk = $true } } catch {} }
    }
    if ($stableOk -and $devOk -and (-not $pythonExists -or $mcpOk)) { break }
    Start-Sleep -Milliseconds 800
}
if ($stableOk) { Write-Host "  OK  stable :4177 (pid $($stable.Id))" -ForegroundColor Green } else { Write-Host "  WARN stable :4177 not responding - see $LogDir\stable-4177.err.log" -ForegroundColor Yellow }
if ($devOk)    { Write-Host "  OK  dev    :4178 (pid $($dev.Id))"    -ForegroundColor Green } else { Write-Host "  WARN dev :4178 not responding - see $LogDir\dev-4178.err.log" -ForegroundColor Yellow }
if ($pythonExists) {
    if ($mcpOk) { Write-Host "  OK  MCP    :8771 (pid $($mcp_stable.Id))" -ForegroundColor Blue } else { Write-Host "  WARN MCP :8771 not responding - see $LogDir\mcp-8771.err.log" -ForegroundColor Yellow }
}

if (-not $NoChrome) {
    try { Start-Process "chrome.exe" "http://127.0.0.1:4177/dream-chat.html" -ErrorAction SilentlyContinue } catch {}
}

Write-Host ""
Write-Host "Dual boot running:" -ForegroundColor Cyan
Write-Host "  Stable (public) http://127.0.0.1:4177  <- $StableRoot" -ForegroundColor Blue
Write-Host "  Dev    (local)  http://127.0.0.1:4178  <- $DevRoot" -ForegroundColor Green
if ($pythonExists) {
    Write-Host "  MCP    (shared) http://127.0.0.1:8771  <- $StableRoot (MCP tools for Claude Code)" -ForegroundColor Blue
}
Write-Host ""
Write-Host "Note: both instances run their own Discord bot / Kalshi collector." -ForegroundColor DarkGray
Write-Host "The Cloudflare tunnel (if running) reconnects to :4177." -ForegroundColor DarkGray
if ($pythonExists) {
    Write-Host "MCP server (port 8771) is available for Claude Code to call unisona.ai's tools." -ForegroundColor DarkGray
} else {
    Write-Host "MCP server requires Python. Install with: python -m pip install -r requirements.txt" -ForegroundColor DarkGray
}
# --- Watchdog: keep the servers alive after this launcher returns --------------
# Start-DualServers is fire-and-forget; without a supervisor a crashed server
# stays down until a human notices (issue #1785). Launch the watchdog detached so
# it health-checks both ports and resurrects only the one that died.
if (-not $NoWatchdog) {
    $watchdog = Join-Path $PSScriptRoot "Watch-DualServers.ps1"
    if (Test-Path $watchdog) {
        Remove-Item env:PORT -ErrorAction SilentlyContinue
        Start-Process -FilePath "powershell" `
            -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File",$watchdog,"-StableRoot",$StableRoot,"-DevRoot",$DevRoot `
            -WindowStyle Hidden | Out-Null
        Write-Host "  Watchdog        (supervisor) auto-restarts a crashed server -> logs/watchdog.log" -ForegroundColor DarkGray
    } else {
        Write-Host "  Watchdog script not found ($watchdog); servers run unsupervised." -ForegroundColor Yellow
    }
}
Write-Host ""

Write-Host ""
# Servers run detached (Start-Process); this launcher returns instead of blocking.
