---
author: Alex Place
created: 2026-06-05
updated: 2026-06-24
---

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ Required Reading (All Agents)

**READ FIRST (every session and before each commit):**

1. **[QUICKSTART.md](QUICKSTART.md)** — Dual-boot system (port 4177 stable + 4178 dev), autostart setup
2. **[AGENTS.md](AGENTS.md)** — Monoworkstream rules, git workflow, agent capabilities
3. **[PROVIDERS.md](PROVIDERS.md)** — All 10 AI providers, configuration, fallback chain, environment variables
4. **[SECURITY.md](SECURITY.md)** — Critical vulnerabilities, input validation, security best practices
5. **[SKILLS.md](SKILLS.md)** — Available capabilities, persona routing, provider chain
6. **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — Canonical current-state architectural writeup (entrypoints, data flow, subsystem map)
7. **[docs/adr/README.md](docs/adr/README.md)** — Architecture Decision Records index (*why* the system is the way it is)

**Automatic Enforcement:**
- Git `post-checkout` hook: reminds you to read docs after branch changes
- Git `prepare-commit-msg` hook: injects checklist before commits
- `make quickstart`: prints required reading before starting servers

These documents are non-negotiable for safe, compliant contributions.

## ⚠️ Architectural Convergence Constraint — READ FIRST

**START HERE:** [!CONVERGANCE Σ₀ BRIEFING](docs/CONVERGANCE-SIGMA0-BRIEFING.md) — immutable North Star.

**THEN:** [Research Canon](docs/RESEARCH-CANON.md) — living references organized by Convergence 12 component.

**THEN:** [Convergence Core Mapping](docs/convergence-core-mapping.md) — how existing code aligns with architecture.

**BENCHMARKS:** [docs/BENCHMARKS.md](docs/BENCHMARKS.md) — the maintained registry of every *external* mark we run (HumanEval, SWE-bench, LongMemEval, …). Update it in the same PR whenever a harness or measured result changes.

---

**THE ENTIRE PROJECT IS ONE LOOP:**

```
Observe → Remember → Reason → Act → Verify → Converge
```

Every feature must strengthen ONE stage of this loop. Nothing else.

**FOUR CORE OBJECTS (everything else is implementation):**
- **Memory** — append-only JSONL logs + CSF archive
- **Task** — goal + constraints + status
- **Tool** — name + input + output + success
- **Convergence Record** — hypothesis + evidence + result + confidence

**FORBIDDEN:**
- Separate dream engine (use reasoning strategy: high exploration + mandatory verification)
- Multiple memory systems (one JSONL append + one CSF archive)
- Independent agent ecosystems (all agents use Convergence Core)
- Digital twin / BCI / mind-uploading concepts (persistence ≠ simulation)
- Top-level subsystems that don't improve the loop

**MODELS ARE INTERCHANGEABLE.**
The Convergence Core never assumes a specific LLM. All models plug in as replacements.

**PERSISTENT LEARNING, NOT WEIGHT MODIFICATION.**
Store experience (memories + convergence records). Improve via retrieval and reasoning, not retraining.

**EXTERNAL REALITY RULE** (non-negotiable):
```
Nothing is accepted without evidence.
Every important claim must have: [claim, evidence, confidence, source]
```

**Feature Gate:**
| What | Allowed? | Reason |
|-----|----------|--------|
| Better memory retrieval | ✓ Yes | Improves Remember stage |
| Better planning / routing | ✓ Yes | Improves Reason stage |
| Better verification / grounding | ✓ Yes | Improves Verify stage |
| Better tool execution / observability | ✓ Yes | Improves Act stage |
| Better convergence metrics | ✓ Yes | Improves Converge stage |
| Separate dream engine | ✗ No | Architectural sprawl |
| Multiple memory systems | ✗ No | Coordination nightmare |
| Swarm agents / ecosystems | ✗ No | Anti-convergence |
| Digital personality simulation | ✗ No | Scope creep |

Reject architectural sprawl. Prefer extension over addition. Maintain a single Convergence Core.

## Project Overview

Keystone OS is a **persistent local-first reasoning system** built by a solo developer (Alex Place). The primary user interface is **dream-chat.html** — a freeform chat backed by a Convergence Core that remembers, reasons, acts, and verifies.

## Quickstart (Read QUICKSTART.md First)

**Dual-Boot System** (recommended for development):
```bash
make quickstart
# Starts TWO servers simultaneously:
# - Port 4177: Stable release (master branch)
# - Port 4178: Development (current branch, hot-reload)
# Opens http://127.0.0.1:4177 in Chrome
```

**Single Server** (development only):
```bash
npm run dev --prefix apps/lantern-garage
# Starts only port 4177 with hot-reload (your current branch)
```

**Autostart** (Windows PC reboot auto-start):
```bash
# See QUICKSTART.md section 1 for complete setup
```

## Commands

### Python tests

```bash
# Install dependencies
python -m pip install -r requirements.txt

# Run all tests. The anti-entropy + audit-chain suites pass and are no longer
# excluded; the discord suites self-skip via importorskip when discord/dpytest are
# absent, so the full run is clean without --ignore flags (#862).
python -m pytest tests/ -q --tb=short

# Run a single test file
python -m pytest tests/test_dream_journal.py -q --tb=short

# Run a specific test function
python -m pytest tests/test_dream_journal.py::test_function_name -q
```

### Node.js (lantern-garage)

```bash
# Start main web server (port 4177)
node apps/lantern-garage/server.js
# or
npm start --prefix apps/lantern-garage

# Syntax-check JS files
make check-node        # runs node --check on server.js + cloud-server.js

# Node API/chat tests (server must be running)
npm run test:api --prefix apps/lantern-garage
npm run test:chat --prefix apps/lantern-garage
npm run test:ui --prefix apps/lantern-garage   # requires Playwright
```

### Python services

```bash
# MCP server (port 8771)
python src/mcp_server/server.py

# GPT Web API (port 3000) — separate Node service
node services/gpt-web-api/server.js

# Discord bot
python src/discord_lounge_bot/bot.py
```

### Docker (Dream Journal stack)

```bash
make build-dream
make up-dream
make down-dream
make logs-dream
```

## Architecture

### Core data flow

The **Lantern Garage server** (`apps/lantern-garage/server.js`) is the single entrypoint. It:
- Serves all static HTML/JS from `apps/lantern-garage/public/`
- Routes REST API calls (`/api/*`) using plain `if` blocks (no framework)
- Streams LLM replies via SSE at `/api/dream/stream`
- Reads/writes persistent state as `.json` and `.jsonl` files under `data/`

Business logic is split into `apps/lantern-garage/lib/`:
| Module | Responsibility |
|--------|----------------|
| `dream-chat.js` | Agent persona selection + LLM call routing (Anthropic/OpenAI/Gemini) |
| `stream-chat.js` | SSE streaming handler |
| `dreamer-store.js` | Per-user dream notebook JSONL persistence |
| `conversation-store.js` | Conversation log append/read |
| `rag-house.js` | Flat RAG document house builder |
| `status.js` | System/readiness/mining-lab status aggregation |
| `file-queue.js` | Async JSONL append queue (avoids concurrent write corruption) |

### Dream Journal agents

The chat persona is a single grounded agent, **`keystone`**, defined in `apps/lantern-garage/lib/dream-chat.js` and loaded from `data/contexts/personas.json`. `selectAgent()` scores inbound messages by keyword match and defaults to `keystone`; the persona's `systemPrompt` is injected into the LLM call. (The earlier fictional RP personas — `lantern`, `blinkbug`, `waterfall`, `xenon`, `founder` — were removed in #1664. The string `lantern` persists *only* as the internal assistant message-role used by conversation/CSF storage, not as a selectable persona.)

**Only these five skills have real implementations:** `dream_journal`, `lucid_dreaming`, `archive_curator`, `voice_curator`, `job_application`. All other `skills/*/SKILL.md` entries are design contracts only — do not claim they are live.

### MCP server

`src/mcp_server/server.py` is a FastAPI + SSE service exposing MCP tools (`queue_status`, `task_intake`, `dispatch_work`, `boot_check`, `list_skills`, `get_status`). Only register tools here that have real implementations.

### Trading System (Sprint 1.5)

The Kalshi trading terminal (`apps/lantern-garage/public/kalshi-terminal.html`) is a swipe-deck UI backed by 60+ REST endpoints in `apps/lantern-garage/routes/trading.js`. Full endpoint reference: **[docs/trading-api-reference.md](docs/trading-api-reference.md)**.

Key runtime components:
| Module | Responsibility |
|--------|----------------|
| `kalshi-api.js` | Kalshi REST client (auth, order placement, market data) |
| `kalshi-collector.js` | 6s polling loop; 429 backoff with `Retry-After`; exposes `getStatus()` |
| `kalshi-suggest.js` | Tight-band entry suggestion engine |
| `convergence-router.js` | Deterministic routing cache — 120 Keystone routes, >70% hit rate |
| `trading-history-logger.js` | Trade/signal history JSONL persistence |

Live data flow: `kalshi-collector` → server snapshot → UI polls `/api/trading/kalshi/decisive-deck` (no UI-direct Kalshi calls).

CIO accuracy tracking: `python experiments/kalshi_tightband_analysis.py` appends each run to `data/kalshi/cio-accuracy-log.jsonl` (date, n_resolved, accuracy, avg_lead_time).

### CSF (Convergence-Fitted Searchable Format)

CSF is **one** lossless, zstd-backed binary archive. Use the package root:
`import csf; csf.pack(...)` / `csf.unpack(...)` / `csf.read_file(...)` for
file/blob archives (per-file SHA-256 + footer integrity), or `csf.compress(...)`
/ `csf.decompress(...)` for single byte strings. The engine is
[`src/csf/csf_pack.py`](src/csf/csf_pack.py); the public facade is
[`src/csf/__init__.py`](src/csf/__init__.py). Full spec:
**[docs/CSF-FORMAT-SPECIFICATION.md](docs/CSF-FORMAT-SPECIFICATION.md)**.

The v2 consolidation (2026-06) **deleted** the duplicate/legacy *writers*
(segmented `CsfArchive` v1 + its `csf_compress/decompress/merge/search` CLIs, the
v0.3 `csf_file` writer, and the lossy v0.7 symbolic *text* compressors) so they
can't be called by mistake. Existing on-disk archives still open **read-only**
via [`src/csf/legacy.py`](src/csf/legacy.py). The `src/csf/v07/` lattice
primitives (the Tesseract "storage face" — `quantum_dust`, `qutrit_delta`) and
the Status-Cube container are kept. See `caad/README.md` for the CADD layer built
on top of CSF.

### Cloud vs local

- **Local:** server binds to `127.0.0.1:4177`
- **Cloud (Railway):** `apps/lantern-garage/cloud-server.js` is the entrypoint; binds to `0.0.0.0` when `PORT` env var is set. Railway auto-deploys from `master`.
- **Static UI:** deployed from `gh-pages` branch via GitHub Actions; source in `apps/lantern-garage/public/`.

### Configuration

Copy `.env.example` to `.env` at repo root. Key variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DISCORD_TOKEN`. The server loads `.env` from repo root at startup.

**Patreon OAuth** (optional — gates entire site behind login):
- `PATREON_CLIENT_ID`, `PATREON_CLIENT_SECRET`, `PATREON_CAMPAIGN_ID`, `PATREON_REDIRECT_URI`, `SESSION_SECRET`
- See **[PATREON-OAUTH.md](docs/PATREON-OAUTH.md)** for full setup guide
- When configured, unauthenticated users redirect to `/auth.html` login page
- Patreon tiers map to roles (guest → supporter → founder → admin)

`pytest.ini` sets `pythonpath = apps src` so tests can import from both trees without install.

## Keystone Testing Charter

**Autonomous test agent** using Agentic QE principles for continuous self-improvement.

### Targets
- **Dev server**: `http://127.0.0.1:4178` (current branch, hot-reload)
- **Stable server**: `http://127.0.0.1:4177` (master branch)

### Test Scenarios
| Scenario | Purpose | Target |
|---|---|---|
| home-load | Verify home page renders + no console errors | `/` |
| dream-chat-init | Verify dream-chat loads + textarea ready | `/dream-chat.html` |
| dream-chat-first-message | Send test message + verify response stream | `/dream-chat.html` |
| theme-toggle | Light ↔ dark mode works bidirectionally | All pages |
| dream-chat-agent-select | Switch agent personas + verify prompt changes | `/dream-chat.html` |
| dream-chat-error-handling | Send malformed input + verify error state | `/dream-chat.html` |
| home-nav-links | Click all nav links + verify page loads | `/` → all targets |
| trader-dashboard-load | Verify Kalshi deck renders | `/kalshi-terminal.html` |
| responsive-mobile | Test 375x812 (iPhone) viewport | All pages |
| responsive-tablet | Test 768x1024 (iPad) viewport | All pages |
| console-monitoring | Capture console errors during all scenarios | All pages |
| network-monitoring | Capture failed requests (4xx, 5xx, timeout) | All pages |
| slow-network | Flag requests >1000ms | All pages |

### Confidence Thresholds
| Score | Action |
|---|---|
| 0.8–1.0 (High) | File immediately with [keystone-autonomous] tag |
| 0.5–0.79 (Medium) | File with [needs-review] tag + wait for approval |
| 0.2–0.49 (Low) | Log to `data/keystone-insights.jsonl` (manual review later) |
| <0.2 (Trivial) | Discard (console.warn, CSS whitespace, etc.) |

### Triggering Autonomous Tests
**In dream-chat.html:**
- Type: `"test the app"` or `"scan for issues"` or `"audit the system"`
- Keystone agent will autonomously:
  1. **Observe**: Fetch list of issues needing validation
  2. **Research**: Analyze codebase for test coverage gaps
  3. **Reason**: Generate test plan using Playwright scenarios
  4. **Act**: Run scenarios via Playwright MCP
  5. **Verify**: Score findings by confidence (Σ₀ rigor)
  6. **Converge**: File issues with evidence + confidence records

### Reviewing Results
1. **Live stream**: Watch real-time test execution in dream-chat.html test panel
2. **Convergence log**: `data/keystone-test-runs.jsonl` — append-only record of each run
3. **Issue tracker**: `#566-588` — full test fleet issues for ongoing improvements
4. **GitHub issues**: Auto-filed with [keystone-autonomous] + [sigma0-grounded] labels

### Convergence Records
Each test run logs:
```json
{
  "timestamp": "2026-06-16T...",
  "runId": "keystone-20260616-...",
  "scenarios_completed": 12,
  "findings_total": 3,
  "findings_high_confidence": 2,
  "filed_issues": ["#615", "#616"],
  "convergence": {
    "hypothesis": "Dream-chat XSS in image gallery",
    "evidence": ["screenshot", "console trace", "HTML snippet"],
    "confidence": {
      "research": 0.85,
      "web_grounded": 0.8,
      "observable": 1.0,
      "overall": 0.85
    },
    "sources": ["codebase analysis", "web search", "playwright trace"]
  }
}
```

## Per-Lane Workstream Rule (Critical)

Each **lane** gets **one open PR at a time**. All lanes run concurrently. The lane key
is the branch's **first path segment**: agent prefixes are fixed lanes, every other
prefix is a **dynamic human lane** named after that prefix.

| Branch prefix | Lane | Kind |
|---|---|---|
| `claude/` | Claude lane | agent |
| `gemini/` | Gemini lane | agent |
| `codex/` | Codex lane | agent |
| `devin/` | Devin lane | agent |
| `grok/` | Grok lane | agent |
| `openai/` | OpenAI lane | agent |
| `alex/` | Alex lane | human (dynamic) |
| `kriskin/` | Kriskin lane | human (dynamic) |
| `mookman11/` | Mookman11 lane | human (dynamic) |
| any other `<name>/` | that contributor's lane | human (dynamic) |
| no `/` (unprefixed) | shared `human` lane | human (fallback) |

**Dynamic human lanes:** the human roster is open-ended — any new `<name>/…` prefix
becomes its own concurrent lane with no code or roster change, so more than one (and
more than three) humans can work at once. `alex/`, `kriskin/`, `mookman11/` no longer
block each other.

Rules:
- A second branch in the same lane is blocked until its first PR is merged/closed
- Commits/pushes to a branch **that already has an open PR** are always allowed
- `gh-pages`, `master`, `dev` are exempt
- Direct push to master is blocked — open a PR, or: `OVERRIDE_MERGE=1 git push origin master`
- Slop commit messages (empty, < 8 chars, "wip", "placeholder", "temp", etc.) are blocked

**Assigned-issue merge gate:** a PR that closes a **human-assigned** issue cannot
auto-merge into `master` until it carries **both** a convergence record (`!convergance`)
and autowork verification (`!work`/`!autowork`) — surfaced as the `convergance-record` +
`autowork-verified` labels, or the fleet host's `data/autowork-runs/*.jsonl` evidence. A
successful autowork run satisfies both. Enforced by the single merger
(`apps/lantern-garage/lib/pr-watcher.js`); held with `needs_convergance_record:#N` /
`needs_autowork_verification:#N`.

Install hooks:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/Install-MonoworkstreamHooks.ps1
```

Bypasses:
```bash
SKIP_MONOWORKSTREAM=1 git commit/push   # skip workstream + slop checks
OVERRIDE_MERGE=1 git push origin master  # allow direct master push
```

Always check open PRs per-agent before creating a new branch.

**Note:** Multiple agents running concurrently via `.claude/agent-slots.json` is a core design feature. The rule applies to Git branches / PRs, not to active agent slots.
