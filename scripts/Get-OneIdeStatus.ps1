param(
    [string]$LanternRoot = "C:\tmp\lantern-os",
    [string]$HffRoot = "C:\Users\alexp\.codex\worktrees\4e17\human-flourishing-frameworks-scan",
    [string]$OrchestratorRoot = "C:\Users\alexp\Documents\gm-agent-orchestrator",
    [string]$AgentWorktreesRoot = "C:\Users\alexp\Documents\agent-worktrees",
    [int]$TimeoutSeconds = 2,
    [switch]$WriteReceipt
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-GitSnapshot {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return [ordered]@{ path = $Path; exists = $false; isGit = $false; dirty = $null; branch = $null; dirtyCount = 0; status = @("missing") }
    }

    $status = @()
    try {
        $status = @(git -C $Path status --short --branch 2>$null)
    } catch {
        return [ordered]@{ path = $Path; exists = $true; isGit = $false; dirty = $null; branch = $null; dirtyCount = 0; status = @("git_status_failed") }
    }

    $dirtyLines = @($status | Where-Object { $_ -and -not $_.StartsWith("## ") })
    return [ordered]@{
        path = $Path
        exists = $true
        isGit = $true
        dirty = ($dirtyLines.Count -gt 0)
        branch = (($status | Where-Object { $_.StartsWith("## ") } | Select-Object -First 1) -replace "^## ", "")
        dirtyCount = $dirtyLines.Count
        status = $status
    }
}

function Test-HealthUrl {
    param([string]$Name, [string]$Url)
    if ([string]::IsNullOrWhiteSpace($Url)) {
        return [ordered]@{ name = $Name; url = $Url; checked = $false; ok = $null; statusCode = $null; error = "no_health_url" }
    }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSeconds
        return [ordered]@{ name = $Name; url = $Url; checked = $true; ok = ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400); statusCode = [int]$response.StatusCode; error = $null }
    } catch {
        $statusCode = $null
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }
        return [ordered]@{ name = $Name; url = $Url; checked = $true; ok = $false; statusCode = $statusCode; error = $_.Exception.Message }
    }
}

function Get-OptionalProperty {
    param(
        [object]$Object,
        [string]$Name,
        [object]$Default = $null
    )
    if ($null -eq $Object) { return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    return $property.Value
}

function Get-OrchestratorServices {
    param([string]$Root)
    $configPath = Join-Path $Root "config\local-services.json"
    if (-not (Test-Path -LiteralPath $configPath)) { return @() }
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    return @($config.services | ForEach-Object {
        Test-HealthUrl -Name $_.name -Url $_.healthUrl
    })
}

function Get-AgentWorktrees {
    param([string]$Root)
    if (-not (Test-Path -LiteralPath $Root)) { return @() }
    return @(Get-ChildItem -LiteralPath $Root -Directory | Sort-Object Name | ForEach-Object {
        $snapshot = Get-GitSnapshot -Path $_.FullName
        [ordered]@{
            name = $_.Name
            path = $_.FullName
            exists = $snapshot.exists
            isGit = $snapshot.isGit
            dirty = $snapshot.dirty
            dirtyCount = $snapshot.dirtyCount
            branch = $snapshot.branch
        }
    })
}

function Get-CloudMirrors {
    param([string]$Root)
    $manifestPath = Join-Path $Root "manifests\cloud-mirrors.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) { return @() }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    return @($manifest.cloudMirrors | ForEach-Object {
        $healthPath = if ($_.healthPath) { $_.healthPath } else { "/api/health" }
        $url = ($_.url.TrimEnd("/") + $healthPath)
        $probe = Test-HealthUrl -Name $_.name -Url $url
        [ordered]@{
            name = $_.name
            url = $_.url
            healthUrl = $url
            manifestStatus = $_.status
            ok = $probe.ok
            statusCode = $probe.statusCode
            error = $probe.error
        }
    })
}

$repos = @(
    Get-GitSnapshot -Path $LanternRoot
    Get-GitSnapshot -Path $HffRoot
    Get-GitSnapshot -Path $OrchestratorRoot
)
$services = Get-OrchestratorServices -Root $OrchestratorRoot
$agents = Get-AgentWorktrees -Root $AgentWorktreesRoot
$cloudMirrors = Get-CloudMirrors -Root $LanternRoot

$mcpReceiptPath = Join-Path $LanternRoot "manifests\validation\MCP-CONNECTOR-LATEST.json"
$mcp = [ordered]@{ exists = $false }
if (Test-Path -LiteralPath $mcpReceiptPath) {
    $receipt = Get-Content -Raw -LiteralPath $mcpReceiptPath | ConvertFrom-Json
    $mcp = [ordered]@{
        exists = $true
        status = (Get-OptionalProperty -Object $receipt -Name "status" -Default "unknown")
        primarySourceId = (Get-OptionalProperty -Object $receipt -Name "primarySourceId" -Default "unknown")
        totalToolCount = (Get-OptionalProperty -Object $receipt -Name "totalToolCount")
        readyWithToolsCount = (Get-OptionalProperty -Object $receipt -Name "readyWithToolsCount")
        path = $mcpReceiptPath
    }
}

$dirtyRepos = @($repos | Where-Object { $_.dirty -eq $true })
$dirtyAgents = @($agents | Where-Object { $_.dirty -eq $true })
$failedServices = @($services | Where-Object { $_.checked -eq $true -and $_.ok -ne $true })
$failedCloud = @($cloudMirrors | Where-Object { $_.ok -ne $true })

$result = [ordered]@{
    schema = "lantern.one_ide_status.v1"
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    mode = "read_only_preflight"
    boundaries = @(
        "do_not_reset_clean_sync_or_dispatch_dirty_worktrees",
        "do_not_trust_cloud_url_until_health_and_root_routes_pass",
        "healthUrl_beats_cached_status_when_present",
        "actual_mcp_tools_beat_advertised_claims"
    )
    repos = $repos
    services = $services
    agentWorktrees = $agents
    cloudMirrors = $cloudMirrors
    mcpConnector = $mcp
    risk = [ordered]@{
        dirtyRepoCount = $dirtyRepos.Count
        dirtyAgentWorktreeCount = $dirtyAgents.Count
        failedServiceCount = $failedServices.Count
        failedCloudMirrorCount = $failedCloud.Count
        recommendedAction = if ($dirtyRepos.Count -or $dirtyAgents.Count) {
            "hold mutation; reconcile dirty worktrees in one IDE board first"
        } elseif ($failedCloud.Count) {
            "fix deploy/runtime cloud route before changing more local URLs"
        } elseif ($failedServices.Count) {
            "repair local healthUrl failures before dispatch"
        } else {
            "preflight clean enough for scoped validated work"
        }
    }
}

if ($WriteReceipt) {
    $outPath = Join-Path $LanternRoot "manifests\validation\ONE-IDE-STATUS-LATEST.json"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outPath) | Out-Null
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $outPath -Encoding UTF8
}

$result | ConvertTo-Json -Depth 8
