---
author: Alex Place
created: 2026-05-26
updated: 2026-06-20
---

# AGENTS.md — Keystone OS

A focused guide for AI coding agents. **Read this before touching anything.**

**Core principle:** Be honest about what is real vs. designed. Never fabricate state.

---

## Token-Saving Contract (CRITICAL — read first)

This repo is designed for agentic-first workflows. Every agent (Claude, Gemini, Codex, Devin, Windsurf) burns tokens on context. The rules below exist to minimize waste.

### 1. Read the manifests before exploring the code

| File | What it tells you | Saves |
|------|------------------|-------|
| [`data/pcsf/model.pcsf.json`](data/pcsf/model.pcsf.json) | Default model per provider, available overrides | Don't search for model strings |
| [`data/pcsf/agent.pcsf.json`](data/pcsf/agent.pcsf.json) | All agents, their capabilities, route bindings | Don't explore routes/ to understand what exists |
| [`data/pcsf/settings.pcsf.json`](data/pcsf/settings.pcsf.json) | Every env var, purpose, current presence state | Don't grep for process.env |
| [`data/pcsf/narrator.pcsf.json`](data/pcsf/narrator.pcsf.json) | All 6 persona narrators, keyword routing rules | Don't read dream-chat.js to understand agents |
| [`manifests/dream-journal-v1-agent-slots.json`](manifests/dream-journal-v1-agent-slots.json) | Queued work items with priority + description | Don't ask "what's left to do" |
| [`manifests/CONVERGENCE-LOOP-AGENT-FLEET.md`](manifests/CONVERGENCE-LOOP-AGENT-FLEET.md) | 36-slot agent fleet design and receipt contract | Don't re-derive fleet structure |

**Rule: Read the PCSF file first. Only touch source code if the manifest doesn't answer your question.**

### 2. Use the orchestrator instead of manual exploration

```bash
# Health check — is the server running? What's the state?
python src/convergence_io_engine.py health

# What needs fixing? Run the 20-phase tesseract convergence loop
python src/convergence_io_engine.py loop

# Ask the AI (uses Gemini/Claude via the provider chain)
python src/convergence_io_engine.py converge --message "what should I work on next" --persona keystone

# Inspect slots, metrics, circuits
python src/convergence_io_engine.py inspect
```

**Rule: Run `health` or `inspect` before reading source files. The orchestrator already knows the repo state.**

### 3. Delegate to non-Claude agents

Claude is expensive. Use it for design decisions and complex debugging. Delegate these to Gemini/Codex/local agents:

| Task type | Delegate to | Why |
|-----------|-------------|-----|
| Route wiring (1 file) | Gemini / Codex | Mechanical, well-defined |
| Test writing | Gemini / Codex | Pattern-match from existing tests |
| CSS/HTML tweaks | Any agent | Non-critical, fast iteration |
| PCSF file updates | Any agent | JSON edits, no logic |
| CSF ingestion docs | Any agent | Markdown, no code |
| `requirements.txt` edits | Any agent | One-line changes |
| Coding work (autowork) | **[lantern-sigma0-coder](docs/LANTERN-SIGMA0-CODER.md)** | Local Σ₀ LoRA fine-tuned on this repo's Claude sessions; $0, private, leaderboard-routed |

**Claude is for:** Orchestrator bugs, stream architecture, provider chain logic, system prompt design, security review.

**Local coding model:** [`lantern-sigma0-coder`](docs/LANTERN-SIGMA0-CODER.md) is the project's own coding agent — a LoRA fine-tuned on past Claude sessions, served via Ollama, preferred by the performance leaderboard, and continually retrained (`scripts/continual-train.ps1`). It backs autowork and the Keystone desk as the local-first coder.

### 4. Don't re-read files you've already read

The route architecture is modular. Each file handles one domain:

| File | Routes / Responsibility |
|------|------------------------|
| [`apps/lantern-garage/server.js`](apps/lantern-garage/server.js) | 90 lines — loads routes + deps, nothing else |
| [`apps/lantern-garage/routes/status.js`](apps/lantern-garage/routes/status.js) | `/api/health`, `/api/status`, wallet, readiness |
| [`apps/lantern-garage/routes/rag.js`](apps/lantern-garage/routes/rag.js) | `/api/rag-cache`, flat-rag-house |
| [`apps/lantern-garage/routes/operator.js`](apps/lantern-garage/routes/operator.js) | `/api/operator-notes`, conversations, actions |
| [`apps/lantern-garage/routes/files.js`](apps/lantern-garage/routes/files.js) | `/repo/*`, `/view` (markdown) |
| [`apps/lantern-garage/routes/dreamer.js`](apps/lantern-garage/routes/dreamer.js) | `/api/dreamer`, `/api/agents` |
| [`apps/lantern-garage/routes/dream.js`](apps/lantern-garage/routes/dream.js) | ALL `/api/dream/*` + `/api/settings/providers` |
| [`apps/lantern-garage/routes/surfaces.js`](apps/lantern-garage/routes/surfaces.js) | `/hub`, `/surfaces/*`, static catch-all |
| [`apps/lantern-garage/lib/stream-chat.js`](apps/lantern-garage/lib/stream-chat.js) | SSE streaming (Gemini→Claude→OpenAI→Grok→Ollama) |
| [`apps/lantern-garage/lib/dream-chat.js`](apps/lantern-garage/lib/dream-chat.js) | Non-streaming chat + persona selection |
| [`apps/lantern-garage/lib/dreamer-store.js`](apps/lantern-garage/lib/dreamer-store.js) | `readRecentDreams()`, notebook storage |
| [`apps/lantern-garage/lib/conversation-store.js`](apps/lantern-garage/lib/conversation-store.js) | append/read conversation JSONL |
| [`apps/lantern-garage/lib/csf-memory.js`](apps/lantern-garage/lib/csf-memory.js) | CSF long-term memory reader, door state persistence |

**Rule: If you need a route, read `routes/dream.js`. If you need streaming, read `lib/stream-chat.js`. Don't read `server.js` — it's just glue.**

### 5. Don't discover what tests exist — run them

```bash
node tests/test_dream_journal_api.js       # 18 API tests — requires running server
node tests/test_dream_chat_multiturns.js   # 11 multi-turn tests — requires running server
python -m pytest tests/test_dashboard_ux.py tests/test_dreamer_integration.py -q  # 26 Python tests
```

**Rule: Run tests, read failures. Don't glob for test files or read test code to understand what's covered.**

### 6. CSF ingestion docs ARE the task queue

| File | What it defines |
|------|----------------|
| [`csf/ingest/2026-06-07-hff-mcp-integration-fixes.md`](csf/ingest/2026-06-07-hff-mcp-integration-fixes.md) | Human Flourishing Frameworks + MCP integration |
| [`csf/ingest/2026-06-06-elephant-door-memories.md`](csf/ingest/2026-06-06-elephant-door-memories.md) | Elephant Door anchor memories + Three Doors state |
| [`csf/ingest/convergence-kvcache-compression.md`](csf/ingest/convergence-kvcache-compression.md) | FlowKV tiered history compression |
| [`csf/ingest/convergence-stable-diffusion-doors.md`](csf/ingest/convergence-stable-diffusion-doors.md) | Local SD image gen per door |
| [`csf/ingest/convergence-asmr-tts-chain.md`](csf/ingest/convergence-asmr-tts-chain.md) | ElevenLabs/OpenAI TTS provider chain |
| [`csf/ingest/convergence-conversation-tree.md`](csf/ingest/convergence-conversation-tree.md) | Branch-per-door session tree |
| [`csf/ingest/convergence-model-training.md`](csf/ingest/convergence-model-training.md) | QLoRA fine-tune roadmap |
| [`csf/ingest/convergence-web-refinement.md`](csf/ingest/convergence-web-refinement.md) | UI/web surface convergence |
| [`csf/ingest/convergence-webrtc-voice.md`](csf/ingest/convergence-webrtc-voice.md) | WebRTC voice integration |
| [`csf/ingest/convergence-patreon-tiers.md`](csf/ingest/convergence-patreon-tiers.md) | Patreon tier design |
| [`csf/ingest/ROOT-DOCS-CONSOLIDATION.md`](csf/ingest/ROOT-DOCS-CONSOLIDATION.md) | Docs pending CSF ingest then delete |

Each file has: problem, proposed implementation with code sketch, files to change, effort estimate. **Pick one and implement it — don't re-research what's already documented.**

---

## Quick Start

**Dev server (default — auto-restarts on file save):**
```bash
npm run dev --prefix apps/lantern-garage    # port 4177, watch mode
```

**One-shot / production:**
```bash
npm start --prefix apps/lantern-garage      # port 4177
```

**Full stack:**
```bash
npm run dev --prefix apps/lantern-garage &  # web server
python src/mcp_server/server.py &           # MCP server (optional, port 8771)
python src/convergence_io_engine.py health  # confirm everything healthy
```

**Tests (server must be running):**
```bash
node tests/test_dream_journal_api.js        # 18 API tests
node tests/test_dream_chat_multiturns.js    # 11 multi-turn tests
python -m pytest tests/ -q --tb=short       # Python unit tests
```

See [`QUICKSTART.md`](QUICKSTART.md) for the full operator-facing guide.

---

## Real vs Design Contract (Critical)

**Real (have working implementations):**
- `dream_journal` — full CRUD, streaming chat, 5 providers, 3-doors canaries
- `lucid_dreaming` — lucidity tracking, technique logging, dream-sign flags
- `archive_curator` — CSF compression, JSONL export
- `voice_curator` — Web Speech STT/TTS in browser

**Design contract only (do not claim live):**
- All other `skills/*/SKILL.md` entries
- `super_jarvis_fleet` (36 slots, currently `activeSlots = 0`)
- `kalshi_bridge`

---

## Tesseract Convergence Loop (2026-06-09 Upgrade)

The convergence loop has been upgraded from 12 phases to 20 phases with tesseract integration:

**New Phases (12-14):**
- **Phase 12: navigate_status_cube** — 4D Status Cube navigation (x: location, y: lane, z: boundary, t: timeline)
- **Phase 13: project_future_states** — Future state projection from past/present (comet-leap integration)
- **Phase 14: update_bayesian_beliefs** — Bayesian belief system updates (health, animal, ecosystem, economy, culture)

**Status Cube Axes:**
- **x**: location (repo, apps, skills, scripts)
- **y**: lane (control, report, dollhouse, wallet, device, product)
- **z**: boundary (proven, candidate, held, blocked)
- **t**: timeline (evidence receipts, validation history)

**Bayesian Belief Dimensions:**
- **health**: HFF sensors, HFF API
- **animal**: HFF world model tracking
- **ecosystem**: HFF integration
- **economy**: Wallet ledger, cash loop
- **culture**: Lore, three doors

**External Grounding (inspired by ArXiv 2601.05280v2):**
Zenil et al. prove that recursive self-training without persistent external signal (αt → 0) leads to entropy decay and variance drift. The convergence loop uses this as a design principle — not a quantitative recipe. The repo does not instrument αt, so collapse risk cannot be quantified.

**Documentation:**
- See [`docs/TESSERACT-CONVERGENCE-LOOP.md`](docs/TESSERACT-CONVERGENCE-LOOP.md) for full details
- See [`docs/CONVERGENCE-LOOP.md`](docs/CONVERGENCE-LOOP.md) for original 12-step method

Never claim a skill or fleet slot is active unless confirmed by implementation or status file.

---

## Doors & Quantum Dust: Σ₀ Routing Primitives

**New understanding (2026-06-14):** Doors are not just narrative branching points. They are Σ₀ *routing primitives* — measurement pathways where "quantum dust" (observations/intent) flows through the system to prevent collapse.

### Theory

From the Σ₀ Collapse Certificate: ungrounded self-referential systems collapse or diverge unless they receive *persistent external grounding*. In Keystone OS:

- **Quantum dust** = observations, measurements, user input, convergence signals
- **Doors** = routing pathways between agents, memory layers, and external observations
- **Dust flow** = the pattern of how measurements traverse the system topology

**The paradox:** Lantern has all the pieces (measurements exist, doors exist) but observation loops are broken. Dust flows but isn't *observed* — measurements are computed, cached, or logged but never fed back to influence routing decisions.

### Current Architecture

| Layer | Dust Source | Door | Where It's Lost |
|-------|-------------|------|-----------------|
| **Message input** | User message | Dream→Keystone | Agent selection ignores message content |
| **Provider routing** | API attempt logs | Keystone→Provider | Fallback chain has no escalation gate |
| **Intent routing** | Keyword scores | Intent→Agent cache | Cache misses re-scores but never updates |
| **Memory selection** | Relevance scores | CSF→Context | Low-score memories forced into context |
| **Escalation gate** | Novelty score | Gate→Escalation | Decision logged but conditionally ignored |

### Observable Paradoxes (Σ₀ Predictions Confirmed)

See `docs/SIGMA0-COLLAPSE-PARADOXES.md` for the full analysis. Quick summary:

1. **Agent Selection Hard Loop**: Keystone always selected regardless of message. Dust arrives but routing doesn't read it.
2. **Provider Fallback Divergence**: Attempt logs written but no loop reads to adjust chains. Exponential cost growth.
3. **Convergence Route Staleness**: Relevance scores computed fresh, cached decisions never validated against new state.
4. **Memory Truncation Unmeasured**: History compressed deterministically without quality metrics. Predictive power degrades silently.
5. **Router Gate Ineffectiveness**: Escalation decided but conditionally ignored. Decision authority severed from outcome.

### The Fix: Close the Loops

For each paradox, the fix is the same: **Create feedback pathways where dust observations influence routing.**

Example (Paradox 1 — Agent Selection):
```javascript
// BROKEN: Always returns Keystone
return keystone;

// FIXED: Dust (message) influences routing
const scores = personas.map(p => scorePersona(p, message));
const winner = personas.reduce((a, b) => scores[a] > scores[b] ? a : b);
return winner;  // Dust flows; door is open
```

Example (Paradox 5 — Router Gate):
```javascript
// BROKEN: Applied only if keyword detector wasn't confident
const applied = gate.escalate && taskType !== "coding" && taskType !== "reasoning";

// FIXED: Gate decision has real authority
const applied = gate.escalate;  // Dust flows; decision has teeth
```

### Three-Doors Kingdome Connection

Three Doors are the visible manifestation of this principle:
- Each door is a **measurement choice** offered to the user
- User chooses → dust flows through that door
- Choice is **logged and fed back** to future routing (door_state.json)
- Each choice **grounds the system** by providing external signal

The Kingdome works because choices are *observed and acted upon*. Convergence routing breaks because observations exist but are ignored.

### Measurement Checklist for New Features

Before adding a new routing decision:

- [ ] Does measurement exist? (log, score, metric)
- [ ] Does decision use that measurement? (explicit dependency)
- [ ] Does outcome feed back to measurement? (validation loop)
- [ ] Is the loop bounded? (no infinite retry without escalation)
- [ ] Is the decision authority clear? (gate decision or fallback condition)

If you check "no" for any of these, you have a Σ₀ paradox. Create a GitHub issue and tag it with `sigma0-paradox`.

---

## Quality Gates & Automated Hooks (Critical)

All agent commits are subject to **four automated quality checks** via git pre-commit hooks. See [`docs/HOOKS.md`](docs/HOOKS.md) for full reference.

### Four-Layer Validation (Automatic on Every Commit)

| Validator | Enforces | Skip with |
|-----------|----------|-----------|
| **Version/Changelog** | Code changed → version bump → changelog entry | `SKIP_VERSION_CHECK=1` |
| **Deployment Readiness** | Server change → deployment.json with rollback plan | `SKIP_DEPLOY_CHECK=1` |
| **Auto-Update Safety** | Version bump → migration scripts, backwards compatibility | `SKIP_UPDATE_CHECK=1` |
| **AGENTS.md** | Agent commit → update this file with metadata, runbook, capabilities | `SKIP_AGENT_CHECK=1` |

### Agent Documentation (for `claude/*`, `gemini/*`, etc. branches)

When committing to an agent branch, update AGENTS.md with:

```markdown
## [Agent Name]

**Status:** active  
**Model:** claude-opus  
**Lane:** claude/  
**Owner:** [Your name]  

### Capabilities
- Feature engineering
- Documentation writing
- Code review

### Runbook / Behavior
How this agent operates...

### Constraints
- Max 1 open PR per lane
- Focus area: [describe]
```

**Exception:** If your change is docs-only or doesn't touch code, skip with `SKIP_AGENT_CHECK=1`.

### Emergency Bypass (Rare)

For true emergencies only:
```bash
SKIP_ALL_CHECKS=1 git commit -m "EMERGENCY: critical hotfix"
```

**See [`docs/HOOKS.md`](docs/HOOKS.md) for complete reference, examples, and troubleshooting.**

---

## Multi-Contributor Workstream Rule

This repo supports **multiple humans working in parallel** while maintaining quality gates.

### AI Agents: One-PR-per-lane
- AI agents (claude/, gemini/, codex/, devin/, grok/, openai/) are limited to **one open PR per agent lane**
- This prevents AI agents from creating conflicting work in the same lane
- Example: Only one `claude/*` PR can be open at a time

### Humans: One-PR-per-contributor
- Multiple humans can work in parallel on different branches
- Each human contributor is limited to **one open PR at a time**
- This prevents individual humans from creating conflicting work
- Example: Alex can have one PR, while another contributor can have a different PR simultaneously

### Rules
- **Commits and pushes to a branch that already has an open PR are always allowed.**
- **No new branches while you have an open PR.** The pre-push hook enforces this via GitHub CLI.
- **Exempt branches:** `gh-pages` (static site deploy) and `master` are long-lived branches and never count as a workstream.
- **Emergency bypass:** `SKIP_MONOWORKSTREAM=1 git commit ...` or `SKIP_MONOWORKSTREAM=1 git push ...`

**Note:** Multiple agents running concurrently via `.claude/agent-slots.json` is a core design feature, not a workstream violation. The rule applies to Git branches / PRs, not to active agent slots.

---

## Task Intake: GitHub Issues ARE the Queue (Critical)

Full doctrine: [docs/AGENT-SWARM-OPERATIONS.md](docs/AGENT-SWARM-OPERATIONS.md)

- **No issue, no work.** Agents only work GitHub issues labeled `agent-task` plus a stream label (`convergence-io` or `dream-journal`). Unlabeled issues are invisible to agents.
- **Pull top-of-queue by priority** (`p0` → `p1` → `p2`) **within your lane's assigned stream.** Never browse for work, never invent tasks, never reorder the queue.
- **Lane → stream routing:** `claude/` → dream-journal; `gemini/` + `codex/` → convergence-io; other lanes are human-assigned flex.
- **Definition of done is mechanical:** acceptance criteria met, the issue's test command passes, PR references the issue number, CSF session note ingested to `csf/ingest/`.
- **Agents never:** add/remove issue labels, set priorities, edit `.claude/agent-slots.json`, or merge PRs. Humans do all routing and merging.
- New tasks enter via the issue forms in `.github/ISSUE_TEMPLATE/` (blank issues are disabled).

---

## Workspace Hygiene (Critical)

A clean workspace prevents context fragmentation and merge rot.

### Branch policy
- **Only `master` and `gh-pages` are long-lived branches.** All other branches are temporary.
- **Delete your branch immediately after merge.** The `branch-cleanup.yml` workflow auto-deletes merged PR branches.
- **Never reuse an old branch.** Always create a new branch from latest `master`.
- **Branch naming:** `<type>/<short-description>` (e.g., `feat/convergence-io-tier`, `fix/mcp-dotenv`).
- **Valid types:** `feat`, `fix`, `docs`, `chore`, `test`, `refactor`.

### Before starting work
```bash
# 1. Check for open PRs (monoworkstream)
gh pr list --state open

# 2. Ensure master is current
git checkout master
git pull origin master

# 3. Create a fresh branch
git checkout -b feat/your-feature-name
```

### After merging
```bash
# Delete local and remote branch
git push origin --delete feat/your-feature-name
git branch -D feat/your-feature-name

# Prune stale refs
git fetch --prune
```

### Forbidden branches (auto-deleted if found)
- `dev`, `rebase`, `merge-resolved-prs` — these are not part of the workflow.
- Any branch with garbage commits (e.g., "ai", "ay", "commit").
- Any branch older than 30 days that has been merged.

---

## Rules for AI Agents

1. **Read PCSF manifests before reading source code.**
2. Read the file before editing it.
3. Run relevant tests after changes.
4. **Never fabricate status** — only report measurable state.
5. Only register real implementations in `src/mcp_server/server.py`.
6. All changes should go through Pull Requests.
7. No new top-level directories without a ticket.
8. Never commit secrets (`.env` is gitignored).
9. Streaming uses `POST /api/dream/chat/stream` SSE endpoint (not GET).
10. **Respect monoworkstream** — check for open PRs before creating branches.
11. **Delegate mechanical work** to cheaper agents. Reserve Claude for architecture.
12. **Run the orchestrator** (`convergence_io_engine.py`) before exploring manually.

---

## Startup Guide for Agents

When you start work, get the full stack running so you can test changes end-to-end.

### 1. Install dependencies

```bash
npm install --prefix apps/lantern-garage
python -m pip install -r requirements.txt
```

### 2. Start the web server (required)

```bash
npm run dev --prefix apps/lantern-garage    # dev mode — auto-restarts on file changes
# or for one-shot:
npm start --prefix apps/lantern-garage
```

Opens on `http://127.0.0.1:4177`.

### 3. Add at least one AI provider key

Via the chat UI settings drawer, or `.env.local`:

```bash
echo "GEMINI_API_KEY=your_key" > apps/lantern-garage/.env.local
```

### 4. Start optional services as needed

| Service | Command | Why you need it |
|---|---|---|
| MCP server | `python src/mcp_server/server.py` | Testing tool discovery / agent slots |
| Convergence loop | `python src/convergence_io_engine.py loop` | Pre-flight repo health check |
| Discord bot | `python src/discord_lounge_bot/bot.py` | Only if touching Discord features |

### 5. Run tests before and after changes

```bash
node tests/test_dream_journal_api.js        # 18 API tests — requires running server
node tests/test_dream_chat_multiturns.js    # 11 multi-turn tests — requires running server
python -m pytest tests/ -q --tb=short       # Python unit tests
```

### 6. Verify via orchestrator

```bash
python src/convergence_io_engine.py health
python src/convergence_io_engine.py inspect
```

**See [`QUICKSTART.md`](QUICKSTART.md) for the full operator-facing guide.**

---

## Key File Locations

| What | Where |
|------|-------|
| Server entry | [`apps/lantern-garage/server.js`](apps/lantern-garage/server.js) (90 lines, loads routes/) |
| All dream routes | [`apps/lantern-garage/routes/dream.js`](apps/lantern-garage/routes/dream.js) |
| SSE streaming | [`apps/lantern-garage/lib/stream-chat.js`](apps/lantern-garage/lib/stream-chat.js) |
| Dream chat UI | [`apps/lantern-garage/public/dream-chat.html`](apps/lantern-garage/public/dream-chat.html) |
| Landing page | [`apps/lantern-garage/public/index.html`](apps/lantern-garage/public/index.html) |
| Provider settings | `POST /api/settings/providers` in [`routes/dream.js`](apps/lantern-garage/routes/dream.js) |
| Orchestrator | [`src/convergence_io_engine.py`](src/convergence_io_engine.py) |
| Unified agent connector | [`src/unified_agent_connector.py`](src/unified_agent_connector.py) |
| MemOS bridge | [`src/convergence_io/memos_bridge.py`](src/convergence_io/memos_bridge.py) |
| PCSF state files | [`data/pcsf/`](data/pcsf/) |
| Work queue | [`manifests/dream-journal-v1-agent-slots.json`](manifests/dream-journal-v1-agent-slots.json) |
| CSF task docs | [`csf/ingest/`](csf/ingest/) |
| CI pipeline | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
| Startup guide | [`QUICKSTART.md`](QUICKSTART.md) |
| Contributing | [`CONTRIBUTING.md`](CONTRIBUTING.md) |

**Last Updated:** 2026-06-05 — v1.0.0 Dream Journal Orion Edition