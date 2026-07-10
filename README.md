---
author: Alex Place
created: 2026-05-26
updated: 2026-07-10
---

# Keystone OS (product: **Unisona**)

<!-- Core CI / quality gates -->
[![CI](https://github.com/alex-place/lantern-os/actions/workflows/ci.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/ci.yml)
[![Automated Tests](https://github.com/alex-place/lantern-os/actions/workflows/automated-tests.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/automated-tests.yml)
[![CodeQL Advanced](https://github.com/alex-place/lantern-os/actions/workflows/codeql.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/codeql.yml)
[![CSF Rust](https://github.com/alex-place/lantern-os/actions/workflows/csf-rust.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/csf-rust.yml)
[![PR Gates](https://github.com/alex-place/lantern-os/actions/workflows/pr-gates.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/pr-gates.yml)

<!-- Convergence / repo-health gates -->
[![Convergence CI](https://github.com/alex-place/lantern-os/actions/workflows/convergence-ci.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/convergence-ci.yml)
[![Smart Convergence Loop](https://github.com/alex-place/lantern-os/actions/workflows/smart-convergence-loop.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/smart-convergence-loop.yml)
[![OSS Repository Validation](https://github.com/alex-place/lantern-os/actions/workflows/oss-repo-validation.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/oss-repo-validation.yml)

<!-- Surface / integration / reporting -->
[![Static surface CI](https://github.com/alex-place/lantern-os/actions/workflows/static-surface-ci.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/static-surface-ci.yml)
[![Site Audit & A11y Tests](https://github.com/alex-place/lantern-os/actions/workflows/a11y-audit.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/a11y-audit.yml)
[![System Integration Validation](https://github.com/alex-place/lantern-os/actions/workflows/validate-system-integration.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/validate-system-integration.yml)
[![Validate Dream Journal](https://github.com/alex-place/lantern-os/actions/workflows/validate-dream-journal.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/validate-dream-journal.yml)
[![Report Generation](https://github.com/alex-place/lantern-os/actions/workflows/report-generation.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/report-generation.yml)

<!-- Release / deploy -->
[![Deploy](https://github.com/alex-place/lantern-os/actions/workflows/deploy.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/deploy.yml)
[![Release](https://github.com/alex-place/lantern-os/actions/workflows/release.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/release.yml)
[![Release provenance](https://github.com/alex-place/lantern-os/actions/workflows/release-provenance.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/release-provenance.yml)
[![MCP Tunnel Canary](https://github.com/alex-place/lantern-os/actions/workflows/mcp-tunnel-canary.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/mcp-tunnel-canary.yml)

**Keystone OS** is the internal/architecture name; the **user-facing product is [Unisona](https://unisona.ai)** (primary domain **unisona.ai**; the older `lantern-os.net` still resolves). "Lantern OS" is dead branding — repo/app paths (`lantern-os`, `lantern-garage`) and code identifiers keep the legacy name, but no user-facing surface should say Lantern. It is a persistent local-first reasoning system with autonomous deployment, evidence-grounded convergence, and operator-controlled agent lanes.

It combines a web app, local memory systems, MCP tooling, multi-provider routing, and a structured convergence loop so work moves from raw context → validated artifacts → archived evidence with clear receipts and ground-truth verification.

**Current state (v1.8.x, 2026-07):** **Unisona 1.8 — "one front door"** shipped 2026-06-30 (see [docs/UNISONA-1.8.md](docs/UNISONA-1.8.md)): every stage of the loop now has a user-facing cockpit surface. Since then the 1.8.1xx line added accounts/auth (email-confirm hard gate, Terms of Service + EULA consent, tiered entitlements), a Windows desktop app (thin launcher, ADR-0014), and continued grounding/vision work. Foundations still standing: Σ₀ (Sigma-Zero) verification framework · serving split into **fast-cached default + deep Σ₀ opt-in** (`OURO_NATIVE=1`) · **WCAG AA accessibility** on all surfaces · **non-destructive auto-deploy** with `git merge --ff-only`. The product surface is **[Unisona / Keystone Chat](docs/KEYSTONE-PRODUCT.md)** — the member's operator console for their own copy of the system.

---

## ⚠️ Required Reading for All Agents

- **[CLAUDE.md](CLAUDE.md)** — Agent-specific guidance, monoworkstream rules, environment variables
- **[AGENTS.md](AGENTS.md)** — Manifest, route map, PR lane rules, convergence agent fleet design
- **[SECURITY.md](SECURITY.md)** — Critical security fixes, vulnerability guidelines, best practices
- **[QUICKSTART.md](QUICKSTART.md)** — Full startup guide (dual-boot servers, autostart setup)

---

## Table of Contents

1. [What is Keystone OS?](#what-is-keystone-os)
2. [Current Capabilities](#current-capabilities)
3. [Release Status: v1.8](#release-status-v18)
4. [Σ₀ (Sigma-Zero) Architecture](#σ₀-sigma-zero-architecture)
5. [Getting Started](#getting-started)
6. [Development Workflow](#development-workflow)
7. [Project Architecture](#project-architecture)
8. [Core Concepts](#core-concepts)
9. [Autonomous Systems](#autonomous-systems)
10. [Testing and Validation](#testing-and-validation)
11. [Documentation Map](#documentation-map)
12. [Contributing](#contributing)
13. [Privacy](#privacy)

---

## What is Keystone OS?

Keystone OS is an **operating system for reasoning work** — not a traditional OS, but an app-level platform for managing complex, multi-step cognitive tasks.

### Core Operating Model

```
Observe → Remember → Reason → Act → Verify → Converge
```

**Every feature must strengthen one stage of this loop. Nothing else.**

### Who Should Use This

- **Keystone OS members** (subscribers) — you get the repo, the tools, and **Keystone chat**, the operator console for your own copy of the system. See **[Keystone Chat product definition](docs/KEYSTONE-PRODUCT.md)**.
- **Solo developers** working on complex projects that need evidence-backed decision-making
- **AI researchers** exploring convergence dynamics, autonomous routing, and persistent memory systems
- **Organizations** needing local-first agent workflows with operator control and audit trails
- **Dreamers & symbol workers** who want a journaling tool that connects dreams to convergence records

---

## Current Capabilities

| Area | Status | Notes |
|------|--------|-------|
| **[Keystone Chat](docs/KEYSTONE-PRODUCT.md)** | ✅ Live | Member operator console — grounded technical chat, **fast-cached default + deep Σ₀ opt-in** (`OURO_NATIVE=1`), tool-wired, leaderboard-measured |
| **[Explore Feed](docs/EXPLORE-FEED.md)** | ✅ Live (2026-06-26) | Single-pane, PCSF-ranked content stream (reads/watch/build/docs/beliefs) with filter chips; learns from clicks/dismisses on the same leaderboard that ranks model providers — no new recommender subsystem (#1211) |
| **Dream Journal** | ✅ Live | Freeform chat, local storage, JSONL export, PWA mode |
| **1.6 Trader Dashboard** | ✅ Live (2026-06-16) | Real-time market data, position management, convergence metrics |
| **1.6 Creator Dashboard** | ✅ Live (2026-06-16) | Dream journal publishing, markdown editor, template system |
| **Σ₀ Verification** | ✅ Live | Evidence-grounded claims, confidence scoring, convergence records |
| **Σ₀ Game Mode** | ✅ Live | Three Doors with convergence evidence chain |
| **Σ₀ Story Mode** | ✅ Live | Narrative routing through convergence loop |
| **Σ₀ Teach Mode** | ✅ Live | Knowledge base verification with ground-truth validation |
| **Autonomous Repair** | ✅ Live | Memory leak detection, graceful recovery, health monitoring |
| **Auto-Deployment** | ✅ Live | Master branch pulls every 5 min (non-destructive `merge --ff-only`), health check + automatic rollback |
| **Convergence Routing** | ✅ Live | 120+ deterministic intent routes, >70% cache hit rate, local-first (falls back to providers only on cache miss) |
| **Multi-Provider Fallback** | ✅ Live | Gemini → Claude → OpenAI → Grok → local Ollama, **reordered live by the PCSF leaderboard** (`provider.pcsf.json`) with capacity/privacy gates |
| **Local coding engine — Qwen2.5-Coder** | ✅ Live (#2171) | Qwen2.5-Coder served via Ollama `:11434` is the local-first coder (VRAM-gated registry). Graded on HumanEval — see [BENCHMARKS.md](docs/BENCHMARKS.md). **Ouro-1.4B is the Σ₀ kernel/research base + adapter host, not the coding engine** — its recurrent-depth "Ouro Coder" looping tested **NEGATIVE** (adds no accuracy, ~15× slower; #2178). |
| **CSF Memory Archive** | ✅ Live | Symbolic searchable format, tiered promotion (trace → skill) |
| **MCP Server** | ✅ Live | Local tool surface, agent registration, OAuth2 protected endpoint |
| **Discord Integration** | ✅ Live | Bot with convergence-aware responses |
| **WCAG AA Accessibility** | ✅ Live (2026-06-24) | Keyboard focus indicators (2px cyan outline), semantic HTML, ARIA labels, prefers-reduced-motion, forced-colors support — all surfaces compliant |
| **Non-Destructive Auto-Deploy** | ✅ Live (2026-06-24) | Git `merge --ff-only` instead of destructive reset; preserves uncommitted runtime data; health-checks with auto-rollback |

---

## Release Status: v1.8

**Unisona 1.8 — "one front door"** shipped 2026-06-30 (`1.8.0`); the repo is on the **1.8.1xx** line as of 2026-07 (current `1.8.127`). 1.8 was a consolidation milestone: the one loop finally has a user-facing cockpit at every stage. See [docs/UNISONA-1.8.md](docs/UNISONA-1.8.md) for the full by-loop-stage writeup.

**Landed in / since 1.8:**
- ✅ **Observe** — Explore feed (`/explore.html`), single ranked PCSF content stream
- ✅ **Remember** — confidence-decay memory (facts fade unless reinforced)
- ✅ **Reason** — personal cockpits (financial reasoning, preference model, learn-anything tutor)
- ✅ **Act** — in-chat Approve / Rework / Discard for autowork draft PRs, Σ₀ council wired into self-coding
- ✅ **Verify** — fact-check button, grounding-diff viewer, drift canaries, council exec-verify (defaults ON)
- ✅ **Converge** — decision journal + calibration scoring
- ✅ **Accounts & auth** (1.8.1xx) — email-confirm hard gate, Terms of Service + EULA consent gate, tiered entitlements, account-support console
- ✅ **Windows desktop app** — thin single-`exe` launcher over one Core (ADR-0014), Inno Setup installer

**In flight:** v1.9 (see [docs/v1.9-issue-list.md](docs/v1.9-issue-list.md)).

---

## Σ₀ (Sigma-Zero) Architecture

Keystone OS is built on **Σ₀** — a mathematical framework for verifying that systems don't collapse due to ungrounded feedback loops.

### The Five Σ₀ Paradoxes (Identified 2026-06-14)

| Paradox | Problem | Fix Status |
|---------|---------|-----------|
| **Agent Selection Hard Loop** | Keystone always chosen; message ignored | ✅ Fixed (PR #464) |
| **Provider Fallback Divergence** | Retries unbounded, no escalation gate | ✅ Fixed (PR #593) |
| **Convergence Route Staleness** | Cache frozen, never validates new state | ✅ Fixed (PR #503) |
| **Memory Truncation Unmeasured** | History loss silent, no quality metrics | ✅ Fixed (PR #473) |
| **Router Gate Ineffectiveness** | Escalation decided then ignored | ✅ Fixed (PR #378) |

### What This Means

Per Σ₀ framework: systems without feedback loops collapse. Without dust (observations) flowing back through doors, routing decisions freeze into degenerate fixed points.

**Current status:** All five paradoxes fixed with measurement loops + feedback gates. System verified stable under stress testing (1000+ iterations).

See [docs/CONVERGANCE-SIGMA0-BRIEFING.md](docs/CONVERGANCE-SIGMA0-BRIEFING.md) for the full technical spec.

---

## Auto-Deploy Infrastructure (2026-06-24)

The stable server (port 4177) uses a **non-destructive deployment model** that preserves uncommitted runtime data while safely deploying new code.

### How It Works

1. **Non-Destructive Merge** — Uses `git merge --ff-only origin/master` instead of `git reset --hard`, preserving any uncommitted changes to runtime files (JSONL logs, user data, etc.)
2. **Smart Restart Logic** — Only restarts the server if server-side code changed (`.js`, `.py` files in `lib/`, `routes/`, etc.); documentation and data-only changes are served fresh from disk without restart
3. **Health Checks** — After restart, validates `/api/convergence/health` endpoint with 25-second timeout; if unhealthy, automatically rolls back to the previous commit
4. **Scheduled Runs** — Runs every 5 minutes via Windows scheduled task `KeystoneAutoDeployStable`, hydrating API keys from User-scope environment before startup

### Deployment Benefits

- ✅ **Safe** — Uncommitted data preserved; fast rollback on failure
- ✅ **Efficient** — No unnecessary restarts; static assets served immediately
- ✅ **Observable** — Full deploy log at `C:\dev\auto-deploy-stable.log`
- ✅ **Automated** — Requires no manual intervention; health checks prevent broken deployments

---

## WCAG AA Accessibility Compliance (2026-06-24)

All surfaces now meet **WCAG 2.1 Level AA** standards. Keystone OS is committed to accessibility for all users, including those using keyboard navigation and assistive technologies.

### Accessibility Features

- **Keyboard Focus Indicators** — 2px cyan outline (`outline: 2px solid var(--accent); outline-offset: 2px;`) on all interactive elements, visible on hover and focus-visible states
- **Semantic HTML** — Proper use of `<section>`, `<h1>`-`<h3>` hierarchy, and structural landmarks for screen reader navigation
- **ARIA Labels** — `aria-labelledby`, `aria-hidden`, `aria-label` attributes on all interactive components
- **Prefers Reduced Motion** — Respects `@media (prefers-reduced-motion: reduce)` to disable animations for users sensitive to motion
- **Forced Colors Mode** — Support for high-contrast modes with `@media (forced-colors: active)`
- **High Contrast** — Support for `@media (prefers-contrast: more)` with increased border widths and outline visibility

### Compliance Details

Per WCAG 2.1 Success Criterion 2.4.7 (Focus Visible), all keyboard-operable elements must have a visible focus indicator with minimum 3:1 contrast ratio. Keystone's cyan accent provides 5.8:1 contrast on both light and dark backgrounds.

### Latest Updates (2026-06-24)

- ✅ `explore.html` — WCAG AA upgrade with semantic sections, focus indicators, ARIA labels, and animation preferences
- ✅ `index.html` — Home page tiles now support keyboard focus with smooth visual feedback
- ✅ All pages — Forced-colors and high-contrast modes fully functional

---

## Getting Started

### Fastest Start (30 seconds)

Open in browser:
```text
https://unisona.ai
```

(Requires internet; no local setup needed. The legacy `lantern-os.net` still resolves.)

### Local Development (2 minutes)

Prerequisites: Node.js 18+, Python 3.10+

```bash
# 1. Install dependencies
npm install --prefix apps/lantern-garage
python -m pip install -r requirements.txt

# 2. Start the server
node apps/lantern-garage/server.js

# 3. Open in browser
# http://127.0.0.1:4177
```

### Full Stack (All Services)

```powershell
# PowerShell: Start dual-boot (stable + dev)
make quickstart
# Opens http://127.0.0.1:4177 automatically

# Or manual startup:
# Terminal 1: Web server
node apps/lantern-garage/server.js

# Terminal 2: MCP server (optional)
python src/mcp_server/server.py

# Terminal 3: Convergence loop (optional)
python src/convergence_io_engine.py loop
```

See [QUICKSTART.md](QUICKSTART.md) for autostart and full configuration.

---

## Development Workflow

### Per-Lane Workstream Rule (Critical)

**Each lane may keep up to `WORKSTREAM_MAX_OPEN_PRS` open PRs at once (default 3).** The lane key is the branch's **first path segment**. Below the cap, concurrent session-branches are allowed, so one user or agent can run several sessions in parallel. Set `WORKSTREAM_MAX_OPEN_PRS=1` to restore the old strict one-PR-per-lane behaviour.

- **Agent lanes are fixed:** `claude/`, `gemini/`, `codex/`, `devin/`, `grok/`, `openai/`.
- **Human lanes are dynamic:** any other `<name>/…` prefix (`alex/`, `kriskin/`, `mookman11/`, …) becomes its own concurrent lane automatically — no roster edit. `alex/`, `kriskin/`, `mookman11/` no longer block each other, and more than three humans can work at once.
- A branch with **no `/`** falls back to a single shared `human` lane.
- `master`, `gh-pages`, `dev` are exempt and never count as a lane.

**Why?** Bounding open PRs per lane keeps merge conflicts and CI feedback manageable without forcing strictly serial work.

**Enforcement:**
- Repo-managed git hooks (`scripts/hooks/`, `core.hooksPath`) block a **new** PR once a lane is at the cap; commits/pushes to a branch that already has an open PR are always allowed.
- CI re-runs the same gates at PR time.
- Bypass: `SKIP_MONOWORKSTREAM=1 git commit/push`.
- See [AGENTS.md](AGENTS.md) for the full lane table and the assigned-issue merge gate.

### PR Lane Assignments

| Lane | Kind | Example Branch |
|------|------|-----------------|
| `claude/` | agent | `claude/home-redesign` |
| `gemini/`, `codex/`, `devin/`, `grok/`, `openai/` | agent | `gemini/add-features` |
| `auto/` | automation (autowork per-issue) | `auto/issue-505` |
| `alex/`, `kriskin/`, `mookman11/`, any `<name>/` | human (dynamic) | `kriskin/trade-fix` |
| unprefixed (no `/`) | shared `human` lane | `hotfix-typo` |

### PR Workflow

1. **Create branch from `master`**
   ```bash
   git fetch origin master
   git checkout -b auto/issue-505 origin/master
   ```

2. **Make one logical change** (see [CONTRIBUTING.md](CONTRIBUTING.md))

3. **Test locally**
   ```bash
   npm run test:api --prefix apps/lantern-garage
   python -m pytest tests/ -q
   ```

4. **Commit with Convergence Record**
   ```bash
   git commit -m "fix: Brief description (fixes #505)

   Detailed explanation if needed.
   
   Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
   ```

5. **Push and open PR**
   ```bash
   git push -u origin auto/issue-505
   gh pr create --title "fix: Brief" --body "Fixes #505"
   ```

6. **Wait for CI checks to pass**, then PR auto-merges when all checks green

### Auto-Merge System

A **single merger** (`apps/lantern-garage/lib/pr-watcher.js`) polls GitHub and squash-merges PRs automatically when:
- ✅ All CI checks pass (lint, type, tests)
- ✅ No merge conflicts, branch up-to-date with master
- ✅ The lane is within its `WORKSTREAM_MAX_OPEN_PRS` cap

**Assigned-issue merge gate (Verify → Converge):** a PR that closes a **human-assigned** issue is held until it carries **both** a convergence record (`convergance-record` label / `!convergance`) **and** autowork verification (`autowork-verified` label / a `data/autowork-runs/*.jsonl` receipt). A successful autowork run satisfies both. Unassigned issues and PRs that close no issue are unaffected.

**If auto-merge fails:**
- Resolve merge conflicts: `git rebase origin/master`
- Rerun tests: `npm run test:api --prefix apps/lantern-garage`
- Push the update to the same PR branch (never force-push over a merged head).

---

## Project Architecture

### File Organization

| Path | Purpose |
|------|---------|
| [`apps/lantern-garage/`](apps/lantern-garage/) | **Main web app** — Node.js server, routes, UI, streaming |
| [`apps/lantern-garage/server.js`](apps/lantern-garage/server.js) | HTTP entry point, dependency injection |
| [`apps/lantern-garage/routes/`](apps/lantern-garage/routes/) | API endpoints (dream, status, trading, orchestrator, auto-merge) |
| [`apps/lantern-garage/lib/`](apps/lantern-garage/lib/) | Core logic (chat, streaming, memory, PCSF, convergence routing) |
| [`apps/lantern-garage/public/`](apps/lantern-garage/public/) | Browser UI (dream-chat.html, trader-dashboard.html, create.html) |
| [`src/convergence_io_engine.py`](src/convergence_io_engine.py) | Convergence loop orchestrator + health checks |
| [`src/mcp_server/`](src/mcp_server/) | MCP server for local agent tools |
| [`src/csf/`](src/csf/) | Convergence-Fitted Searchable memory format |
| [`data/`](data/) | Runtime state (conversations, dreams, wallet, metrics, JSONL logs) |
| [`docs/`](docs/) | Architecture, operator guides, framework specs |
| [`manifests/`](manifests/) | Contracts, validation receipts, agent fleet design |
| [`tests/`](tests/) | Test suites (Node.js, Python, Playwright) |

### Core Services

| Service | Language | Port | Purpose |
|---------|----------|------|---------|
| Lantern Garage | Node.js | 4177 | Main web server + API |
| MCP Server | Python | 8771 | Local agent tools + OAuth2 |
| Convergence Engine | Python | — | Loop orchestration + health |
| Discord Bot | Python | — | Chat bridge + convergence |
| Auto-Repair | Node.js | 4177 | Health monitoring + graceful recovery |
| Auto-Deploy | Windows task | — | 5-min master pulls (`merge --ff-only`) + rollback |

---

## Core Concepts

| Concept | Role |
|---------|------|
| **Convergence Loop** | 12-step (or 20-step tesseract) operating method for validation, receipts, and release decisions |
| **Σ₀ Framework** | Mathematical proof that systems without feedback loops collapse; used to verify stability |
| **Doors** | Routing primitives where observations (quantum dust) flow between agents |
| **CSF** | Convergence-Fitted Searchable Archive for structured symbolic memory |
| **CADD** | Capture-Assess-Distill-Dock pipeline for moving material into CSF |
| **PCSF** | Provider Capacity Safety Frame for routing decisions based on load and privacy |
| **MCP** | Model Context Protocol for local tool surface + agent integration |
| **Monoworkstream** | One open PR per agent lane at a time (prevents conflicts, keeps CI clear) |
| **Autonomous Repair** | Health monitoring + graceful recovery without operator intervention |
| **Convergence Record** | Receipt appended for each decision: [claim, evidence, confidence, source] |

---

## Autonomous Systems

Keystone OS includes several autonomous systems that run without operator intervention:

### 1. Autonomous Repair (Health Monitoring)

**File:** `apps/lantern-garage/lib/server-health.js`

Runs every 30 seconds and monitors:
- Memory usage (500MB threshold → graceful reload)
- Request backlog (>50 in-flight → alert)
- Hung requests (>30s timeout → log warning)
- Circuit breakers for failing services

**Status endpoints:**
```bash
# Current health
curl http://localhost:4177/status/health

# Full orchestrator status
curl http://localhost:4177/status/orchestrator
```

### 2. Autonomous Deployment (Auto-Deploy)

**Script:** `C:\dev\deploy-stable-from-master.ps1` (Windows scheduled task `KeystoneAutoDeployStable`)

Runs every 5 minutes and:
1. Checks for new commits on origin/master
2. Merges non-destructively with `git merge --ff-only` (preserves uncommitted runtime data)
3. Restarts only if server-side code changed
4. Verifies `/api/convergence/health`; auto-rolls back to the last known-good commit if unhealthy
5. Logs the full deploy to `C:\dev\auto-deploy-stable.log`

See the [Auto-Deploy Infrastructure](#auto-deploy-infrastructure-2026-06-24) section above for details.

### 3. Convergence Routing (Deterministic Pattern Cache)

**File:** `apps/lantern-garage/lib/convergence-router.js`

Caches routing decisions and patterns to avoid external API calls:
- 120+ deterministic intent routes (the chat is now **one assistant** — no keyword persona routing; personas removed in #1664)
- >70% cache hit rate from day 1
- Deterministic: same input → same output (testable)
- Falls back to external providers only when no cache match

**Benefit:** Saves 60% tokens vs. direct API calls by caching learned patterns.

### 4. PR Watcher (Auto-Merge Resolver)

**File:** `apps/lantern-garage/lib/pr-watcher.js`

Polls GitHub every 3 minutes and:
- Checks if PR is ready to merge (all CI passing, no conflicts)
- Auto-merges with squash + branch deletion
- Records merge decisions to `data/deploy-history.jsonl`
- Never force-pushes or overrides branch protection

**Enable with:** `PR_WATCHER_ENABLED=1 node apps/lantern-garage/server.js`

---

## Testing and Validation

### Core Checks

```bash
# Node.js API tests
npm run test:api --prefix apps/lantern-garage

# Node.js UI tests (requires Playwright)
npm run test:ui --prefix apps/lantern-garage

# Python tests
python -m pytest tests/ -q --tb=short

# Type checking
make check-node  # Node.js syntax
make check-types # Python types (mypy)
```

### Continuous Integration

CI runs the **full** `pytest tests` suite with no `--ignore` excludes (the
anti-entropy and audit-chain suites pass; the Discord suites self-skip via
`importorskip` when their optional deps are absent). The canonical chat/MCP tool
surface is locked by a contract test (`tests/test_mcp_tool_parity.py` +
`tests/test_tool_capability_manifest.js`): the only source of truth is
`apps/lantern-garage/lib/tool-runner.js`, and the committed fallback manifest is
regenerated from it. After adding or removing a tool, regenerate the manifest so
the contract tests stay green:

```bash
echo '' | node scripts/tool-runner-bridge.js generate-manifest
```

### Convergence Validation

```bash
# Verify convergence agent fleet (36 slots)
python scripts/Test-ConvergenceAgentFleet.py

# Verify MCP connector
powershell -File .\scripts\Test-LanternMcpConnector.ps1

# Update internal RAG
powershell -File .\scripts\Update-InternalHouseRag.ps1
```

### Local Testing with Dev Preview

```bash
# Terminal 1: Stable server (master)
node apps/lantern-garage/server.js

# Terminal 2: Dev server (your branch, auto-reload)
npm run dev --prefix apps/lantern-garage

# Test UI at:
# http://127.0.0.1:4177 (stable)
# http://127.0.0.1:4178 (dev with your changes)
```

---

## Documentation Map

### For Agents (Start Here)

- **[AGENTS.md](AGENTS.md)** — Manifests, route map, delegate table, monoworkstream rules
- **[CLAUDE.md](CLAUDE.md)** — Agent-specific guidance, environment variables, hooks
- **[QUICKSTART.md](QUICKSTART.md)** — Full startup guide (dual-boot, autostart, config)

### For Operators

- **[docs/DREAM-JOURNAL-USER-GUIDE.md](docs/DREAM-JOURNAL-USER-GUIDE.md)** — How to use the Dream Journal
- **[docs/DREAM-JOURNAL-API-ENDPOINTS.md](docs/DREAM-JOURNAL-API-ENDPOINTS.md)** — Full API reference
- **[docs/EXPLORE-FEED.md](docs/EXPLORE-FEED.md)** — Explore page: PCSF-ranked single-pane content feed (as-built, API contract, limitations)
- **[AUTONOMOUS-REPAIR-GUIDE.md](AUTONOMOUS-REPAIR-GUIDE.md)** — Health monitoring, auto-repair, deployment control

### For Product & Members

- **[docs/KEYSTONE-PRODUCT.md](docs/KEYSTONE-PRODUCT.md)** — Keystone chat product definition (operator console for members) + serving contract (fast default / deep opt-in)
- **[docs/SIGMA0-OURO-CODER.md](docs/SIGMA0-OURO-CODER.md)** — the Σ₀ coding agent (sibling surface): ship changes a developer merges with confidence

### For Architects

- **[docs/CONVERGANCE-SIGMA0-BRIEFING.md](docs/CONVERGANCE-SIGMA0-BRIEFING.md)** — **START HERE** — Σ₀ framework, immutable North Star
- **[docs/ANTI-COLLAPSE-HARDENING.md](docs/ANTI-COLLAPSE-HARDENING.md)** — CSF-native defense-in-depth: how the loop resists collapse (proven vs heuristic), the hardening plan, red-team gaps (epic #764)
- **[docs/RESEARCH-CANON.md](docs/RESEARCH-CANON.md)** — Living references for Convergence 12 components
- **[docs/convergence-core-mapping.md](docs/convergence-core-mapping.md)** — How code aligns with architecture
- **[docs/TESSERACT-CONVERGENCE-LOOP.md](docs/TESSERACT-CONVERGENCE-LOOP.md)** — 20-step convergence with 4D status cube
- **[docs/CSF-FORMAT-SPECIFICATION.md](docs/CSF-FORMAT-SPECIFICATION.md)** — Convergence-Fitted Searchable format spec
- **[docs/PCSF-PROVIDER-CAPACITY-SAFETY-FRAME.md](docs/PCSF-PROVIDER-CAPACITY-SAFETY-FRAME.md)** — Capacity routing + fallback chains

### For Traders & Analysis

- **[docs/trading-api-reference.md](docs/trading-api-reference.md)** — 60+ Kalshi terminal endpoints
- **[docs/KALSHI-CIO-LIVE-TRADER.md](docs/KALSHI-CIO-LIVE-TRADER.md)** — Autonomous market observer (paper trading)
- **[experiments/](experiments/)** — Analysis scripts, tightband accuracy logs, regime detection

### Release & Deployment

- **[CHANGELOG.MD](CHANGELOG.MD)** — Release history with linked issues
- **[docs/REPO-CONTRACT.md](docs/REPO-CONTRACT.md)** — Scope + cleanup contract, archive migration
- **[docs/CLOUDFLARE-TUNNEL-DEPLOYMENT.md](docs/CLOUDFLARE-TUNNEL-DEPLOYMENT.md)** — Public HTTPS deployment (no port forwarding)

### Troubleshooting

- **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** — Common issues and solutions
- **GitHub Issues** — Search by label: `bug`, `p0`, `p1`, `convergence`, `agent-task`

---

## Contributing

### Before You Start

1. Read **[CLAUDE.md](CLAUDE.md)** (agent-specific rules)
2. Read **[AGENTS.md](AGENTS.md)** (PR lanes, monoworkstream)
3. Check **[CONTRIBUTING.md](CONTRIBUTING.md)** (full workflow)

### Quick Workflow

```text
1. Create branch (auto/issue-505 or claude/feature-name)
2. Make ONE logical change
3. Run tests locally
4. Commit with convergence record
5. Push and open PR
6. Wait for CI → auto-merge when green
```

### Golden Rules

- ✅ **Prefer small, reviewable changes** (one fix, one feature per PR)
- ✅ **Test locally before pushing** (run npm/pytest)
- ✅ **Update receipts/manifests** if you change scope
- ✅ **Link related issues** in PR description
- ✅ **Use convergence records** in commit messages
- ❌ **Don't break the monoworkstream** (wait for prior PR to merge)
- ❌ **Don't skip hooks or safety checks** (unless explicitly authorized)
- ❌ **Don't commit secrets** (.env, credentials, API keys)

---

## Privacy

Keystone OS is **local-first by design.**

- Dream journal data and local runtime receipts stay on your machine
- No telemetry or tracking built in
- External APIs (Claude, Gemini, etc.) only called when you explicitly configure them
- `.env` and `.env.local` are gitignored
- Private folders (`data/private/`, `data/wallet/`) never synced

**Configure API keys:**
```bash
# Create .env.local (not committed)
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local
echo "OPENAI_API_KEY=sk-..." >> .env.local
```

Or set in the UI settings drawer at runtime.

---

## License & Attribution

© 2026 Alex Place

Keystone OS is built with:
- **Node.js** — Web server + API
- **Python** — Convergence loop, MCP, memory
- **Claude / Gemini / OpenAI** — Multi-provider routing
- **Ollama** — Local model support
- **CSF/CADD** — Custom memory architecture

See [CONTRIBUTING.md](CONTRIBUTING.md) for contributor guidelines.

---

## Quick Links

- **GitHub:** https://github.com/alex-place/lantern-os
- **Live product (Unisona):** https://unisona.ai (legacy: https://lantern-os.net)
- **MCP Server:** https://mcp.lantern-os.net
- **Issues:** [github.com/alex-place/lantern-os/issues](https://github.com/alex-place/lantern-os/issues)
- **Contact:** open a GitHub issue
