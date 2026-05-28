param(
    [string]$TokenEnv = "DISCORD_BOT_TOKEN",
    [string]$GuildEnv = "LANTERN_DISCORD_GUILD_ID",
    [string]$ChannelEnv = "LANTERN_DISCORD_CHANNEL_ID",
    [int]$TimeoutSec = 8,
    [switch]$Json
)

$ErrorActionPreference = "Stop"

function New-Check {
    param(
        [string]$Name,
        [string]$Status,
        [string]$Message
    )

    [ordered]@{
        name = $Name
        status = $Status
        message = $Message
    }
}

function Invoke-DiscordGet {
    param(
        [string]$Path,
        [string]$Token,
        [int]$Timeout
    )

    $uri = "https://discord.com/api/v10$Path"
    $headers = @{
        Authorization = "Bot $Token"
    }

    try {
        $response = Invoke-WebRequest -Uri $uri -Headers $headers -UseBasicParsing -TimeoutSec $Timeout -Method Get
        return [ordered]@{
            ok = $true
            code = [int]$response.StatusCode
            body = $response.Content
        }
    } catch {
        $statusCode = $null
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }
        return [ordered]@{
            ok = $false
            code = $statusCode
            body = $_.Exception.Message
        }
    }
}

$token = [Environment]::GetEnvironmentVariable($TokenEnv)
$guildId = [Environment]::GetEnvironmentVariable($GuildEnv)
$channelId = [Environment]::GetEnvironmentVariable($ChannelEnv)

$checks = New-Object System.Collections.Generic.List[object]

if ([string]::IsNullOrWhiteSpace($token)) {
    $checks.Add((New-Check -Name "token_env" -Status "fail" -Message "Missing env var '$TokenEnv'.")) | Out-Null
} else {
    $checks.Add((New-Check -Name "token_env" -Status "pass" -Message "Token env var exists (value not printed).")) | Out-Null
}

if ([string]::IsNullOrWhiteSpace($guildId)) {
    $checks.Add((New-Check -Name "guild_env" -Status "warn" -Message "Missing env var '$GuildEnv'; guild check skipped.")) | Out-Null
} else {
    $checks.Add((New-Check -Name "guild_env" -Status "pass" -Message "Guild env var exists.")) | Out-Null
}

if ([string]::IsNullOrWhiteSpace($channelId)) {
    $checks.Add((New-Check -Name "channel_env" -Status "warn" -Message "Missing env var '$ChannelEnv'; channel check skipped.")) | Out-Null
} else {
    $checks.Add((New-Check -Name "channel_env" -Status "pass" -Message "Channel env var exists.")) | Out-Null
}

if (-not [string]::IsNullOrWhiteSpace($token)) {
    $self = Invoke-DiscordGet -Path "/users/@me" -Token $token -Timeout $TimeoutSec
    if ($self.ok) {
        $checks.Add((New-Check -Name "token_api_identity" -Status "pass" -Message "Discord API identity check passed.")) | Out-Null
    } else {
        $code = if ($null -eq $self.code) { "n/a" } else { [string]$self.code }
        $checks.Add((New-Check -Name "token_api_identity" -Status "fail" -Message "Discord API identity check failed (HTTP $code).")) | Out-Null
    }

    if (-not [string]::IsNullOrWhiteSpace($guildId)) {
        $guild = Invoke-DiscordGet -Path "/guilds/$guildId" -Token $token -Timeout $TimeoutSec
        if ($guild.ok) {
            $checks.Add((New-Check -Name "guild_access" -Status "pass" -Message "Bot can access guild id '$guildId'.")) | Out-Null
        } else {
            $code = if ($null -eq $guild.code) { "n/a" } else { [string]$guild.code }
            $checks.Add((New-Check -Name "guild_access" -Status "fail" -Message "Guild access failed for id '$guildId' (HTTP $code).")) | Out-Null
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($channelId)) {
        $channel = Invoke-DiscordGet -Path "/channels/$channelId" -Token $token -Timeout $TimeoutSec
        if ($channel.ok) {
            $checks.Add((New-Check -Name "channel_access" -Status "pass" -Message "Bot can access channel id '$channelId'.")) | Out-Null
        } else {
            $code = if ($null -eq $channel.code) { "n/a" } else { [string]$channel.code }
            $checks.Add((New-Check -Name "channel_access" -Status "fail" -Message "Channel access failed for id '$channelId' (HTTP $code).")) | Out-Null
        }
    }
}

$passCount = @($checks | Where-Object { $_.status -eq "pass" }).Count
$warnCount = @($checks | Where-Object { $_.status -eq "warn" }).Count
$failCount = @($checks | Where-Object { $_.status -eq "fail" }).Count

$result = [ordered]@{
    generatedAt = (Get-Date).ToString("o")
    checks = $checks
    summary = [ordered]@{
        pass = $passCount
        warn = $warnCount
        fail = $failCount
    }
    nextAction = if ($failCount -gt 0) {
        "Fix failing checks, then rerun this script before starting the bot runtime."
    } else {
        "Health checks passed. Safe to run Start-DiscordLoungeBot.ps1."
    }
}

if ($Json) {
    $result | ConvertTo-Json -Depth 6
} else {
    Write-Output "Discord Bot Health Check"
    Write-Output "Pass: $passCount | Warn: $warnCount | Fail: $failCount"
    foreach ($check in $checks) {
        Write-Output ("[{0}] {1} - {2}" -f $check.status.ToUpper(), $check.name, $check.message)
    }
}

if ($failCount -gt 0) {
    exit 1
}

exit 0
