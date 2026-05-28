# Discord Lounge Bot

Generated: 2026-05-27.

Purpose: provide a minimal, status-only Discord bot for Lantern lounge
visibility and safe health responses.

## Safety Boundary

- Channel-allowlisted only (`LANTERN_DISCORD_CHANNEL_ID`).
- No shell/MCP command execution from Discord messages.
- No token output in logs.
- Status command only: `!lantern-status`.

## Required Environment Variables

- `DISCORD_BOT_TOKEN`
- `LANTERN_DISCORD_GUILD_ID`
- `LANTERN_DISCORD_CHANNEL_ID`
- optional: `LANTERN_STATUS_URL` (default: `http://127.0.0.1:5001/api/status`)

## Install

```powershell
pip install discord.py
```

## Health Check

Run this first:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-DiscordBotHealth.ps1
```

This script validates:

- required env vars are present;
- token identity check against Discord API succeeds;
- guild and channel IDs are reachable (when provided).

## Run

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-DiscordLoungeBot.ps1
```

By default, startup runs the health check first. To skip health check:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-DiscordLoungeBot.ps1 -NoHealthCheck
```

## Validation

Acceptance checks:

1. Bot appears online in Discord.
2. Startup status message is posted in the configured channel.
3. `!lantern-status` returns a safe status message.
4. Bot ignores other channels.
