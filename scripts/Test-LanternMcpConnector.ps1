param(
    [string]$BaseUrl = "http://127.0.0.1:8787",
    [string]$OutputPath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path "manifests\validation\MCP-CONNECTOR-LATEST.json"),
    [int]$TimeoutSec = 3,
    [switch]$AllowRemote
)

$ErrorActionPreference = "Stop"

function New-FailedProbe {
    param(
        [string]$Url,
        [string]$ErrorMessage
    )

    return [ordered]@{
        url = $Url
        ok = $false
        statusCode = $null
        contentType = $null
        json = $null
        preview = $null
        error = $ErrorMessage
    }
}

function Invoke-McpProbe {
    param(
        [string]$Url,
        [int]$TimeoutSec
    )

    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
        $content = [string]$response.Content
        $json = $null
        $preview = $content
        if ($preview.Length -gt 2000) {
            $preview = $preview.Substring(0, 2000)
        }

        if ($content.TrimStart().StartsWith("{") -or $content.TrimStart().StartsWith("[")) {
            try {
                $json = $content | ConvertFrom-Json -ErrorAction Stop
            }
            catch {
                $json = $null
            }
        }

        return [ordered]@{
            url = $Url
            ok = ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300)
            statusCode = [int]$response.StatusCode
            contentType = [string]$response.Headers["Content-Type"]
            json = $json
            preview = $preview
            error = $null
        }
    }
    catch {
        return (New-FailedProbe -Url $Url -ErrorMessage $_.Exception.Message)
    }
}

try {
    $uri = [System.Uri]$BaseUrl
}
catch {
    $result = [ordered]@{
        generatedAt = (Get-Date).ToString("o")
        baseUrl = $BaseUrl
        status = "hold"
        boundaryStatus = "invalid_base_url"
        error = $_.Exception.Message
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
    Write-Output $OutputPath
    exit 2
}

$isLoopback = $uri.IsLoopback -or $uri.Host -in @("localhost", "127.0.0.1", "::1")

if (-not $isLoopback -and -not $AllowRemote) {
    $result = [ordered]@{
        generatedAt = (Get-Date).ToString("o")
        baseUrl = $BaseUrl
        status = "hold"
        boundaryStatus = "remote_endpoint_blocked"
        reason = "Lantern OS MCP connector defaults to local-first. Re-run with -AllowRemote only after endpoint, auth, and exposed tools are verified."
        safety = [ordered]@{
            loopbackOnlyDefault = $true
            destructiveOperations = "not_performed"
            toolDescriptorsTrusted = $false
        }
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
    Write-Output $OutputPath
    exit 2
}

$base = $uri.AbsoluteUri.TrimEnd("/")
$endpointPaths = @(
    "/health",
    "/status",
    "/capabilities",
    "/tools",
    "/mcp/tools"
)

$probes = foreach ($path in $endpointPaths) {
    Invoke-McpProbe -Url ($base + $path) -TimeoutSec $TimeoutSec
}

$healthProbe = @($probes | Where-Object { $_.url -like "*/health" } | Select-Object -First 1)[0]
$toolProbes = @($probes | Where-Object { $_.url -like "*/tools" -or $_.url -like "*/mcp/tools" })
$mcpReachable = [bool]($healthProbe -and $healthProbe.ok)
$toolsEndpointVisible = [bool](@($toolProbes | Where-Object { $_.ok }).Count -gt 0)

$status = if ($mcpReachable -and $toolsEndpointVisible) {
    "ready_tools_visible"
} elseif ($mcpReachable) {
    "ready_health_only"
} else {
    "hold_unreachable"
}

$result = [ordered]@{
    generatedAt = (Get-Date).ToString("o")
    baseUrl = $base
    status = $status
    boundaryStatus = if ($isLoopback) { "local_loopback" } else { "remote_allowed_after_operator_override" }
    probes = $probes
    conclusion = [ordered]@{
        mcpReachable = $mcpReachable
        toolsEndpointVisible = $toolsEndpointVisible
        connectorUse = if ($mcpReachable) { "candidate" } else { "hold" }
        nextAction = if ($mcpReachable -and -not $toolsEndpointVisible) {
            "Health is reachable, but no generic tools endpoint was confirmed. Verify the MCP client-specific discovery path before granting write tools."
        } elseif ($mcpReachable) {
            "Review tool descriptors, confirm allowlist, then connect host clients."
        } else {
            "Start the local MCP service or correct the base URL, then rerun this verifier."
        }
    }
    safety = [ordered]@{
        loopbackOnlyDefault = $true
        remoteRequiresAllowRemote = $true
        destructiveOperations = "not_performed"
        toolDescriptorsTrusted = $false
        recommendedPolicy = "list tools, inspect descriptors, verify parameters, invoke minimum safe tool"
    }
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
$result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Output $OutputPath

if ($mcpReachable) {
    exit 0
}

exit 1
