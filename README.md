---
author: Alex Place
created: 2026-05-26
updated: 2026-06-20
---

# Keystone OS

<!-- Core CI / quality gates -->
[![CI](https://github.com/alex-place/lantern-os/actions/workflows/ci.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/ci.yml)
[![Automated Tests](https://github.com/alex-place/lantern-os/actions/workflows/automated-tests.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/automated-tests.yml)
[![CodeQL Advanced](https://github.com/alex-place/lantern-os/actions/workflows/codeql.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/codeql.yml)
[![CSF Rust](https://github.com/alex-place/lantern-os/actions/workflows/csf-rust.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/csf-rust.yml)
[![Code Review Gate](https://github.com/alex-place/lantern-os/actions/workflows/code-review-gate.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/code-review-gate.yml)

<!-- Convergence / repo-health gates -->
[![Convergence Validation](https://github.com/alex-place/lantern-os/actions/workflows/convergence-validation.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/convergence-validation.yml)
[![Convergence Manager](https://github.com/alex-place/lantern-os/actions/workflows/convergence-manager.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/convergence-manager.yml)
[![Smart Convergence Loop](https://github.com/alex-place/lantern-os/actions/workflows/smart-convergence-loop.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/smart-convergence-loop.yml)
[![Anti-Sprawl Gate](https://github.com/alex-place/lantern-os/actions/workflows/anti-sprawl.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/anti-sprawl.yml)
[![Monoworkstream Gate](https://github.com/alex-place/lantern-os/actions/workflows/monoworkstream-gate.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/monoworkstream-gate.yml)
[![Slop Check](https://github.com/alex-place/lantern-os/actions/workflows/slop-check.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/slop-check.yml)
[![OSS Repository Validation](https://github.com/alex-place/lantern-os/actions/workflows/oss-repo-validation.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/oss-repo-validation.yml)

<!-- Surface / integration / reporting -->
[![Static surface CI](https://github.com/alex-place/lantern-os/actions/workflows/static-surface-ci.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/static-surface-ci.yml)
[![Site Audit & A11y Tests](https://github.com/alex-place/lantern-os/actions/workflows/a11y-audit.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/a11y-audit.yml)
[![System Integration Validation](https://github.com/alex-place/lantern-os/actions/workflows/validate-system-integration.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/validate-system-integration.yml)
[![Validate Dream Journal](https://github.com/alex-place/lantern-os/actions/workflows/validate-dream-journal.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/validate-dream-journal.yml)
[![Orchestration challenge CI](https://github.com/alex-place/lantern-os/actions/workflows/orchestration-challenge-ci.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/orchestration-challenge-ci.yml)
[![Report Generation](https://github.com/alex-place/lantern-os/actions/workflows/report-generation.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/report-generation.yml)

<!-- Release / deploy -->
[![Deploy](https://github.com/alex-place/lantern-os/actions/workflows/deploy.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/deploy.yml)
[![Release](https://github.com/alex-place/lantern-os/actions/workflows/release.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/release.yml)
[![Release provenance](https://github.com/alex-place/lantern-os/actions/workflows/release-provenance.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/release-provenance.yml)
[![MCP Tunnel Canary](https://github.com/alex-place/lantern-os/actions/workflows/mcp-tunnel-canary.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/mcp-tunnel-canary.yml)

**Keystone OS** (formerly Lantern OS) is a persistent local-first reasoning system with autonomous deployment, evidence-grounded convergence, and operator-controlled agent lanes.

It combines a web app, local memory systems, MCP tooling, multi-provider routing, and a structured convergence loop so work moves from raw context → validated artifacts → archived evidence with clear receipts and ground-truth verification.

**Current state:** Σ₀ (Sigma-Zero) verification framework live (2026-06-14) · 1.6 dashboards shipped (2026-06-16) · Keystone serving split into **fast-cached default + deep Σ₀ opt-in** (`OURO_NATIVE=1`, 2026-06-18) · native Σ₀ LoopLM + standing benchmark landed (#756). The product surface is **[Keystone Chat](docs/KEYSTONE-PRODUCT.md)** — the member's operator console for their own copy of Keystone OS.

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
3. [Release Status: v1.6](#release-status-v16)
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
| **Dream Journal** | ✅ Live | Freeform chat, local storage, JSONL export, PWA mode |
| **1.6 Trader Dashboard** | ✅ Live (2026-06-16) | Real-time market data, position management, convergence metrics |
| **1.6 Creator Dashboard** | ✅ Live (2026-06-16) | Dream journal publishing, markdown editor, template system |
| **Σ₀ Verification** | ✅ Live | Evidence-grounded claims, confidence scoring, convergence records |
| **Σ₀ Game Mode** | ✅ Live | Three Doors with convergence evidence chain |
| **Σ₀ Story Mode** | ✅ Live | Narrative routing through convergence loop |
| **Σ₀ Teach Mode** | ✅ Live | Knowledge base verification with ground-truth validation |
| **Autonomous Repair** | ✅ Live | Memory leak detection, graceful recovery, health monitoring |
| **Auto-Deployment** | ✅ Live | Hourly master branch pulls, pre-deploy tests, automatic rollback |
| **Convergence Routing** | ✅ Live | 120+ Keystone intent routes, >70% cache hit rate, deterministic local routing |
| **Multi-Provider Fallback** | ✅ Live | Claude → OpenAI → Gemini → Grok → Local Ollama, with capacity gates |
| **[lantern-sigma0-coder](docs/LANTERN-SIGMA0-CODER.md)** | ✅ Live (2026-06-18) | Local Σ₀ coding LoRA fine-tuned on past Claude sessions; Ollama-served, leaderboard-routed, continually retrained |
| **CSF Memory Archive** | ✅ Live | Symbolic searchable format, tiered promotion (trace → skill) |
| **MCP Server** | ✅ Live | Local tool surface, agent registration, OAuth2 protected endpoint |
| **Discord Integration** | ✅ Live | Bot with convergence-aware responses |

---

## Release Status: v1.6

**1.6 Dashboard Sprint** completed (2026-06-16):
- ✅ Trader Dashboard MVP (real-time data, position management, win-rate metrics)
- ✅ Creator Dashboard MVP (markdown editor, Dream Journal publishing, templates)
- ✅ Σ₀ modes fully integrated (game, story, teach with evidence chains)
- ✅ Autonomous repair system deployed (health monitoring + auto-rollback)
- ✅ 5 stalled PRs merged to master (consolidated in commit 2b2b4950)

**Remaining 1.6 work:**
- Testing & verification (#619)
- Local Ollama coder agent rebuild with Σ₀ grounding (#628-#632)
- Monoworkstream enforcement in CI (#637-#640)

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

## Getting Started

### Fastest Start (30 seconds)

Open in browser:
```text
https://lantern-os.net
```

(Requires internet; no local setup needed)

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

### Monoworkstream Rule (Critical)

**Each agent gets ONE open PR lane at a time.**

```
# CORRECT: Wait for PR #1 to merge before opening PR #2
git checkout -b auto/issue-505  # First PR
# ... make changes, open PR #505 ...
# WAIT: PR #505 merges to master
git checkout -b auto/issue-506  # Second PR
# ... make changes, open PR #506 ...

# WRONG: Open PR #505, then immediately open PR #506
# (Creates merge conflicts, violates monoworkstream)
```

**Why?** Each agent lane is guaranteed to have one open change at a time. This prevents cascading merge conflicts and keeps CI feedback clear.

**Enforcement:**
- Git hooks warn if you violate the rule locally
- CI will block PR merge if another PR from the same agent is open
- See [AGENTS.md](AGENTS.md) for lane assignments

### PR Lane Assignments

| Agent | Lane | Example Branch |
|-------|------|-----------------|
| Claude (you) | `claude/` | `claude/home-redesign` |
| Gemini | `gemini/` | `gemini/add-features` |
| Auto-issues | `auto/` | `auto/issue-505` |
| Human | anything else | `main-branch-fix`, `hotfix/...` |

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

**PRs merge automatically when:**
- ✅ All CI checks pass (lint, type, tests)
- ✅ No merge conflicts
- ✅ Branch up-to-date with master
- ✅ No other open PRs from same agent

**If auto-merge fails:**
- Resolve merge conflicts: `git rebase origin/master`
- Rerun tests: `npm run test:api --prefix apps/lantern-garage`
- Force-push: `git push -f origin <branch>`

See [#637](https://github.com/alex-place/lantern-os/issues/637) for resolution procedures.

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
| Auto-Deploy | Node.js | 4177 | Hourly master pulls + rollback |

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

**File:** `apps/lantern-garage/lib/auto-deploy.js`

Runs hourly and:
1. Checks for new commits on origin/master
2. Runs pre-deploy tests
3. Verifies health post-deployment
4. Auto-rolls back if tests fail
5. Logs all decisions to `data/deploy-history.jsonl`

**Configuration:**
- `LANTERN_AUTO_DEPLOY=true` (default) — enable auto-deploy
- `LANTERN_UPDATE_CHECK_MS=3600000` (default: 1 hour)

### 3. Convergence Routing (Deterministic Pattern Cache)

**File:** `apps/lantern-garage/lib/convergence-router.js`

Caches routing decisions and patterns to avoid external API calls:
- 120+ Keystone intent routes (6 agents × 20+ intents each)
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
- **[AUTONOMOUS-REPAIR-GUIDE.md](AUTONOMOUS-REPAIR-GUIDE.md)** — Health monitoring, auto-repair, deployment control

### For Product & Members

- **[docs/KEYSTONE-PRODUCT.md](docs/KEYSTONE-PRODUCT.md)** — Keystone chat product definition (operator console for members) + serving contract (fast default / deep opt-in)
- **[docs/LANTERN-SIGMA0-CODER.md](docs/LANTERN-SIGMA0-CODER.md)** — the Σ₀ coding agent (sibling surface): ship changes a developer merges with confidence

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
- **Live Demo:** https://lantern-os.net
- **MCP Server:** https://mcp.lantern-os.net
- **Issues:** [github.com/alex-place/lantern-os/issues](https://github.com/alex-place/lantern-os/issues)
- **Contact:** open a GitHub issue
