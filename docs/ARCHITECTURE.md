---
author: Alex Place
created: 2026-06-23
updated: 2026-06-26
status: current
supersedes: docs/ARCHITECTURE-AUDIT-2026-06-13.md
---

# Keystone OS — Architecture (Current State)

**Canonical "what the system *is* today" snapshot.** This document records *what is true now*;
the [ADRs](adr/README.md) record *why* it became that way. Every important claim below carries
evidence (`file:line` / commit / PR) per the Σ₀ External Reality Rule. Where the code and the
intent diverge, that is called out in [§9 Known divergences](#9-known-divergences--debt) rather
than papered over.

> Supersedes the dated [ARCHITECTURE-AUDIT-2026-06-13.md](ARCHITECTURE-AUDIT-2026-06-13.md).
> Companion docs: [CODEMAP.md](CODEMAP.md) (feature/status roadmap),
> [convergence-core-mapping.md](convergence-core-mapping.md) (code → core-object mapping),
> [CONVERGANCE-SIGMA0-BRIEFING.md](CONVERGANCE-SIGMA0-BRIEFING.md) (immutable North Star).

---

## 1. The thesis in one paragraph

Keystone OS is a **persistent, local-first reasoning system** for a single developer (Alex Place).
The whole product is **one loop** — `Observe → Remember → Reason → Act → Verify → Converge` — over
**four objects**: Memory, Task, Tool, and Convergence Record. Models are interchangeable plug-ins;
learning is **retrieval + experience** (append-only memory), never weight modification. A Node.js
web server is the cockpit; a Python "Convergence Core" is the formal kernel; everything else is an
implementation of one loop stage.

---

## 2. System context & entrypoints

| Surface | Entrypoint | Bind | Notes |
|---|---|---|---|
| Local web server | [`apps/lantern-garage/server.js`](../apps/lantern-garage/server.js) | `127.0.0.1:4177` | Default; loopback only (`server.js:69-70`) |
| Cloud (Railway) | [`apps/lantern-garage/cloud-server.js`](../apps/lantern-garage/cloud-server.js) | `0.0.0.0:$PORT` | 7-line shim: sets `PORT` so `server.js` binds public |
| Dev (hot-reload) | same server, port **4178** | `127.0.0.1:4178` | Dual-boot; current branch worktree |
| Static UI | `gh-pages` branch (GitHub Actions) | — | Source in `apps/lantern-garage/public/` |
| MCP server | [`src/mcp_server/server.py`](../src/mcp_server/server.py) | `:8771` | Spawned by `server.js:307` |
| MCP OAuth | `src/mcp_server/server_oauth.py` | `:8772` | Spawned by `server.js:331` |
| Trader dashboard | (child process) | `:5050` | Spawned by `server.js:357` |

The same `server.js` is the **single Node entrypoint** for local and cloud; the host is chosen at
startup — `process.env.PORT ? "0.0.0.0" : "127.0.0.1"` ([`server.js:70`](../apps/lantern-garage/server.js)).
Production-without-a-real-`SESSION_SECRET` is guarded (`server.js:186`).

**Dual-boot topology:** ports 4177 (stable/master) and 4178 (dev/current branch) are served from
*separate git worktrees* (`C:/dev/lantern-os-stable`, `C:/dev/lantern-os-dev`), not the main
checkout. See [DEV-SERVER-WORKTREE.md](DEV-SERVER-WORKTREE.md) and [QUICKSTART.md](../QUICKSTART.md).

---

## 3. The loop & the four objects (the formal core)

The North Star is implemented concretely in Python under [`src/convergence/`](../src/convergence/):

| Object | Definition | Evidence |
|---|---|---|
| **Memory** | Append-only knowledge entry (timestamp, source, confidence, content) | [`objects.py:41`](../src/convergence/objects.py) |
| **Task** | Goal + constraints + status + dependencies | [`objects.py:67`](../src/convergence/objects.py) |
| **Tool** | Executable capability with input/output contract | [`objects.py:95`](../src/convergence/objects.py) |
| **Convergence Record** | Hypothesis + evidence + result + confidence | [`objects.py:131`](../src/convergence/objects.py) |

The six stages live on one `Kernel` class ([`kernel.py:23`](../src/convergence/kernel.py)):
`observe()` → `kernel.py:124`, `append_memory()` / `query_memory()` → `:146`/`:155`,
`reason()` → `:203`, `act()` → `:230`, `verify()` → `:253`, `extract_patterns()` (Converge) → `:280`.
The router and verifier are treated as **optional capabilities** gated by `health_check()`
([`kernel.py:81-105`](../src/convergence/kernel.py)) — the core (memory + tools + records) must be
present; routing/verify degrade gracefully.

Supporting core modules: `memory.py` / `memory_query.py` (token-budgeted retrieval),
`grounding.py` + `verify.py` (Verify stage), `pattern_extractor.py` (Converge),
`convergence_router.py` + `tool_registry.py` (Reason/Act), `kernel_closure.py` (loop closure),
`metrics.py` (convergence metrics).

> **Wiring gap (honest):** the formal Python Kernel exists and is exercised, but the *live serving
> path* (the Node server / dream-chat) does not yet drive the Kernel end-to-end for every request —
> the first end-to-end slice closed on the Kalshi trading path. See
> [convergence-core-mapping.md](convergence-core-mapping.md) and [§9](#9-known-divergences--debt).

---

## 4. Web cockpit — Lantern Garage (Node)

`server.js` (655 lines) is a **framework-free** HTTP server. It loads an ordered array of ~52 route
modules ([`server.js:128+`](../apps/lantern-garage/server.js)); each module is
`async function(req, res, url, deps) → boolean` and returns `true` once it has handled the request
(e.g. [`routes/status.js:68`](../apps/lantern-garage/routes/status.js)). The first module to claim
the URL wins; LLM replies stream via SSE.

Business logic lives in **[`apps/lantern-garage/lib/`](../apps/lantern-garage/lib/) — 149 modules**.
Grouped by loop stage / domain:

| Domain | Representative modules |
|---|---|
| **Chat / agents** (Reason) | `dream-chat.js`, `stream-chat.js`, `intent-router.js`, `provider-router.js`, `unified-agent.js`, `tool-runner.js` |
| **Memory / stores** (Remember) | `conversation-store.js`, `dreamer-store.js`, `entry-store.js`, `file-queue.js`, `csf-memory*.js`, `cube-store.js`, `session-summary-store.js` |
| **Convergence** (Verify/Converge) | `convergence-records.js`, `convergence-router.js`, `convergence-status.js`, `convergence-outcome-grader.js`, `grounding-policy.js`, `grounding-calibration.js`, `collapse-canary.js`, `contradiction-scanner.js` |
| **Trading** (Act) | `kalshi-api.js`, `kalshi-collector.js`, `kalshi-suggest.js`, `trading-*.js`, `crypto-collector.js`, `strategy-registry.js` |
| **Orchestration / fleet** (Act) | `auto-dispatch.js`, `swarm-orchestrator.js`, `autowork-worktree.js`, `auto-merge-resolver.js`, `job-queue.js`, `job-worker.js`, `training-dispatcher.js` |
| **Media / creator** (Act) | `image-generation.js`, `caption-engine.js`, `facecam-v3.js`, `video-pipeline-*.js`, `thumbnail-generator.js` |
| **Safety / gates** | `consent-gate.js`, `consequence-gate.js`, `command-allowlist.js`, `safe-exec` (via `safe-exec.js`), `auth-middleware.js`, `session-secret.js` |

### Persona routing

Agent personas are defined in [`dream-chat.js`](../apps/lantern-garage/lib/dream-chat.js) with
per-persona `systemPrompt`s: `lantern`, `blinkbug`, `keystone`, `waterfall`, `xenon`, `founder`,
plus task-specific `trader`, `claude-code`, and a verification-first **Σ₀** persona (`:256`).
`selectAgent()` ([`:300`](../apps/lantern-garage/lib/dream-chat.js)) scores inbound messages by
keyword; with no match it falls back to the Σ₀ default (`:332`).

---

## 5. Provider abstraction (models are interchangeable)

Providers are **data, not code**: declared in the PCSF layer — `data/pcsf/provider.pcsf.json`
(the registry; a **gitignored runtime file**) plus the committed model roster
[`data/pcsf/model.pcsf.json`](../data/pcsf/model.pcsf.json) — with fallback order + default
models ([PROVIDERS.md:17](../PROVIDERS.md)). `server.js` reads `.env` at startup; keys can be
hot-reloaded via `POST /api/settings/providers` without restart ([PROVIDERS.md:22](../PROVIDERS.md)).

**Live fallback chain:** Gemini → Claude (Anthropic) → OpenAI → Ollama (local)
([PROVIDERS.md:156-161](../PROVIDERS.md)). Local inference targets Ollama at
`http://127.0.0.1:11434`, default model `ouro:latest`
([`dream-chat.js:430-431`](../apps/lantern-garage/lib/dream-chat.js)) — the Σ₀/Ouro served model.
**Declared but not yet wired:** Grok, Mistral, Cohere, Perplexity ([PROVIDERS.md:167-170](../PROVIDERS.md)).

No module hardcodes a single provider as a dependency — selection routes through
`provider-router.js` / `selectProvider`.

---

## 6. Persistence model

One append path, one archive — no second memory system.

- **JSONL append logs** under `data/` (~40 subdirectories) — conversations, trading history, agent
  audits, convergence records (`data/convergence/records.jsonl`, `issue-work-records.jsonl`).
  Concurrent writes funnel through [`lib/file-queue.js`](../apps/lantern-garage/lib/file-queue.js)
  to avoid interleaved corruption.
- **JSON state files** under `data/` for current-state snapshots (feature flags, manifests, PCSF).
- **CSF archive** — the lossless binary memory/compression layer (see §7).

---

## 7. CSF / Tesseract storage

CSF (Convergence-Fitted Searchable Format) is **one canonical module**. The package root
[`src/csf/__init__.py`](../src/csf/__init__.py) is the stable public API: `pack`/`unpack`/`read_file`
for archives, `compress`/`decompress` for byte strings (`__init__.py:12-18`). The engine is
[`csf_pack.py`](../src/csf/csf_pack.py).

The 2026-06 v2 consolidation **deleted** the duplicate/legacy writers (segmented v1, v0.3 `csf_file`,
lossy symbolic text compressors); existing on-disk archives still open **read-only** via
[`legacy.py`](../src/csf/legacy.py) (`__init__.py:27`, `:38`). Kept: the v07 lattice primitives
(Tesseract "storage face") and the Status-Cube container ([`status_cube.py`](../src/csf/status_cube.py)).
Memory-specific helpers: `memory_engine.py`, `trading_memory.py`, `delta_stream.py`.
The CADD layer is built on top under [`caad/`](../caad/).

---

## 8. Other subsystems

| Subsystem | Location | Role (loop stage) |
|---|---|---|
| **MCP server** | [`src/mcp_server/server.py`](../src/mcp_server/server.py) | FastAPI + SSE; tools `queue_status`, `task_intake`, `dispatch_work`, `boot_check`, `list_skills`, `get_status` (`server.py:11-16`). Act/observe bridge for orchestrators. |
| **Trading terminal** | `public/kalshi-terminal.html` + [`routes/trading.js`](../apps/lantern-garage/routes/trading.js) | Swipe-deck UI over 60+ REST endpoints; live data via `kalshi-collector` snapshot, not UI-direct calls. Act + first closed loop slice. |
| **Explore feed** | `public/explore.html` + [`routes/explore.js`](../apps/lantern-garage/routes/explore.js) + [`lib/explore-feed.js`](../apps/lantern-garage/lib/explore-feed.js) | Single-pane content feed ranked by `rankCandidates(cards,"explore")` — a **2nd, non-LLM consumer of the PCSF leaderboard** (§5). Click/dismiss → `recordModelOutcome` reorders it. Reason + Converge. See [EXPLORE-FEED.md](EXPLORE-FEED.md). |
| **Σ₀ / Ouro serving** | [`src/sigma0/`](../src/sigma0/) (`loop_lm.py`, `provider_node.py`, `quantized_cache.py`, `decode_canary.py`) | The local interchangeable model; served behind Ollama. Reason. |
| **Self-improvement / training** | `scripts/ouro_*`, `src/training/`, `data/self-improvement/` | LoRA/adapter training jobs; experience capture. Converge. |
| **Orchestration / autowork / fleet** | `lib/autowork-worktree.js`, `lib/swarm-orchestrator.js`, monoworkstream git hooks | Per-issue worktree-isolated agents; one PR lane per agent prefix. Act. |
| **Skills** | [`skills/`](../skills/) (17 dirs) | Capability contracts. **Only `dream_journal`, `lucid_dreaming`, `archive_curator`, `voice_curator`, `job_application` have real implementations** — the rest are design contracts only (per [CLAUDE.md](../CLAUDE.md)). |
| **Discord bot** | `src/discord_lounge_bot/` | Optional community integration. |

---

## 9. Known divergences & debt

Named honestly so they become follow-up issues, not surprises:

1. **Loop not yet driven end-to-end from serving.** The Python Kernel is real and tested, but the
   Node serving path doesn't route every request through it; only the Kalshi path has closed
   Reason→Verify→Converge. *Debt: wiring, not building.* ([§3](#3-the-loop--the-four-objects-the-formal-core))
2. **Skills are mostly design-contract-only.** 17 skill dirs, 5 real implementations (`job_application` added in #1098). Docs must not claim the others are live.
3. **CSF codec claims vs. reality.** The public API docstring advertises `zstd-19+LDM`
   ([`__init__.py:12`](../src/csf/__init__.py)); in practice the active paths have bottlenecked on
   zlib / low-level zstd, leaving substantial ratio on the table vs. brotli/lzma/zstd-19. *Verify
   actual codec before quoting ratios.*
4. **Declared-but-unwired providers** (Grok, Mistral, Cohere, Perplexity) appear in PCSF but not in
   the fallback chain — config implies capability the code doesn't yet have.
5. **Orphaned nav modules.** `shared-header.js` / `header.js` are unused; live nav is `auth-gate.js`
   + inline per-page `.site-nav`.
6. **149 `lib/` modules, framework-free routing.** Powerful and dependency-light, but discovery and
   ordering are manual; no central route registry beyond the array in `server.js`.

Each of these is a candidate ADR or follow-up issue spawned from this writeup.

---

## 10. Security & deployment posture

- **Local default is loopback** (`127.0.0.1`); public bind only when `PORT` is set
  ([`server.js:70`](../apps/lantern-garage/server.js)).
- **Patreon OAuth** optionally gates the whole site; currently the login *requirement* is behind a
  feature flag (`patreon_auth`) — guests browse, admin/trade stay gated. See
  [PATREON-OAUTH.md](PATREON-OAUTH.md) and the auth-flag memory.
- **lantern-os.net** is a **Cloudflare tunnel → local 4177 stable server**, not Railway. Local-admin
  bypass must gate on proxy-header absence, not socket IP.
- **Operator/keystone routes** are gated by a hardened `isOperatorRequest`; command execution is
  **shell-free** via `lib/safe-exec.js` (tokenize + `execFileSync shell:false`) — never reintroduce
  `execSync` on interpolated input.
- See [SECURITY.md](../SECURITY.md) for the full posture.

---

## 11. How to keep this document true

1. When a structural change lands, update the relevant section **and** write an [ADR](adr/README.md).
2. Every claim here must resolve to a real `file:line` / commit / PR. If you can't cite it, it
   doesn't go in.
3. When a divergence in §9 is fixed, move it out and link the resolving PR.
4. This doc is the *now*; the dated audit it supersedes is kept only for history.
