---
author: Alex Place
created: 2026-06-06
updated: 2026-06-21
---

# Keystone OS — Quick Start

Keystone OS is an AI assistant that runs on your own computer, remembers what matters to you, and isn't locked to a single AI company. This guide gets you up and running.

> **In a hurry?** Pick the path that sounds like you:
>
> - **"I just want to try it."** → Go to **[lantern-os.net](https://lantern-os.net)**. Nothing to install, no account needed. [Jump to details ↓](#just-want-to-use-it-easiest)
> - **"I want to run my own copy."** → [Run it on your computer ↓](#run-your-own-copy)

---

## Just want to use it? (easiest)

Open **[lantern-os.net](https://lantern-os.net)** in any browser and start typing. That's genuinely it — there's nothing to download and you don't need to sign up to try the chat.

This is the right choice for most people. The rest of this guide is only if you want to run your *own* private copy on your *own* machine.

---

## Run your own copy

Running your own copy means you fully own your data and it works offline-first. You'll copy and paste a few commands into a terminal — you don't need to understand them, just run them in order.

> **A terminal** is the text window where you type commands: **PowerShell** on Windows, **Terminal** on Mac/Linux. Open it, then `cd` into the folder where you want Keystone to live.

### What you need first

| | Required? | Get it |
|---|---|---|
| **Node.js 18 or newer** | ✅ Yes — this runs the app | [nodejs.org](https://nodejs.org) (pick the "LTS" button) |
| **One AI key** | ✅ Yes — at least one (a free one is fine) | See [Step 3](#step-3-add-one-ai-key) |
| **Python 3.10+** | ⬜ Optional — only for extras (Discord bot, tools, tests) | [python.org](https://python.org) |

To check what you already have, paste these into your terminal:

```bash
node --version
python --version
```

If a version number prints, you have it. If you see "not recognized" or "command not found", install it from the links above.

### Step 1 — Get the code

```bash
git clone https://github.com/alex-place/lantern-os
cd lantern-os
```

(No `git`? Install it from [git-scm.com](https://git-scm.com), or download the project as a ZIP from the GitHub page and unzip it.)

### Step 2 — Install

```bash
# Required — installs the app
npm install --prefix apps/lantern-garage

# Optional — only if you want the Python-based extras later
python -m pip install -r requirements.txt
```

### Step 3 — Add one AI key

Keystone talks to an AI provider on your behalf. You need **one** key. It tries them in order and automatically switches to a backup if one is down, so a single key is plenty to start.

First, make your own settings file from the example:

```bash
copy .env.example .env      # Windows (PowerShell)
cp .env.example .env        # Mac / Linux
```

Then open `.env` in any text editor and paste in **one** key:

```env
ANTHROPIC_API_KEY=sk-ant-...    # Claude — best quality
GEMINI_API_KEY=AIza...          # Google Gemini — has a free tier, easiest to start
OPENAI_API_KEY=sk-...           # ChatGPT / GPT-4o
```

| Provider | Where to get a key | Cost to start |
|---|---|---|
| Google (Gemini) | [aistudio.google.com](https://aistudio.google.com/app/apikey) | **Free tier** — recommended if you're new |
| Anthropic (Claude) | [console.anthropic.com](https://console.anthropic.com) | Paid |
| OpenAI (ChatGPT) | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | Paid |

> **Keep your key private.** It's like a password for your AI account. Don't share your `.env` file or post the key anywhere. `.env` is already ignored by git so it won't get committed.

### Step 4 — Start it

```bash
npm run dev --prefix apps/lantern-garage
```

Now open **[http://127.0.0.1:4177](http://127.0.0.1:4177)** in your browser.

You'll land on the Keystone home page. Click **Chat** and type anything to start a conversation. 🎉

To stop the server, go back to the terminal and press **Ctrl + C**.

---

## What's where

Once it's running on `http://127.0.0.1:4177`:

| Page | Address | What it is |
|---|---|---|
| **Home** | `/` | The landing page with links to everything |
| **Chat** | `/dream-chat.html` | Talk to Keystone — your main way in |
| **Help** | `/knowledgecenter.html` | Guides, docs, and your saved PDFs |
| **Trader** | `/trader-dashboard.html` | Markets & prediction-market terminal *(needs an account)* |
| **Create** | `/create.html` | Image and content tools *(needs an account)* |
| **Explore** | `/explore.html` | Games, the flourishing dashboard, and more |

---

## Optional extras

You can skip all of this — the chat works without any of it. Come back when you're curious.

### Run two copies at once (for tinkering)

Handy if you want to experiment without breaking your working copy: one stable copy on port 4177, and a second "playground" copy on port 4178. If Python is installed, the MCP server also starts automatically on port 8771, shared by both web servers.

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/Start-DualServers.ps1
```

- **Port 4177** — your stable copy (the `master` branch)
- **Port 4178** — your playground (your current branch, auto-reloads as you change files)
- **Port 8771** — MCP server (shared, tools for Claude Code) *(requires Python)*

On startup this also installs the **monoworkstream git hooks** (contributors only) — the
dynamic per-lane PR gate: `alex/`, `kriskin/`, `mookman11/`, or any `<name>/` branch each
get one concurrent PR lane, plus the slop + change-record checks. Nothing to do manually.

**One idempotent command.** `Start-DualServers.ps1` is safe to re-run any time — it's the
single supported way to bring the servers up, and each step self-heals:

1. **Prereqs** — verifies Node and both worktrees exist (exits early with instructions if not).
2. **Dependency preflight** — resolve-probes each worktree's `node_modules` and runs
   `npm install` **only if** it's missing or drifted from `package.json`. This catches the
   most common silent failure: a drifted `node_modules` makes the server throw at `require()`
   and the port then answers with nothing (HTTP 000). A healthy tree is left untouched, and a
   lockfile older than `package.json` is flagged as a warning.
3. **Env hydration** — loads API keys from the Machine/User environment (not a committed `.env`).
4. **Clean slate** — tree-kills the current port owners *and* reaps leaked zombie servers, so a
   re-run never stacks duplicates or contends for the shared child-service ports.
5. **Launch + health check** — starts :4177 / :4178 (+ MCP :8771 if Python is present) and polls
   `/api/version` until each answers.
6. **Watchdog** — launches `Watch-DualServers.ps1` detached so a server that later crashes is
   auto-restarted instead of staying dead until someone notices (`-NoWatchdog` to skip).

Because every step is a check-then-act, running the command again is the correct fix for almost
any "a server is down / acting weird" situation — it converges the running state back to intended.

*(If you happen to have `make` installed — it isn't on Windows by default — `make quickstart` does the same thing.)*

### Start automatically when your PC turns on (Windows)

```powershell
# Run once, in a PowerShell window opened "as Administrator"
.\scripts\Start-Lantern.ps1 -RegisterAutostart
```

After this your computer starts Keystone on its own every time it boots, and restarts it if it ever crashes. Admin is only needed this one time to register the task.

To undo it later:

```powershell
.\scripts\Start-Lantern.ps1 -UnregisterAutostart
```

Logs are saved to `logs\lantern-autostart.log`.

### Voice (text-to-speech)

- **Browser voice** works out of the box in Chrome and Edge — no setup.
- **ElevenLabs** (more natural voices): add `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` to `.env`.

### Discord bot

Add these to `.env` and the bot starts with the server:

```env
DISCORD_BOT_TOKEN=your_bot_token
LANTERN_DISCORD_GUILD_ID=your_server_id
```

Voice playback needs ffmpeg: `winget install Gyan.FFmpeg`.

### Tools for AI agents (MCP)

The MCP server starts automatically when you run the dual-boot launcher (if Python is installed):

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/Start-DualServers.ps1
```

This launches:
- **Port 8771** — MCP server (shared by both web servers, tools for Claude Code)

If you want to run the MCP server standalone on port 8771:

```bash
python src/mcp_server/server.py
```

The MCP server lets coding assistants like Claude Code call Keystone's tools — you only need it if you're using the Claude Code IDE extension or web app with this project.

### Share it on the internet (advanced)

You can expose your local Keystone to the public web with a Cloudflare tunnel. See [`docs/CLOUDFLARE-TUNNEL-DEPLOYMENT.md`](docs/CLOUDFLARE-TUNNEL-DEPLOYMENT.md).

> ⚠️ **Read this first.** Putting Keystone on the public internet means **anyone with the link can reach it**, not just you. Only do this if you understand the risk, keep your keys safe, and don't expose admin/trading features to the public. If you're not sure, don't — the local `127.0.0.1` address is private to your machine and is the safe default.

---

## If something goes wrong

| Problem | Fix |
|---|---|
| **"Port 4177 already in use"** | Keystone (or something else) is already running on it. On Windows, find it in **Task Manager** and end it; on Mac/Linux run `lsof -i :4177` then stop that process. |
| **No replies in chat** | Open `.env` and double-check at least one AI key is filled in and correct (no extra spaces, no quotes). |
| **It won't start** | Look at `logs\lantern-autostart.log` for the error message. |
| **Voice doesn't work** | Use Chrome or Edge; other browsers may not support browser voice. |
| **Discord bot won't start** | Make sure **both** `DISCORD_BOT_TOKEN` and `LANTERN_DISCORD_GUILD_ID` are set in `.env`. |
| **Tests fail** | The API tests need the server already running in another window first. |

Still stuck? Open an issue on [GitHub](https://github.com/alex-place/lantern-os/issues) and paste the error you saw.

---

## Running tests (for contributors)

```bash
# Python unit tests
python -m pytest tests/ -q --tb=short

# Node API tests — start the server first, then in a second terminal:
npm run test:api --prefix apps/lantern-garage
```

---

## Go deeper

- **[Help & Knowledge Center](https://lantern-os.net/knowledgecenter.html)** — friendly guides and every doc in one place
- **[PROVIDERS.md](PROVIDERS.md)** — all the AI providers and how to configure them
- **[AGENTS.md](AGENTS.md)** — how the AI agent workflow and contribution lanes work
- **[SECURITY.md](SECURITY.md)** — the security model and how to report a problem
- **[docs/CONVERGENCE-LOOP.md](docs/CONVERGENCE-LOOP.md)** — how Keystone reasons under the hood
