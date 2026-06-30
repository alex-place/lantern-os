---
author: Alex Place
created: 2026-05-26
updated: 2026-06-24
---

# AGENTS.md — Keystone OS

A focused guide for AI coding agents. **Read this before touching anything.**

**Core principle:** Be honest about what is real vs. designed. Never fabricate state.

---

## ⚠️ Accessibility Compliance (2026-06-24)

**All surfaces must be WCAG AA compliant.** When working on UI changes:

- ✅ Add keyboard focus indicators: `outline: 2px solid var(--accent); outline-offset: 2px;`
- ✅ Use semantic HTML (`<section>`, proper heading hierarchy, landmarks)
- ✅ Add ARIA labels (`aria-label`, `aria-labelledby`, `aria-hidden`)
- ✅ Support `@media (prefers-reduced-motion: reduce)` — disable animations for users sensitive to motion
- ✅ Support `@media (forced-colors: active)` — provide CanvasText fallbacks
- ✅ Test with keyboard navigation (Tab, Shift+Tab, Enter)
- ✅ Run `npm run test:a11y` (site audit & accessibility tests) before committing

**Non-compliance will block merge.** See [WCAG 2.1 Level AA requirements](https://www.w3.org/TR/WCAG22/).

---

## Dual-Boot Worktree Architecture

**Important:** The live servers use separate git worktrees, NOT the main checkout.

| Server | Worktree | Source | Auto-Deploy |
|--------|----------|--------|-------------|
| **4177 (stable)** | `C:\dev\lantern-os-stable` | Deployed every 5 min from origin/master | ✅ Yes (non-destructive merge) |
| **4178 (dev)** | `C:\dev\lantern-os-dev` | Current branch (hot-reload) | ❌ No |
| **Main checkout** | `C:\dev\lantern-os` | Your working directory | — |

**Critical:** Changes to `C:\dev\lantern-os` are NOT reflected on the live servers. To test:
1. Commit to a branch in the main checkout
2. Push to origin
3. The stable server will pull and deploy in ~5 minutes

**For immediate testing:** Use the dev server (4178) or manually restart the stable server after pushing.

### Non-Destructive Deployment (2026-06-24)

The stable auto-deploy uses `git merge --ff-only` instead of destructive `git reset --hard`. This means:

- ✅ **Runtime data preserved** — JSONL logs, user data, `.env` files stay intact
- ✅ **No commit loss** — Uncommitted changes don't get wiped
- ✅ **Safe rollback** — Health check failure triggers automatic rollback to the last known-good commit
- ⚠️ **Git conflicts impossible** — `--ff-only` aborts if branches have diverged

See `C:\dev\deploy-stable-from-master.ps1` for the deployment script.

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
| Coding work (autowork) | **[Σ₀ Ouro Coder](docs/SIGMA0-OURO-CODER.md)** | Local looped Ouro-1.4B + Σ₀ QLoRA; $0, private, drop-in served on `:11434` |

**Claude is for:** Orchestrator bugs, stream architecture, provider chain logic, system prompt design, security review.

**Local coding model:** the [Σ₀ Ouro Coder](docs/SIGMA0-OURO-CODER.md) is the project's own coding agent — a looped **Ouro-1.4B** model with a Σ₀ QLoRA fine-tune on past Claude sessions, served drop-in via `scripts/ouro_serve.py` (no Ollama binary) and continually retrained ([SIGMA0-CONTINUAL-TRAINING.md](docs/SIGMA0-CONTINUAL-TRAINING.md)). It backs autowork and the Keystone desk as the local-first coder. (The earlier Qwen-based `lantern-sigma0-coder` is deprecated.)

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

### Porting third-party code (licensing — Critical)

Only **permissive** OSS (Apache-2.0 / MIT / BSD-family) may be ported into Keystone. **GPL / AGPL / LGPL code MUST NOT be ported** — copyleft would relicense the whole project; re-implement clean-room from the docs instead. Every port (vendored verbatim under `vendor/<name>/` with the upstream `LICENSE` preserved, or a clean-room re-implementation credited in the file's docstring) must be recorded in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). See that file for the full convention (#1412).

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

## Codex convergence agent

**Status:** active
**Model:** GPT-5 Codex
**Lane:** codex/
**Owner:** Alex Place

### Capabilities
- Canonical tool-contract integration
- MCP and Dream Chat parity validation
- Security-boundary regression testing
- Private multi-source training-data builders and provenance validation

### Runbook / Behavior
Keeps `tool-runner.js` authoritative, delegates MCP execution through the
bounded Node bridge, validates structured policy outcomes on both surfaces, and
keeps generated session corpora local while committing only reproducible
builders and synthetic fixtures.

### Constraints
- Max 1 open PR in the Codex lane
- No duplicate Python tool schema/policy table
- Preserve sandbox, command allowlist, SSRF, and operator gates

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

### Humans: Dynamic per-contributor lanes
Human lanes are **dynamic** — there is no fixed roster and no shared "all humans" lane.
The lane key is the branch's **first path segment**, so every contributor who prefixes
their branches with their own name gets their own concurrent lane:

- `alex/…`, `kriskin/…`, `mookman11/…` are the current human lanes — and **any new
  `<name>/…` prefix becomes a new lane automatically** (no code change, no roster edit).
  This supports more than one and more than three humans working at once.
- Each human lane is still capped at **one open PR at a time** (focus per contributor):
  `alex/` can have one PR open while `kriskin/` and `mookman11/` each have their own —
  they no longer block each other.
- A branch with **no `/`** (ad-hoc, unprefixed) falls back to a single shared `human`
  lane, so stray branches can't spawn unlimited free lanes.

### Assigned-issue merge gate (Verify → Converge)
A PR that **closes a human-assigned GitHub issue** cannot be auto-merged into `master`
until the work is grounded with **both**:
1. a **convergence record** (`!convergance` — hypothesis + evidence + confidence), and
2. **autowork verification** (`!work` / `!autowork` ran the loop end-to-end).

The single merger (`apps/lantern-garage/lib/pr-watcher.js`) enforces this: it reads the
PR's `convergance-record` + `autowork-verified` labels **or** the fleet host's autowork
run log (`data/autowork-runs/*.jsonl`). A successful autowork run satisfies both and
applies the labels automatically. Until then the PR is held with reason
`needs_convergance_record:#N` / `needs_autowork_verification:#N`. Unassigned issues and
PRs that close no issue are unaffected. Issues are routed to a lane + assignee via
`/refinement`.

### Rules
- **Commits and pushes to a branch that already has an open PR are always allowed.**
- **No new branches while your lane has an open PR.** The pre-push hook enforces this via GitHub CLI.
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

### Commit discipline — no uncommitted code (Critical)
**Uncommitted code is not accepted.** Any code you author in a session must land on a branch
and be pushed to a PR before the task is considered done. Never leave agent-authored changes
sitting in the working tree, and never `git stash` or commit to `master` to "park" work.

- Finish a task by committing your changes to a `claude/*` (or your lane's) branch and opening a PR.
- This working tree is frequently dirty from automation churn (`data/`, caches, regenerated
  assets) — so commit **only the files you changed** (`git add <paths>`), never `git add -A`. That
  risks sweeping in unrelated churn or PII. When the tree is too noisy to isolate your change,
  work in a fresh worktree off `origin/master`
  (`git worktree add -b <lane>/<desc> ../wt origin/master`) and apply just your files there.
- A local **Stop hook** (`scripts/hooks/stop-warn-uncommitted.sh`, wired via `.claude/settings.json`)
  nudges you at end-of-turn when tracked code files are left uncommitted. It is a reminder, not a gate
  (the tree's ambient churn makes a hard block impractical).

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
