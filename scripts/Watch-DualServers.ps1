<#
.SYNOPSIS
    Lantern OS Dual-Boot Watchdog.
    Keeps the two dual-boot servers alive by health-checking them on an interval
    and relaunching only the one that has died.

.DESCRIPTION
    Start-DualServers.ps1 is fire-and-forget: it launches both servers detached
    and returns. If either process crashes (e.g. an unhandled rejection in a route
    handler), nothing restarts it and the port stays dead until a human notices.
    That is exactly how dev :4178 once stayed down for ~7 hours after a since-fixed
    ReferenceError crash (issue #1785).

    This watchdog closes that gap. Every -IntervalSeconds it probes
    :4177/api/version and :4178/api/version. If a server fails N consecutive
    probes, it relaunches ONLY that server, reusing the same entry paths, env
    hydration, and log files as Start-DualServers.ps1. Each restart is logged to
    logs/watchdog.log. It never touches a server that is answering.

    This EXTENDS the dual-boot system; it is not a new subsystem. Run it alongside
    (or after) Start-DualServers.ps1.

.PARAMETER StableRoot
    Worktree that serves :4177 (default C:\dev\lantern-os-stable).

.PARAMETER DevRoot
    Worktree that serves :4178 (default C:\dev\lantern-os-dev).

.PARAMETER IntervalSeconds
    Seconds between health sweeps (default 30).

.PARAMETER FailuresBeforeRestart
    Consecutive failed probes before a restart fires (default 2). Avoids
    restarting on a single transient timeout / GC pause.

.PARAMETER Once
    Run a single sweep and exit (for testing / cron-style invocation) instead of
    looping forever.

.PARAMETER RegisterTask
    Install a Windows Scheduled Task ("LanternWatchdogRevive") that relaunches
    this script every 15 minutes. Combined with the singleton guard, this closes
    the "who watches the watchdog" gap: if the looping watchdog dies (or was only
    ever started with -Once), the task revives it; if it is alive, the new
    instance exits immediately.

.EXAMPLE
    pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/Watch-DualServers.ps1
    pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/Watch-DualServers.ps1 -Once
    pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/Watch-DualServers.ps1 -RegisterTask
#>

param(
    [string]$StableRoot            = "C:\dev\lantern-os-stable",
    [string]$DevRoot               = "C:\dev\lantern-os-dev",
    [int]   $IntervalSeconds       = 30,
    [int]   $FailuresBeforeRestart = 2,
    [switch]$Once,
    [switch]$RegisterTask
)

$ErrorActionPreference = "Continue"
$RepoRoot = Split-Path -Parent $PSScriptRoot | Resolve-Path
$LogDir   = Join-Path $RepoRoot "logs"
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$WatchLog = Join-Path $LogDir "watchdog.log"

function Log($msg) {
    $line = "[$(Get-Date -Format 'u')] $msg"
    Write-Host $line
    Add-Content -Path $WatchLog -Value $line -ErrorAction SilentlyContinue
}

# Absolute entry paths so a restart launches the SAME instance the launcher did,
# and so it stays identifiable by command line (matches Start-DualServers.ps1).
$StableEntry = Join-Path $StableRoot 'apps\lantern-garage\server.js'
$DevEntry    = Join-Path $DevRoot    'apps\lantern-garage\server-dev.js'

# --- Hydrate persistent environment once, so any server we relaunch gets its keys.
# Keys live in the Machine/User environment, not a committed .env (same as launcher).
foreach ($scope in 'Machine','User') {
    $vars = [Environment]::GetEnvironmentVariables($scope)
    foreach ($k in $vars.Keys) { try { Set-Item -Path ("env:" + $k) -Value $vars[$k] -ErrorAction SilentlyContinue } catch {} }
}
# Neither server should spawn its own cloudflared (see Start-DualServers.ps1).
$env:LANTERN_CLOUDFLARE_TUNNEL = 'false'

# Per-server watchdog state: url, how to (re)launch it, and a failure counter.
$targets = @(
    @{
        Name  = 'stable :4177'
        Url   = 'http://127.0.0.1:4177/api/version'
        Entry = $StableEntry
        Root  = $StableRoot
        # server.js binds 0.0.0.0 when PORT is set (Cloudflare tunnel).
        Port  = '4177'
        OutLog = Join-Path $LogDir 'stable-4177.out.log'
        ErrLog = Join-Path $LogDir 'stable-4177.err.log'
        Fails = 0
    },
    @{
        Name  = 'dev :4178'
        Url   = 'http://127.0.0.1:4178/api/version'
        Entry = $DevEntry
        Root  = $DevRoot
        # server-dev.js forces its own port/host; PORT must be UNSET for it.
        Port  = $null
        OutLog = Join-Path $LogDir 'dev-4178.out.log'
        ErrLog = Join-Path $LogDir 'dev-4178.err.log'
        Fails = 0
    }
)

function Test-Healthy($url) {
    try {
        $r = Invoke-WebRequest $url -TimeoutSec 4 -UseBasicParsing -ErrorAction SilentlyContinue
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Restart-Target($t) {
    if (-not (Test-Path $t.Entry)) {
        Log ("  [SKIP] {0}: entry not found ({1}) - worktree missing?" -f $t.Name, $t.Entry)
        return
    }
    # Reap any half-dead instance of THIS entry (a zombie still holding child ports)
    # before relaunching, so we don't stack duplicates.
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and ($_.CommandLine -like ("*" + $t.Entry + "*")) } |
        ForEach-Object { & taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null }

    if ($t.Port) { $env:PORT = $t.Port } else { Remove-Item env:PORT -ErrorAction SilentlyContinue }
    $p = Start-Process -FilePath "node" -ArgumentList $t.Entry `
        -WorkingDirectory $t.Root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $t.OutLog -RedirectStandardError $t.ErrLog
    Remove-Item env:PORT -ErrorAction SilentlyContinue
    Log ("  [RESTART] {0} relaunched (pid {1}) from {2}" -f $t.Name, $p.Id, $t.Root)
}

function Invoke-Sweep {
    foreach ($t in $targets) {
        if (Test-Healthy $t.Url) {
            if ($t.Fails -gt 0) { Log ("  [OK] {0} recovered" -f $t.Name) }
            $t.Fails = 0
        } else {
            $t.Fails++
            Log ("  [DOWN] {0} failed probe {1}/{2}" -f $t.Name, $t.Fails, $FailuresBeforeRestart)
            if ($t.Fails -ge $FailuresBeforeRestart) {
                Restart-Target $t
                $t.Fails = 0
            }
        }
    }
}

if ($RegisterTask) {
    $action  = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -StableRoot `"$StableRoot`" -DevRoot `"$DevRoot`""
    # PS 5.1 task XML rejects [TimeSpan]::MaxValue; 10 years is effectively forever.
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
    try {
        Register-ScheduledTask -TaskName "LanternWatchdogRevive" -Action $action -Trigger $trigger -Force -ErrorAction Stop | Out-Null
        Log "Registered scheduled task 'LanternWatchdogRevive' (relaunch every 15 min; singleton guard dedupes)."
    } catch {
        Log ("FAILED to register scheduled task 'LanternWatchdogRevive': {0}" -f $_.Exception.Message)
        exit 1
    }
    return
}

# --- Singleton guard: a looping watchdog that dies must be revivable by blindly
# relaunching this script (launcher, scheduled task, human). If a looping instance
# is already alive, exit instead of stacking duplicates. -Once sweeps are exempt.
if (-not $Once) {
    $me = $PID
    $dupes = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -like "*Watch-DualServers.ps1*" -and $_.CommandLine -notlike "*-Once*" -and $_.CommandLine -notlike "*-RegisterTask*" }
    if ($dupes) {
        Log ("Watchdog already running (pid {0}); exiting duplicate." -f ($dupes[0].ProcessId))
        return
    }
}

# Heartbeat: stamped every sweep so anything (including a future probe) can tell
# a live looping watchdog from one that silently died or ran with -Once.
$Heartbeat = Join-Path $LogDir "watchdog-heartbeat.txt"
function Write-Heartbeat($mode) {
    "$(Get-Date -Format 'u') mode=$mode pid=$PID" | Set-Content -Path $Heartbeat -Encoding ascii -ErrorAction SilentlyContinue
}

Log ("Watchdog starting (interval ${IntervalSeconds}s, restart after $FailuresBeforeRestart failed probes). Stable=$StableRoot Dev=$DevRoot")

if ($Once) {
    Invoke-Sweep
    Write-Heartbeat "once"
    Log "Single sweep complete (-Once); exiting."
    return
}

while ($true) {
    Invoke-Sweep
    Write-Heartbeat "loop"
    Start-Sleep -Seconds $IntervalSeconds
}
