[CmdletBinding()]
param(
    [string]$Url = "",
    [string[]]$CandidateUrls = @(
        "http://127.0.0.1:8787/chat",
        "http://127.0.0.1:8788/chat",
        "http://127.0.0.1:8787/",
        "http://127.0.0.1:8788/",
        "http://127.0.0.1:4177/"
    ),
    [int]$TimeoutSec = 4,
    [switch]$AllowVerifiedRemote
)

$ErrorActionPreference = "Stop"

function Test-LocalUrl {
    param([string]$Value)
    try {
        $uri = [System.Uri]$Value
        return $uri.Host -in @("127.0.0.1", "localhost", "::1")
    }
    catch {
        return $false
    }
}

function Test-ChatHtml {
    param([string]$Content)
    if ([string]::IsNullOrWhiteSpace($Content)) { return $false }
    return (
        $Content -match "Lantern Cloud Chat" -or
        $Content -match "Message Lantern OS" -or
        $Content -match "conversationForm" -or
        $Content -match "chatPanel"
    )
}

$targets = if ([string]::IsNullOrWhiteSpace($Url)) { $CandidateUrls } else { @($Url) }
$results = @()

foreach ($target in $targets) {
    $isLocal = Test-LocalUrl $target
    if (-not $isLocal -and -not $AllowVerifiedRemote) {
        $results += [pscustomobject]@{
            url = $target
            ok = $false
            statusCode = $null
            local = $false
            reason = "remote_url_requires_AllowVerifiedRemote"
        }
        continue
    }

    try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec $TimeoutSec -Uri $target
        $hasChat = Test-ChatHtml $response.Content
        $results += [pscustomobject]@{
            url = $target
            ok = ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 400 -and $hasChat)
            statusCode = [int]$response.StatusCode
            local = $isLocal
            reason = if ($hasChat) { "chat_surface_verified" } else { "responded_but_chat_markers_missing" }
        }
    }
    catch {
        $statusCode = $null
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }
        $results += [pscustomobject]@{
            url = $target
            ok = $false
            statusCode = $statusCode
            local = $isLocal
            reason = $_.Exception.Message
        }
    }
}

$selected = $results | Where-Object { $_.ok } | Select-Object -First 1
[pscustomobject]@{
    ok = [bool]$selected
    selectedUrl = if ($selected) { $selected.url } else { $null }
    candidateCount = $targets.Count
    results = $results
}
