# Lantern OS

[![CI](https://github.com/alex-place/lantern-os/actions/workflows/ci.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/ci.yml)
[![Deploy](https://github.com/alex-place/lantern-os/actions/workflows/deploy.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/deploy.yml)
[![Validate Dream Journal](https://github.com/alex-place/lantern-os/actions/workflows/validate-dream-journal.yml/badge.svg)](https://github.com/alex-place/lantern-os/actions/workflows/validate-dream-journal.yml)

Lantern OS is a local-first operating cockpit for dream journaling, symbolic memory, agent-assisted workflows, and evidence-backed convergence.

It combines a web app, local memory systems, MCP tooling, provider fallback, and a structured convergence loop so work can move from raw context to validated artifacts with clear receipts.

Current focus: Dream Journal Orion Edition, local/private agent workflows, and professional repo consolidation.

---

## ⚠️ Required Reading for All Agents

- **[SECURITY.md](SECURITY.md)** — Critical security fixes, vulnerability guidelines, best practices
- **[SKILLS.md](SKILLS.md)** — Available capabilities, personas, providers, integration points
- **[CLAUDE.md](CLAUDE.md)** — Agent-specific guidance and instructions

## Table of Contents

1. [Overview](#overview)
2. [Current Capabilities](#current-capabilities)
3. [Dream Journal and Personas](#dream-journal-and-personas)
4. [Getting Started](#getting-started)
5. [Architecture](#architecture)
6. [Core Concepts](#core-concepts)
7. [CSF Memory and Door State](#csf-memory-and-door-state)
8. [PCSF Provider Capacity Fallback](#pcsf-provider-capacity-fallback)
9. [Convergence and Receipts](#convergence-and-receipts)
10. [Memory, RAG, and CSF/CADD](#memory-rag-and-csfcadd)
11. [MCP and Agent Runtime](#mcp-and-agent-runtime)
12. [Run Locally](#run-locally)
13. [Testing and Validation](#testing-and-validation)
14. [Documentation Map](#documentation-map)
15. [Planned Documentation Migration](#planned-documentation-migration)
16. [Contributing](#contributing)
17. [Privacy](#privacy)

---

## Overview

Lantern OS is built around a simple operating model:

```text
capture context
  -> classify work
  -> route through convergence
  -> validate with receipts
  -> store evidence in RAG / CSF
  -> promote, hold, or archive
```

The project is intentionally local-first. Runtime data, dream journal entries, local receipts, and private operational state are designed to stay on the operator machine unless explicitly exported.

**Versioning:** Lantern OS uses auto-versioning. Each commit bumps the patch version, and deployments add ISO timestamps to build identifiers. Version info is in `apps/lantern-garage/version.json` (auto-generated on update) and `CHANGELOG.MD` (auto-updated with commit messages).

The README is intended as the public-facing entry point. Detailed runtime, convergence, and archive policies live in the linked docs and manifests.

---

## Current Capabilities

| Area | Current Capability |
|---|---|
| Dream Journal | Freeform chat-style dream journal with local browser storage, JSONL export, and multi-turn chat flow. |
| Lantern Garage | Node.js web server for the Dream Journal UI, API routes, static assets, and installable PWA surface. |
| Persona Routing | Symbolic personas route messages through the same provider/backend pipeline with different system prompts. |
| Convergence Loop | 20-step tesseract convergence with 4D status cube navigation, future state projection, and Bayesian belief updates. |
| Agent Fleet Design | 36-slot convergence-agent matrix with a 64-worker elastic target as a planning and receipt contract. |
| CSF/CADD | Symbolic memory/archive path for structured, searchable, convergence-fitted data. |
| Internal RAG House | Source-linked evidence index with paths, hashes, and evidence classes. |
| MCP Connector | Local-first connector path for verifying tools, endpoints, and agent-facing runtime surfaces. |
| Provider Gateway | Multi-provider routing for local and external model access where configured. |
| PCSF | Provider Capacity Safety Frame for capacity class, fallback routing, and provider/local claim clarity. |
| Discord Bot | Optional Discord integration using the same broader convergence and access model. |

---

## Dream Journal and Personas

The Dream Journal is the main user-facing surface. It is designed for conversational capture instead of rigid forms.

| Surface | Description |
|---|---|
| Dream Journal chat | Freeform local journaling flow for dreams, memories, symbolic material, and follow-up reflection. |
| Local export | JSONL-style export path for portable review and future CSF/CADD ingestion. |
| PWA mode | Browser-installable surface with offline-friendly behavior where supported. |
| Provider routing | Uses configured local or external providers through the unified connector. |

Lantern personas provide different interaction modes over the same backend pipeline.

| Persona | Routing cues | Role |
|---|---|---|
| Keystone | truth, pattern, anchor | Grounded integration and direct technical review. |
| Waterfall | water, reconnection, patient reflection | Gentle reflective mode. |
| Xenon | spacecraft, navigation, exploration | Exploratory and collaborative mode. |
| Blinkbug | static, glitch, chaos | Creative divergent mode. |
| Comet Leap | trajectory, momentum, flourishing | Fast synthesis and execution framing. |
| Founder | wish, protection, lantern | Protective operator-oriented framing. |

---

## Getting Started

### One-line setup from Claude Code

If you are running this from a Claude Code session, this single command registers your API keys, installs deps, runs the convergence loop, and starts the server:

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/setup-claude.ps1
```

The script reads your active `ANTHROPIC_API_KEY` from the Claude Code environment automatically (no manual copy-paste). Pass keys explicitly if running outside Claude:

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/setup-claude.ps1 `
  -AnthropicKey sk-ant-... `
  -GeminiKey AQ.Ab8... `
  -OpenAIKey sk-...
```

Or pull straight from GitHub without cloning:

```powershell
irm https://raw.githubusercontent.com/alex-place/lantern-os/master/scripts/setup-claude.ps1 | iex
```

### Manual setup

For dev mode with auto-restart:

```bash
npm run dev --prefix apps/lantern-garage
```

Or for a one-shot start:

```bash
npm start --prefix apps/lantern-garage
```

Open locally:

```text
http://127.0.0.1:4177
```

Or access publicly (via Cloudflare Tunnel):

```text
https://lantern-os.net
```

The longer local setup, optional MCP server, optional Discord bot, and validation commands are listed below.

---

## Architecture

| Path | Purpose |
|------|---------|
| [`apps/lantern-garage/server.js`](apps/lantern-garage/server.js) | Main Node.js entry point — loads routes, deps, starts HTTP server |
| [`apps/lantern-garage/routes/`](apps/lantern-garage/routes/) | Domain API route handlers (dream, dreamer, status, rag, operator, files, surfaces) |
| [`apps/lantern-garage/lib/`](apps/lantern-garage/lib/) | Chat, streaming, storage, and PCSF helpers |
| [`apps/lantern-garage/public/`](apps/lantern-garage/public/) | Browser UI (dream-chat.html, index.html), PWA manifest |
| [`src/convergence_io_engine.py`](src/convergence_io_engine.py) | Convergence inspection and orchestration — `health`, `loop`, `inspect`, `converge` |
| [`src/unified_agent_connector.py`](src/unified_agent_connector.py) | Unified agent greet/health/inspect connector |
| [`src/mcp_server/`](src/mcp_server/) | MCP server and local agent tool surface (port 8771) |
| [`apps/lantern-garage/lib/csf-memory.js`](apps/lantern-garage/lib/csf-memory.js) | Node.js CSF memory reader — loads long-term memory, ingest docs, and door state into chat context |
| [`src/csf/`](src/csf/) | CSF memory/archive components |
| [`src/discord_lounge_bot/`](src/discord_lounge_bot/) | Discord integration |
| [`data/pcsf/`](data/pcsf/) | Provider capacity and agent state files |
| [`manifests/`](manifests/) | Contracts, validation receipts, repo state, gates |
| [`csf/ingest/`](csf/ingest/) | CSF/CADD ingest queue — each file is a ready-to-implement task spec |
| [`docs/`](docs/) | User, architecture, connector, and operating docs |
| [`tests/`](tests/) | Node.js and Python tests |

---

## Core Concepts

| Concept | Role |
|---|---|
| Convergence Loop | The operating and release-decision method. |
| Convergence Agent Fleet | A 36-slot planning, dispatch, and receipt matrix based on the 12-step loop. |
| Action Pooling | A method for grouping similar low-risk work into typed queues. |
| MCP Connector | The local verification surface for agent tools and runtime capability. |
| Internal RAG House | A source-linked evidence index for repo files, hashes, and receipts. |
| CSF | Convergence-Fitted Searchable Archive for structured symbolic data. |
| CADD | Capture, Assess, Distill, Dock pipeline for moving material into CSF. |
| PCSF | Provider Capacity Safety Frame for routing capacity and fallback decisions. |
| Doors | Σ₀ routing primitives where quantum dust (observations) flows between agents. See **Σ₀ Paradoxes** below. |
| Quantum Dust | Measurements, logs, user input, and convergence signals. Dust must flow through doors and be observed to prevent collapse. |

---

## CSF Memory and Door State

The Dream Chat uses a layered memory system that feeds context into every LLM call:

| Layer | Source | Loaded by |
|---|---|---|
| Recent dreams | `data/dream_journal/*.jsonl` (last 12 entries) | [`lib/dreamer-store.js`](apps/lantern-garage/lib/dreamer-store.js) |
| CSF memory records | `data/csf_memory/**/*.jsonl` (tiered: trace → anchor → entity → skill) | [`lib/csf-memory.js`](apps/lantern-garage/lib/csf-memory.js) |
| CSF ingest docs | `csf/ingest/*.md` (elephant doors, convergence plans, lore) | [`lib/csf-memory.js`](apps/lantern-garage/lib/csf-memory.js) |
| Door state | `data/dream_journal/door_state.json` (offered doors + user choices) | [`lib/csf-memory.js`](apps/lantern-garage/lib/csf-memory.js) |
| Symbol mesh | Co-occurrence pairs extracted from recent dreams | [`lib/stream-chat.js`](apps/lantern-garage/lib/stream-chat.js) |
| Conversation history | Last 6 turns threaded into API calls | [`lib/stream-chat.js`](apps/lantern-garage/lib/stream-chat.js) |

Three Doors are generated by the LLM at the end of every response as `[DOORS: A | B | C]`. When the user clicks a door suggestion, the choice is persisted to `door_state.json` via `POST /api/dream/door-choice` and loaded back into future prompts so the model remembers which doors were offered and chosen.

The CSF Memory Engine (`src/csf/memory_engine.py`) provides the Python-side tiered promotion flow: trace → correction → anchor → entity → relation → ritual → skill → export. The Node.js reader (`lib/csf-memory.js`) reads these records with a 10-second TTL cache for low-overhead context loading during streaming.

---

## Σ₀ Collapse Certificate & System Paradoxes

On **2026-06-14**, the Σ₀ Collapse Certificate was applied to Lantern OS. The framework predicts that systems without *persistent external grounding* collapse or diverge. Analysis of the codebase revealed **five critical paradoxes** where measurements exist but observation loops are broken:

### The Five Σ₀ Paradoxes

| Paradox | Location | Problem | Impact |
|---------|----------|---------|--------|
| **Agent Selection Hard Loop** | `dream-chat.js:198` | Keystone always selected; message parameter ignored | Ungrounded routing decision |
| **Provider Fallback Divergence** | `provider-router.js:110` | Attempt logs written but no feedback loop; no escalation gate | Exponential token cost, unbounded retries |
| **Convergence Route Staleness** | `convergence-router.js:82` | Keyword scores computed fresh but cache never validates against new state | Degenerate frozen routing |
| **Memory Truncation Unmeasured** | `stream-chat.js:42` + `csf-memory.js:62` | History truncated deterministically without quality metrics | Silent information loss, degraded predictions |
| **Router Gate Ineffectiveness** | `router-gate.js` + `dream-chat.js:600` | Escalation decided but conditionally ignored; decision authority severed | Infinite unmeasured solution space |

### Root Cause: "Observable But Unobserved"

All five paradoxes share a common pattern:

```
Measurement exists → Decision made → Outcome logged → Loop broken
                                         ↑____________↑
                                    (dust doesn't flow back)
```

Dust (observations) flows one-way. Systems measure, decide, and log—but never feed outcomes back to adjust routing. Each subsystem operates in isolation, creating an ungrounded mesh.

### What This Means

Per the Σ₀ framework:
- **Without feedback loops**: System predictive power degrades, infinities accumulate, choices freeze into degenerate fixed points
- **With feedback loops**: Dust flows through doors, each measurement influences routing, system stays stable

### Current Status

- ✓ **Theory validated in software** (`src/sigma0_framework_test.py`) — simulates collapse dynamics
- ✓ **Paradoxes documented** — see `docs/SIGMA0-COLLAPSE-PARADOXES.md` and GitHub issues #XX–#XX
- ⚠️ **Fixes pending** — each paradox requires closing one observation loop

### Next Steps

1. For each paradox, create a feedback pathway where dust observations influence routing
2. Validate that the fix prevents collapse (run stress tests)
3. Document the pattern so future features don't recreate the same ungroundedness

See [AGENTS.md - Doors & Quantum Dust](#doors--quantum-dust-σ₀-routing-primitives) for the measurement checklist.

### Planned: Convergence IO Chat Bridge

The Convergence IO engine (`src/convergence_io/engine.py`) orchestrates provider routing with capability gates, provenance recording, and negative authority profiles. The planned bridge will:

1. Replace direct `readRecentDreams()` calls with `ConvergenceIO.route_chat()` for unified routing
2. Feed CSF memory tiers (anchor, entity, skill) into the LLM context window with priority ordering
3. Use the PCSF fallback chain to select providers based on memory load (lightweight prompts → local Ollama, heavy context → Gemini/Claude)
4. Record every door choice as an AAPF provenance entry for auditability

---

## PCSF Provider Capacity Fallback

PCSF means **Provider Capacity Safety Frame**.

PCSF is the project’s capacity and fallback layer. It keeps local, private, server-side, and external-provider work clearly labeled.

Lantern OS can operate across several capacity lanes:

| Capacity Lane | Description |
|---|---|
| Local operator machine | Local scripts, repo checks, browser storage, local services, and local model endpoints. |
| Private orchestrator / MCP | Registered local agent slots, tool descriptors, dispatch gates, and local runtime receipts. |
| Server-farm candidate lane | Inventoried machines, local model endpoints, storage, networking, and runtime health receipts. |
| Provider-backed lane | External AI/API services, CI runners, hosted tooling, and other metered or account-backed services. |
| Manual operator lane | Human approval, physical actions, account actions, publishing, and hardware changes. |

The PCSF rule is:

```text
Describe capacity by evidence class, source, privacy boundary, and fallback path.
```

Capacity-sensitive receipts should use fields like:

```json
{
  "generatedAt": "...",
  "capacityClass": "designed_capacity",
  "provider": "local",
  "metered": false,
  "privacyBoundary": "internal",
  "localProof": "path-or-not_observed",
  "providerProof": "path-or-citation-or-not_used",
  "fallbackUsed": false,
  "claimBoundary": "design_or_validated_or_live"
}
```

Provider-backed work is labeled separately from local/offline work. Local/offline work is treated as internal capacity bounded by hardware, queue time, storage, network, power, thermals, maintenance, and operator policy.

---

## Convergence and Receipts

Lantern OS uses a 12-step convergence loop:

1. Inspect current repo state.
2. Identify source repos and dirty state.
3. Read manifests and open issues.
4. State the next safest objective.
5. Retire old surfaces or label them clearly.
6. Map claims to evidence.
7. Classify capability, boundary, and rollback path.
8. Run the cheapest relevant validation checks.
9. Fix the first 2–4 actionable failures.
10. Re-run validation.
11. Record evidence and remaining blockers.
12. Promote, hold, or reject artifacts.

The convergence-agent design maps those 12 steps into a 36-slot matrix:

```text
12 convergence steps x 3 review roles = 36 ring slots
```

Each convergence step should produce a receipt containing:

```json
{
  "step": 1,
  "stepName": "Inspect current repo state",
  "primaryAgent": "Repo-state inspector",
  "backupA": "Git/status verifier",
  "backupB": "File-surface verifier",
  "evidence": [],
  "claims": [],
  "boundaries": [],
  "validation": "pass | fail | held | not_run",
  "rollback": "short rollback path",
  "nextAction": "smallest useful next move"
}
```

---

## Memory, RAG, and CSF/CADD

Lantern OS uses multiple memory and evidence layers.

| Layer | Purpose |
|---|---|
| Browser/local app storage | Local Dream Journal and UI state. |
| JSONL exports | Portable structured event and journal data. |
| Internal RAG House | Source-linked repo evidence, paths, hashes, and index files. |
| CSF | Searchable, convergent, symbolic archive format for structured data. |
| CADD | Capture, Assess, Distill, Dock pipeline for moving material into CSF. |

CADD flow:

```text
Capture
  -> Assess
      -> Distill
          -> Dock
```

A typical receipt flow:

```text
convergence receipt
  -> validation JSON
      -> Internal RAG index
          -> CSF/CADD archive candidate
              -> release or migration decision
```

---

## MCP and Agent Runtime

Lantern OS includes an MCP server for local tool and agent integration.

**Access:**
- **Local (development):** `http://127.0.0.1:8771`
- **Public (production via Cloudflare Tunnel):** `https://mcp.lantern-os.net`

The MCP path is used to verify:

| Runtime Surface | Purpose |
|---|---|
| MCP server health | Confirms the local server is reachable. |
| Tool discovery | Captures the tools actually exposed by the runtime. |
| Agent registration | Tracks callable agent slots and heartbeat status. |
| Dispatch gate | Keeps runtime dispatch operator-controlled. |
| Receipts | Records proof of runtime state and task results. |

The orchestrator dependency currently centers on named agent slots such as Claude, Codex, Gemini, and GPT, each of which must register, discover tools, bind context, and remain callable through the operator-controlled dispatch path.

OAuth2-protected MCP endpoint available at `https://mcp.lantern-os.net/oauth` with support for Google, GitHub, and Discord authentication.

---

## Public Deployment (Cloudflare Tunnel)

Lantern OS can be accessed publicly via **Cloudflare Tunnel** without port forwarding or router changes:

| URL | Service |
|-----|---------|
| `https://lantern-os.net` | Dream Journal chat UI + API |
| `https://mcp.lantern-os.net` | MCP server (public) |
| `https://mcp.lantern-os.net/oauth` | MCP server (OAuth2 protected) |

For setup details, see [`docs/CLOUDFLARE-TUNNEL-DEPLOYMENT.md`](docs/CLOUDFLARE-TUNNEL-DEPLOYMENT.md).

---

## Run Locally

See [`QUICKSTART.md`](QUICKSTART.md) for the full startup guide. Below is the condensed version.

Prerequisites:

```bash
node --version   # v18+
python --version # v3.10+
```

Install dependencies:

```bash
npm install --prefix apps/lantern-garage
python -m pip install -r requirements.txt
```

### Start the Core Web Server (Required)

```bash
node apps/lantern-garage/server.js
```

Open locally: `http://127.0.0.1:4177`

Or access publicly: `https://lantern-os.net`

### Configure AI Providers (Optional)

Add keys via the settings drawer in the chat UI, or create `.env.local`:

```bash
echo "GEMINI_API_KEY=your_key" > apps/lantern-garage/.env.local
```

Supported providers: Gemini, Claude, OpenAI, Grok, Ollama (local).

### Optional Services

| Service | Command | Port | Public Route |
|---|---|---|---|
| MCP server | `python src/mcp_server/server.py` | 8771 | `https://mcp.lantern-os.net` |
| OAuth2 MCP | `python src/mcp_server/server_oauth.py` | 8772 | `https://mcp.lantern-os.net/oauth` |
| Convergence loop | `python src/convergence_io_engine.py loop` | — | — |
| Discord bot | `python src/discord_lounge_bot/bot.py` | — | — |

### Full Stack Startup

Terminal 1 — Web server:
```bash
node apps/lantern-garage/server.js
```

Terminal 2 — MCP server:
```bash
python src/mcp_server/server.py
```

Terminal 3 — Convergence loop:
```bash
python src/convergence_io_engine.py loop
```

---

## Testing and Validation

Core checks:

```bash
node tests/test_dream_journal_api.js
node tests/test_dream_chat_multiturns.js
npm run validate --prefix apps/lantern-garage
```

Python checks:

```bash
python -m pytest tests/ -q --tb=short
```

Convergence fleet count validation:

```bash
python scripts/Test-ConvergenceAgentFleet.py --write-json manifests/validation/CONVERGENCE-FLEET-LATEST.json
```

MCP connector validation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-LanternMcpConnector.ps1
```

Internal RAG update:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Update-InternalHouseRag.ps1
```

---

## Documentation Map

| Document | Purpose |
|---|---|
| [AGENTS.md](AGENTS.md) | **Start here for agents** — manifests, route map, delegate table, monoworkstream rules |
| [QUICKSTART.md](QUICKSTART.md) | Full startup guide — turn on every service |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development workflow, branch model, and repo rules |
| [CHANGELOG.MD](CHANGELOG.MD) | Release history |
| [docs/DREAM-JOURNAL-USER-GUIDE.md](docs/DREAM-JOURNAL-USER-GUIDE.md) | Dream Journal user guide |
| [docs/DREAM-JOURNAL-QUICKSTART.md](docs/DREAM-JOURNAL-QUICKSTART.md) | Dream Journal quick start |
| [docs/DREAM-JOURNAL-API-ENDPOINTS.md](docs/DREAM-JOURNAL-API-ENDPOINTS.md) | Full API endpoint reference |
| [docs/CONVERGENCE-LOOP.md](docs/CONVERGENCE-LOOP.md) | Original 12-step convergence operating method |
| [docs/TESSERACT-CONVERGENCE-LOOP.md](docs/TESSERACT-CONVERGENCE-LOOP.md) | **20-step tesseract convergence** — 4D status cube, future projection, Bayesian beliefs |
| [manifests/CONVERGENCE-LOOP-AGENT-FLEET.md](manifests/CONVERGENCE-LOOP-AGENT-FLEET.md) | 36-slot convergence-agent design and receipt contract |
| [manifests/dream-journal-v1-agent-slots.json](manifests/dream-journal-v1-agent-slots.json) | Active work queue with priority + description |
| [docs/MCP-CONNECTOR.md](docs/MCP-CONNECTOR.md) | Local-first MCP connector and safety contract |
| [docs/LANTERN-ORCHESTRATOR-DEPENDENCY.md](docs/LANTERN-ORCHESTRATOR-DEPENDENCY.md) | Agent slot registration, dispatch gate, and orchestrator dependency |
| [docs/ACTION-POOLING-AND-BATCHING.md](docs/ACTION-POOLING-AND-BATCHING.md) | Work pooling and batching method |
| [docs/CSF-FORMAT-SPECIFICATION.md](docs/CSF-FORMAT-SPECIFICATION.md) | CSF archive format specification |
| [caad/README.md](caad/README.md) | CADD (Capture, Assess, Distill, Dock) spec overview |
| [caad/dollhouse-csf-upgrade.md](caad/dollhouse-csf-upgrade.md) | CADD intake flow for CSF archives |
| [docs/PUBLIC-REPORT-EVIDENCE-BOUNDARY.md](docs/PUBLIC-REPORT-EVIDENCE-BOUNDARY.md) | Evidence and claim-labeling guidance for reports |
| [docs/REPO-CONTRACT.md](docs/REPO-CONTRACT.md) | Repository scope and cleanup contract |
| [docs/CLOUDFLARE-TUNNEL-DEPLOYMENT.md](docs/CLOUDFLARE-TUNNEL-DEPLOYMENT.md) | Public deployment via Cloudflare Tunnel (HTTPS, no port forwarding) |
| [docs/SIGMA0-COLLAPSE-CERTIFICATE.md](docs/SIGMA0-COLLAPSE-CERTIFICATE.md) | **Σ₀ Collapse Certificate** — Lyapunov-contraction theorem (scoped to normal A), the Σ₀ trigger, and four ground-truth-verified experiments |
| [docs/sigma0-collapse-certificate.tex](docs/sigma0-collapse-certificate.tex) | LaTeX source for the Σ₀ Collapse Certificate (typesetting / print) |
| [docs/SIGMA0-QUANTUM-RELATIVITY-ANALYSIS.md](docs/SIGMA0-QUANTUM-RELATIVITY-ANALYSIS.md) | Companion essay — QM/GR mapping, explicitly framed as metaphor, not a physics result |

---

## Planned Documentation Migration

The repository is being consolidated so SCM contains source code, tests, deployable scripts, active manifests, validation receipts, and code-facing documentation.

Historical packets, large generated artifacts, screenshots, narrative archives, old planning bundles, and non-runtime evidence collections are migrated to Google Drive.

**See [`docs/REPO-CONTRACT.md`](docs/REPO-CONTRACT.md) for the full archive migration process**, including:
- What to archive (reports, manifests, skills, surfaces, large PDFs)
- How to run `scripts/Invoke-ArchiveCommonsBatch.ps1`
- Google Drive folder naming conventions
- Rules for safe deletion after upload confirmation

Quick summary:

```powershell
# Step 1: Prepare archive bundles
powershell -File .\scripts\Invoke-ArchiveCommonsBatch.ps1

# Step 2: Upload dated folders to Google Drive "Lantern-OS-Archive"
# Step 3: Delete local copies after confirming upload
# Step 4: Commit cleaned archive/ state
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

Quick workflow:

```text
branch from master
  -> make one logical change
      -> run relevant validation
          -> update receipts/manifests if needed
              -> open reviewable PR
```

Before adding new files, check `docs/REPO-CONTRACT.md` and prefer the smallest durable surface that helps ship or validate the product.

---

## Privacy

Lantern OS is local-first. Dream journal data and local runtime receipts are designed to remain on the operator machine unless explicitly exported.

Secrets, API keys, local credentials, private folders, and personal runtime data should remain outside source control. Use local `.env` files and gitignored runtime directories for private configuration.
