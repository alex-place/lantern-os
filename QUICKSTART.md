# Lantern OS — Quick Start

Get the app running in 5 minutes.

---

## The Fast Path

If you already have Node 18+ and Python 3.10+:

```powershell
# 1. Install dependencies
npm install --prefix apps/lantern-garage

# 2. Copy the env file and add at least one AI key
copy .env.example .env

# 3. Start the server
npm run dev --prefix apps/lantern-garage
```

Open **http://127.0.0.1:4177** — that's it.

---

## Step 1 — Requirements

You need:

- **Node.js v18+** — [nodejs.org](https://nodejs.org)
- **Python 3.10+** — [python.org](https://python.org)
- **At least one AI provider key** (free tier is fine — see Step 3)

Check what you have:

```bash
node --version
python --version
```

---

## Step 2 — Install

```bash
# Clone the repo (skip if you already have it)
git clone https://github.com/alex-place/lantern-os
cd lantern-os

# Install Node dependencies
npm install --prefix apps/lantern-garage

# Install Python dependencies
python -m pip install -r requirements.txt
```

---

## Step 3 — Add Your AI Keys

Copy the example env file:

```bash
copy .env.example .env        # Windows
cp .env.example .env          # Mac / Linux
```

Open `.env` and fill in at least one key:

```env
ANTHROPIC_API_KEY=sk-ant-...    # Claude (recommended)
OPENAI_API_KEY=sk-...           # GPT-4o
GEMINI_API_KEY=AIza...          # Gemini (free tier, generous quota)
```

You only need **one** key to get started. The app tries providers in order and falls back automatically if one fails.

| Provider | Where to get a key |
|---|---|
| Anthropic (Claude) | [console.anthropic.com](https://console.anthropic.com) |
| OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Google (Gemini) | [aistudio.google.com](https://aistudio.google.com) |

---

## Step 4 — Start the Server

```bash
npm run dev --prefix apps/lantern-garage
```

Open **http://127.0.0.1:4177** in your browser.

You should see the Dream Journal — type anything to start a conversation.

---

## Dual-Boot Mode (Recommended for Development)

Run two servers at once, each from its **own dedicated git worktree** so the
autonomous automation that churns the main checkout (`git checkout` /
`git reset --hard origin/master` between turns) never yanks code or env out from
under a running server. See [docs/DEV-SERVER-WORKTREE.md](docs/DEV-SERVER-WORKTREE.md).

- **Port 4177** — stable / public, served from `C:\dev\lantern-os-stable` (fronted by the Cloudflare tunnel)
- **Port 4178** — dev / local, served from `C:\dev\lantern-os-dev` via `server-dev.js` (loopback-only, auth-bypassed)

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/Start-DualServers.ps1
```

`make quickstart` runs the same script — but only if GNU `make` is installed. On
a bare Windows box, call the `pwsh` command above directly.

The launcher:
- hydrates your persistent **Machine/User** environment (API keys, Discord /
  Kalshi / Patreon credentials) into both servers — keys are **not** kept in a
  committed `.env`;
- stops any existing `:4177` / `:4178` instances and their child services, then
  relaunches from the two worktrees;
- leaves the Cloudflare tunnel running (it reconnects to `:4177`).

This way you can break things on 4178 without touching the public version on 4177.

> **Heads-up:** both instances run their own Discord bot and Kalshi collector and
> both try to bind the shared MCP port `8771` — only one wins; the other logs a
> bind error and keeps serving HTTP. That's expected in dual-boot.

> First-run worktree setup:
> ```powershell
> git worktree add C:\dev\lantern-os-stable stable-server
> git worktree add C:\dev\lantern-os-dev    dev-server
> ```

---

## Auto-Start on Boot (Windows)

Register Lantern OS as a Windows startup task so it starts automatically every time you reboot:

```powershell
# Run once as Administrator
.\scripts\Start-Lantern.ps1 -RegisterAutostart
```

After this, you don't need to do anything — the computer starts the server on boot, and restarts it automatically if it crashes.

To remove the autostart:

```powershell
.\scripts\Start-Lantern.ps1 -UnregisterAutostart
```

Logs are written to `logs\lantern-autostart.log`.

---

## What's Running at Port 4177

| Page | URL | What it is |
|---|---|---|
| Dream Journal | `/` | Freeform AI chat with agent personas |
| Trader Dashboard | `/trader-dashboard.html` | Kalshi prediction markets terminal |
| Creator | `/create.html` | Image and content creation tools |
| Explore | `/explore.html` | Three Doors game, flourishing dashboard |
| Knowledge Center | `/knowledgecenter.html` | Docs, guides, and your research PDFs |
| Crypto Dashboard | `/crypto-dashboard.html` | BTC / ETH / SOL prices and news |

---

## Optional Features

### Discord Bot

Add to `.env`:

```env
DISCORD_BOT_TOKEN=your_bot_token
LANTERN_DISCORD_GUILD_ID=your_server_id
```

The bot starts automatically with the server — no extra command needed.
Includes the Sinatra Lounge voice player. Requires ffmpeg for audio:

```powershell
winget install Gyan.FFmpeg
```

### Voice / TTS

- **Browser TTS** works out of the box in Chrome and Edge — no setup needed.
- **ElevenLabs** (higher quality): add `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` to `.env`.

### MCP Server (for AI agents / tool access)

```bash
python src/mcp_server/server.py
```

Runs on port 8771. Used by Claude Code and other AI agents to call Lantern tools.

### Public Access via Cloudflare Tunnel

One-time setup:

```bash
cloudflared tunnel login
cloudflared tunnel create lantern-os
```

Then the tunnel starts automatically with `npm start`. Your app is accessible at `https://lantern-os.net`.

See [`docs/CLOUDFLARE-TUNNEL-DEPLOYMENT.md`](docs/CLOUDFLARE-TUNNEL-DEPLOYMENT.md) for the full setup guide.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Port 4177 already in use | Kill the existing process: `lsof -i :4177` (Mac/Linux) or check Task Manager (Windows) |
| No AI responses | Check that at least one key in `.env` is valid |
| Server crashes on startup | Check `logs\lantern-autostart.log` for the error |
| TTS not working | Make sure you're on Chrome or Edge; check browser console for errors |
| Discord bot not starting | Confirm both `DISCORD_BOT_TOKEN` and `LANTERN_DISCORD_GUILD_ID` are set in `.env` |
| Tests fail | The API tests require the server to already be running |

---

## Running Tests

```bash
# Python unit tests
python -m pytest tests/ -q --tb=short

# Node API tests (server must be running)
npm run test:api --prefix apps/lantern-garage
```

---

## Next Steps

- [AGENTS.md](AGENTS.md) — how the AI agent workflow and PR lanes work
- [PROVIDERS.md](PROVIDERS.md) — full list of supported AI providers and configuration
- [docs/CONVERGENCE-LOOP.md](docs/CONVERGENCE-LOOP.md) — the 12-phase reasoning loop
- [SECURITY.md](SECURITY.md) — security model and responsible disclosure
