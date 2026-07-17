# Lantern OS Discord Bots

Two runnable bots live in this directory (both can run simultaneously):

- **v2 (current)** — `bot_v2.py`: slash commands, role-tier gating,
  Stripe-linked subscriptions.
- **v1 (legacy lounge bot)** — `bot.py`: prefix commands, single-channel
  allowlist, P0-gated voice/radio.

| Feature | v1 | v2 |
|---|---|---|
| Commands | `!dream`, `!note` (prefix) | `/dream`, `/note` (slash) |
| Access control | Single channel allowlist | Role-tier gating |
| Subscriptions | None | Stripe-linked role tiers |
| Notebook | Local JSONL | Local JSONL (same) |
| Voice/Radio | Held behind flags | Held behind flags |

## v2 (current)

### Quick start

```powershell
$env:DISCORD_BOT_TOKEN = "your_bot_token"
$env:LANTERN_DISCORD_GUILD_ID = "your_guild_id"
pip install -r src\discord_lounge_bot\requirements_v2.txt
python src\discord_lounge_bot\bot_v2.py
# Or: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-DiscordBotV2.ps1
```

### Commands by tier

- **Public (free):** `/status`, `/help`, `/subscribe` (Stripe checkout links)
- **Supporter ($20/mo):** `/dream`, `/note`, `/wish`, `/recall`, `/mirror`,
  `/wallet`, `/odds`, `/talk <character> <message>`
- **Pilot ($200/mo):** `/converge`, `/rag-status`, `/queue`, `/place`,
  `/character`, `/symbol`
- **Founder (operator):** `/dispatch`, `/controls`, `/boot-check`, `/release-gate`

### Role setup

| Role | Color | Purpose |
|---|---|---|
| `Supporter` | Teal (#0d9488) | $20/month subscribers |
| `Pilot` | Blue (#2563eb) | $200/month subscribers |
| `Founder` | Amber (#f59e0b) | Operator access |

Role names are checked case-insensitively.

### Environment variables (v2)

| Variable | Required | Default |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Yes | — |
| `LANTERN_DISCORD_GUILD_ID` | Yes | — |
| `LANTERN_STATUS_URL` | No | `http://127.0.0.1:4177/api/status` |
| `SUBSCRIBER_DATA_PATH` | No | `data/discord/subscribers.json` |

### Deployment

Docker: `docker build -f ops/Dockerfile-discord-bot-v2 -t lantern-discord-bot-v2 .`
then run with `DISCORD_BOT_TOKEN` + `LANTERN_DISCORD_GUILD_ID`. For Render/Fly.io
use `ops/Dockerfile-discord-bot-v2` as the build context and set env vars in the
platform dashboard.

## v1 (legacy lounge bot)

Bounded bot for Lantern lounge visibility, safe health responses, and P0-gated
voice/radio access.

### Environment variables (v1)

- `DISCORD_BOT_TOKEN`, `LANTERN_DISCORD_GUILD_ID`, `LANTERN_DISCORD_CHANNEL_ID`
- `LANTERN_VOICE_CHANNEL` or `LANTERN_VOICE_CHANNEL_ID`
- optional: `LANTERN_STATUS_URL` (v1 default: `http://127.0.0.1:5001/api/status`),
  `LANTERN_DISCORD_ENABLE_VOICE=true`, `LANTERN_DISCORD_ENABLE_RADIO=true`,
  `LANTERN_RADIO_URL`

### Install / health check / run

```powershell
pip install -r .\src\discord_lounge_bot\requirements.txt
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-DiscordBotHealth.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-DiscordLoungeBot.ps1
# skip health check: ... Start-DiscordLoungeBot.ps1 -NoHealthCheck
```

The health check validates env vars, token identity, guild/channel reachability,
voice deps (`discord.py`, `PyNaCl`, `ffmpeg`), and Lounge-channel visibility.
P0 rule: do not start the bot, add it to Lounge, or start radio until the health
check passes.

Commands: `!lantern-status`, `!lantern-voice-check`, `!lantern-join-lounge`,
`!lantern-leave-lounge`, `!lantern-radio`.

Acceptance checks: bot online; startup status posted in the configured channel;
`!lantern-status` safe; `!lantern-voice-check` shows the Lounge gate;
`!lantern-join-lounge` only after voice explicitly enabled; other channels
ignored.

### Frank / Rhythm evidence (historical)

The old Frank Sinatra/Rhythm lane lives in the orchestrator repo
(`gm-agent-orchestrator`: `LANTERN-MASTER-INDEX.md`, `FOUNDRY-PLAN.md`,
`lantern-tutorial-frank.html`). This bot does not auto-stream that material; do
not auto-stream any source into Lounge without an operator rights check.

## Shared safety boundary

- No shell/MCP command execution from Discord messages.
- No token output in logs; notebook entries are private per-user.
- Voice join off by default; radio playback requires operator approval and a
  rights-checked `LANTERN_RADIO_URL`.

## Test server

Live test target: **https://discord.gg/xmsbPjMGm** — use for voice, radio, and
notebook command validation.

## License

Same as Lantern OS. Not equity, not investment, not securities.
