---
author: Alex Place
created: 2026-06-06
updated: 2026-06-20
---

# Keystone OS — Script Inventory

One-stop reference for every runnable script in the repo. Skip the archaeology next time.

**Rule of thumb:** Scripts under `scripts/` are operational. Scripts under `archive/` are frozen history. Scripts under `lantern-discord/` are deployment wrappers.

---

## Core Startup (Single Command)

| Script | Purpose | How to run |
|--------|---------|-----------|
| `npm start` (in `apps/lantern-garage/`) | Starts the web server (port 4177) **and** spawns the Discord bot automatically if `DISCORD_BOT_TOKEN` + `LANTERN_DISCORD_GUILD_ID` are set in `.env.local` | `cd apps/lantern-garage && npm start` |
| `apps/lantern-garage/server.js` | Node HTTP server with modular routes. Loads `.env.local` / `.env` from repo root. | `node apps/lantern-garage/server.js` |

---

## Discord Bot

| Script | Purpose | How to run |
|--------|---------|-----------|
| `src/discord_lounge_bot/bot_v2.py` | **Main bot** — slash commands, role gating, notebook integration. Reads `.env.local` automatically. | `python src/discord_lounge_bot/bot_v2.py` |
| `src/discord_lounge_bot/bot.py` | Same as `bot_v2.py` (backward-compatible alias). | `python src/discord_lounge_bot/bot.py` |
| `scripts/Start-DiscordBotV2.ps1` | PowerShell launcher for v2 bot. Loads `.env.local`, checks deps, validates env vars. | `.\scripts\Start-DiscordBotV2.ps1` |
| `scripts/Start-DiscordBotWatchdog.ps1` | 24/7 watchdog — restarts bot if it crashes. Reads `~/.lantern/discord.env`. | `.\scripts\Start-DiscordBotWatchdog.ps1` |
| `scripts/Start-DiscordLoungeBot.ps1` | Legacy launcher for v1 bot with voice/radio flags. | `.\scripts\Start-DiscordLoungeBot.ps1` |
| `scripts/Test-DiscordBotHealth.ps1` | Deep health check — token validity, guild access, voice channel visibility. | `.\scripts\Test-DiscordBotHealth.ps1` |
| `scripts/Deploy-DiscordBotCloud.ps1` | Docker build + deploy (local Docker default). | `.\scripts\Deploy-DiscordBotCloud.ps1` |
| `scripts/Invoke-DiscordCommunityDryRun.ps1` | Dry-run against Discord server to validate channel setup. | `.\scripts\Invoke-DiscordCommunityDryRun.ps1` |
| `src/discord_lounge_bot/health_check.py` | Standalone Python health checker (env, process, Discord API latency, notebook dir). | `python src/discord_lounge_bot/health_check.py --json` |

---

## Orchestrator & Convergence

| Script | Purpose | How to run |
|--------|---------|-----------|
| `src/convergence_io_engine.py` | **Main orchestrator** — 12-phase convergence loop, health, inspect. | `python src/convergence_io_engine.py health` |
| `src/convergence_io_engine.py loop` | Runs the full 12-phase convergence check. | `python src/convergence_io_engine.py loop` |
| `src/convergence_io_engine.py converge` | AI-assisted convergence with persona. | `python src/convergence_io_engine.py converge --message "what should I work on next" --persona keystone` |

---

## Testing

| Script | Purpose | How to run |
|--------|---------|-----------|
| `tests/test_dream_journal_api.js` | 18 API tests (requires running server). | `node tests/test_dream_journal_api.js` |
| `tests/test_dream_chat_multiturns.js` | 11 multi-turn chat tests (requires running server). | `node tests/test_dream_chat_multiturns.js` |
| `tests/test_discord_bot.py` | 30 Discord bot v2 unit tests (pure + async). | `python -m pytest tests/test_discord_bot.py -q` |
| `tests/test_dashboard_ux.py` | Python dashboard UX tests. | `python -m pytest tests/test_dashboard_ux.py -q` |
| `tests/test_dreamer_integration.py` | Dreamer integration tests. | `python -m pytest tests/test_dreamer_integration.py -q` |

---

## Infrastructure & Tunnels

| Script | Purpose | How to run |
|--------|---------|-----------|
| `scripts/start-ngrok-tunnels.sh` | Launches ngrok tunnels for all services. | `bash scripts/start-ngrok-tunnels.sh` |
| `scripts/restart-headless.sh` | Docker Compose restart for headless services (CSF, proxy). | `bash scripts/restart-headless.sh` |
| `scripts/sync-agent-slots.sh` | Syncs agent slots (claude/codex/gemini/devin) with master. | `bash scripts/sync-agent-slots.sh` |
| `scripts/install-rust.sh` | Installs Rust + builds `src/csf_rust`. | `bash scripts/install-rust.sh` |

---

## Discord Deployment Wrappers (in `lantern-discord/`)

| Script | Purpose | How to run |
|--------|---------|-----------|
| `lantern-discord/RUN-DEPLOY.bat` | Double-click deploy wrapper → runs `deploy-discord-bot.ps1`. | Double-click |
| `lantern-discord/RUN-MCP-RESTART.bat` | Double-click MCP server restart wrapper. | Double-click |
| `lantern-discord/deploy-discord-bot.ps1` | Full Discord bot deployment (env validation + start). | `.\lantern-discord\deploy-discord-bot.ps1` |
| `lantern-discord/restart-mcp-and-deploy.ps1` | Restarts MCP server then deploys bot. | `.\lantern-discord\restart-mcp-and-deploy.ps1` |
| `lantern-discord/setup-discord.bat` | One-time Discord bot setup (env + deps). | Double-click |

---

## Environment Setup Helpers (in `lantern-discord/`)

| Script | Purpose |
|--------|---------|
| `lantern-discord/Set-DiscordEnvVars.ps1` | Sets Discord env vars interactively. |
| `lantern-discord/Show-DiscordEnvVars.ps1` | Displays current Discord env vars (redacts token). |
| `lantern-discord/Test-DiscordToken.ps1` | Tests token validity against Discord API. |
| `lantern-discord/Setup-DiscordBotAuth.ps1` | Guides Discord Developer Portal bot creation. |

---

## Archive Scripts (frozen, do not run)

All scripts under `archive/` are historical artifacts from previous iterations (AWS deploy, GM orchestrator, root-cleanup). They are preserved for reference but not maintained.

---

## Quick Reference

```bash
# Start everything (web + Discord bot)
cd apps/lantern-garage && npm start

# Start just the web server
cd apps/lantern-garage && node server.js

# Start just the Discord bot
python src/discord_lounge_bot/bot_v2.py
# or
.\scripts\Start-DiscordBotV2.ps1

# Run all tests
node tests/test_dream_journal_api.js
node tests/test_dream_chat_multiturns.js
python -m pytest tests/test_discord_bot.py tests/test_dashboard_ux.py -q

# Orchestrator health
python src/convergence_io_engine.py health
```

---

**Last updated:** 2026-06-05
