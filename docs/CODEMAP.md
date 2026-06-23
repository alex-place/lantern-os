---
author: Alex Place
created: 2026-06-07
updated: 2026-06-20
---

# Keystone OS — Codemap & Feature Roadmap

**Canonical status reference for the Keystone OS codebase.**  
**Version:** 2026-06-07  
**Coverage:** System-wide feature state, active surfaces, and forward roadmap.

---

## How to Read This Document

- **Implemented** — Code exists, tests pass, CI green, converges clean.
- **Active** — In development, has open branch or TODO, may have known gaps.
- **Queued** — Spec'd, slotted in agent backlog, not yet started.
- **Held** — Blocked on dependency, external system, or operator decision.
- **Retired** — Removed from codebase or superseded.

---

## 1. System Overview

Keystone OS is a local-first operating cockpit combining:

| Surface | Technology | Purpose |
|---|---|---|
| Lantern Garage | Node.js, vanilla JS, HTML | Web app, API, PWA, static assets |
| Dream Journal | Browser (localStorage + JSONL export) | Conversational dream capture and chat |
| Agent Fleet | PowerShell + Node.js convergence loop | Validation, inspection, batch processing |
| RAG House | Markdown flat files + JSON manifests | Evidence-backed retrieval and research |
| CSF Memory | Python (`src/csf/`) + JSON schemas | Symbolic memory, compression, provenance |
| Convergence IO | PowerShell + Node.js | 12-step validation loop with receipts |
| Discord Bot | Node.js (optional) | Community tier integration |

Operating model:

```
capture context
  -> classify work (DCF)
  -> route through convergence (PCSF)
  -> validate with receipts (AAPF)
  -> store evidence in RAG / CSF
  -> promote, hold, or archive
```

---

## 2. Feature Inventory

### 2.1 Lantern Garage Web Server

| Feature | Status | File | Notes |
|---|---|---|---|
| HTTP server | Implemented | `apps/lantern-garage/server.js` | Port configurable via `LANTERN_GARAGE_PORT` |
| PWA manifest | Implemented | `apps/lantern-garage/public/manifest.json` | Installable surface |
| Health endpoint | Implemented | `/api/health` | Returns `{ ok, service, generatedAt }` |
| Status endpoint | Implemented | `/api/status` | Full system state (arc, wallet, controls, readiness) |
| Readiness gates | Implemented | `/api/readiness` | Dual-boot prep status |
| Action capabilities | Implemented | `/api/action-capabilities` | Available actions with real/held classification |
| Chat (non-streaming) | Implemented | `/api/dream/chat` | POST; Gemini grounding, Anthropic, OpenAI, Ollama, or 503 error |
| Chat (streaming SSE) | Implemented | `/api/dream/chat/stream` | Server-sent events with provider fallback |
| Dreamer CRUD | Implemented | `/api/dreamer` | Create, read dream entries |
| Dreamer chat | Implemented | `/api/dreamer/chat` | Dream + chat combined endpoint |
| Agent list | Implemented | `/api/agents` | Returns persona roster |
| Agent slots | Implemented | `/api/agents/slots` | Reads from `manifests/dream-journal-v1-agent-slots.json` |
| Keystone status | Implemented | `/api/keystone/status` | Git branch, dirty files, provider key presence |
| Agent Status page | Implemented | `public/agent-status.html` | Dashboard linking to all status endpoints |
| Knowledge Center | Implemented | `public/knowledgecenter.html` | Documentation index |
| Theme toggle | Implemented | `public/index.html` | Dark/light mode |
| Offline chat fallback | **Retired** | `lib/dream-chat.js` | Removed June 2026 — now returns 503 error with help text |

### 2.2 Dream Journal

| Feature | Status | Notes |
|---|---|---|
| Freeform chat journaling | Implemented | Text input, multi-turn, local storage |
| Persona routing | Implemented | 6 personas: Keystone, Lantern, Xenon, Blinkbug, Waterfall, Founder |
| Door parsing | Implemented | `[DOORS: A | B | C]` parsed and rendered as chips |
| Voice input (Web Speech API) | Implemented | Browser TTS; voice selector in settings |
| Symbol tagging | Implemented | DCF auto-classification on entries |
| JSONL export | Implemented | Portable local export for CSF ingestion |
| 3 Door Game Design | Implemented | Spec complete; playable frontend pending |
| STT backend fallback | Queued | Vosk route `POST /api/dream/transcribe` planned |
| CTF glyph persistence | Implemented | Symbols stored in entries, surfaced in stats |
| TTS voice selector | Implemented | Rate/pitch/name from `SpeechSynthesis.getVoices` |

### 2.3 Convergence & Validation

| Feature | Status | Notes |
|---|---|---|
| 12-step convergence loop | Implemented | PowerShell: `scripts/Invoke-LanternSmartConvergenceLoop.ps1` |
| Git state checks | Implemented | Dirty working tree, locks, divergence |
| npm audit | Implemented | Runs in Standard+ depth; skipped in Light |
| Health probe | Implemented | Local HTTP probe every run |
| Self-repair (`ApplySafeFixes`) | Implemented | Manual trigger only after clean git scan |
| Validation ring | Active | 3-agent consensus, SHA-256 hash chain, tamper-evident JSONL |
| Fleet status reporting | Implemented | Reads `data/status/super-jarvis-fleet.json` |
| Task intake queue | Implemented | `mcp1_task_intake` / `mcp1_queue_status` |
| Convergence receipts | Implemented | JSON output with status, issue count, next action |

### 2.4 Provider & AI Gateway

| Feature | Status | Notes |
|---|---|---|
| Gemini API with grounding | Implemented | `google_search_retrieval` tool in payload |
| Anthropic Claude | Implemented | `api.anthropic.com` messages endpoint |
| OpenAI GPT | Implemented | `api.openai.com` chat completions |
| Ollama local | Implemented | `http://127.0.0.1:11434` fallback |
| PCSF live refresh | Implemented | Auto-updates `data/pcsf/*.pcsf.json` on server start |
| Provider state caching | Implemented | 60s PCSF cache in `lib/provider-cache.js` |
| Multi-provider fallback chain | Implemented | Gemini -> Claude -> OpenAI -> Ollama -> 503 |

### 2.5 RAG & Research

| Feature | Status | Notes |
|---|---|---|
| Flat RAG dollhouse | Implemented | `skills/lantern-rag-dollhouse/` |
| External LLM web cache | Implemented | `data/rag-intake/external-llm-web-cache/` |
| Internal RAG house | Implemented | `data/internal-rag-house/` |
| Source registry pattern | Implemented | From archived gm-agent-orchestrator; active in research workflow |
| Claim registry pattern | Implemented | JSONL machine-readable claim ledger |
| Research synthesis | Active | First synthesis completed: human-in-the-loop ASI/AGI |
| RAG intake queue | Active | `data/rag-intake/` with trace and downloads-merge |

### 2.6 CSF Memory Engine

| Feature | Status | Notes |
|---|---|---|
| Core memory tiers | Implemented | EPHEMERAL, WORKING, REFINED, SKILL, ARCHIVE |
| Procedural tier | Implemented | Added June 2026: `create_procedure()`, `steps`, `tool_invocations` |
| Multi-signal retrieval | Implemented | Semantic + BM25 keyword + entity overlap fusion |
| Async writes | Implemented | `write_async()` with queue depth tracking |
| Actor-aware provenance | Implemented | `actor_id`, `actor_type`, `confidence_reasoning` |
| Staleness detection | Implemented | Contradiction check against same-entity memories |
| Temporal lineage | Implemented | `promotion_lineage` with evolution events |
| Integrity hashes | Implemented | SHA-256 on AAPF records |

---

## 3. Forward Roadmap

### Phase 1: v1.0.0 — Foundation Complete (June 2026)

**Goal:** Solid core with provider gateway, convergence validation, and local-first architecture.

- [x] Lantern Garage server with full API surface
- [x] Dream Journal chat with multi-persona routing
- [x] Convergence loop with 12-step validation
- [x] PCSF/CCF/NAP/DCF/AAPF regulatory primitives
- [x] Agent Status dashboard
- [x] Knowledge Center documentation index
- [x] Multi-provider AI gateway (Gemini, Claude, OpenAI, Ollama)
- [x] Gemini grounding with Google Search retrieval
- [x] CSF memory engine v2 (async, multi-signal, procedural tier)
- [x] RAG dollhouse and external web cache

**Remaining before tag:**
- [ ] Configure real provider API keys in `.env`
- [ ] Verify Gemini grounding with paid key (`dream_journal/gemini_grounding_test`)
- [ ] Final convergence pass with all green
- [ ] Tag `v1.0.0` and create release notes

### Phase 2: v1.0.1 — Interactive Depth (Late June / Early July 2026)

**Goal:** Make the journal alive. Add voice, interactive gameplay, and deeper symbolic tools.

- [ ] Full 3 Door Game with Information Cards (frontend + backend)
- [ ] Backend Vosk STT fallback (`POST /api/dream/transcribe`)
- [ ] Enhanced Discord bot integration with tier-aware roles
- [ ] Advanced symbolic tools (void/light balance, mystery tracking dashboard)
- [ ] Dream pattern analysis dashboard (web UI)
- [ ] Mobile-friendly responsive UI pass
- [ ] Full DCF privacy controls + user-facing export tools

### Phase 3: v1.0.2 — Research & Intelligence (July 2026)

**Goal:** Turn Keystone OS into a research cockpit, not just a journal.

- [ ] Research request pipeline: `research/requests/open/` with structured templates
- [ ] Automated source registry freshness checks
- [ ] Claim registry auto-update from synthesis documents
- [ ] Web search integration for real-time research intake
- [ ] Research synthesis generation from web cache entries
- [ ] Convergence loop refinements: backpressure, rate limiting, OpenTelemetry spans
- [ ] Lucid dreaming tools (MILD/WBTB tracking, reality check reminders)

### Phase 4: v1.1 — Guild & Team Features (August 2026)

**Goal:** Team collaboration, shared archives, and advanced audit.

- [ ] Team / multi-user support for Synthesasia Guild tier
- [ ] Shared symbolic archives with access controls
- [ ] Blockchain-anchored AAPF audit trails (optional for Guild)
- [ ] Custom art style training pipeline
- [ ] API access for Guild members (documented endpoints)
- [ ] Advanced analytics and reporting (`skills/lantern-custom-report-lib/`)

### Phase 5: v1.2 — Convergence Intelligence (September 2026)

**Goal:** The system improves itself through co-improvement with the operator.

- [ ] Agent swarm orchestration with human-in-the-loop steering
- [ ] Self-monitoring convergence metrics (drift detection, regression alerts)
- [ ] Automated research intake from configured RSS feeds and arXiv alerts
- [ ] Skill crystallization: CSF procedural memories auto-promote to reusable skills
- [ ] Co-improvement loop: agent proposes → operator judges → agent implements → convergence validates

---

## 4. Active Workstreams

| Workstream | Lead Agent | Status | Next Action |
|---|---|---|---|
| Chat provider gateway | Xenon | Implemented | Configure real API keys |
| Agent Status dashboard | Keystone | Implemented | Add real-time websocket updates |
| Convergence validation ring | Founder's Wish | Active | Stabilize 3-agent consensus rate |
| CSF memory engine v2 | Blinkbug | Implemented | Add test coverage for `create_procedure()` |
| RAG research synthesis | Waterfall | Active | Fill inaccessible paywalled sources |
| 3 Door Game | Gage | Queued | Frontend implementation |
| Discord integration | Xenon | Queued | Role + channel setup with tier enforcement |
| Cloud deployment | Tony | Held | Waiting on dual-boot readiness |

---

## 5. Dependencies & Blockers

| Dependency | Blocks | Resolution Path |
|---|---|---|
| Real Gemini API key | `gemini_grounding_test` | Operator adds `GEMINI_API_KEY` to `.env` |
| Real Anthropic key | Claude fallback reliability | Operator adds `ANTHROPIC_API_KEY` to `.env` |
| Ollama installed locally | Offline AI capability | Run `scripts/orchestration/start-local-llms.ps1` |
| Dual-boot readiness | Cloud deployment | Track in `manifests/validation/DUAL-BOOT-PREP-LATEST.json` |
| GitHub Actions secrets | CI deployment | Operator configures `DISCORD_TOKEN`, deploy keys |

---

## 6. Canonical Links

| Document | Path | What It Covers |
|---|---|---|
| Architecture (current state) | `docs/ARCHITECTURE.md` | Canonical "what the system is today" snapshot |
| Architecture Decision Records | `docs/adr/README.md` | Decision log — *why* the architecture is the way it is |
| Dream Journal Roadmap | `docs/DREAM-JOURNAL-ROADMAP.md` | Dream Journal specific features, tiers, 3 Door Game |
| Research Contract | `archive/gm-agent-orchestrator/docs/research/research-contract.md` | How research is ingested, audited, and promoted |
| Repo Contract | `docs/REPO-CONTRACT.md` | Git workflow, convergence rules, merge policy |
| Convergence Loop | `docs/CONVERGENCE-CICD-BATCH-LOOP.md` | 12-step method, CI integration, batch framework |
| Agent Fleet Plan | `manifests/CONVERGENCE-LOOP-AGENT-FLEET.md` | 36-slot matrix, 64-worker elastic target |
| RAG Dollhouse Skill | `skills/lantern-rag-dollhouse/SKILL.md` | Flat RAG building, asset manifest, purge lanes |
| Latest Research Synthesis | `data/rag-intake/research-synthesis-human-in-the-loop-asi-agi-2026-06-07.md` | Human-in-the-loop ASI/AGI self-improvement |

---

## 7. Maintenance Rules

1. **Update this Codemap** whenever a workstream status changes (implemented, active, queued, held, retired).
2. **Do not duplicate** the Dream Journal Roadmap — link to it for tier-specific and game-specific features.
3. **Add new features** to Section 2 before promoting them to the roadmap in Section 3.
4. **Retire features** by moving them to a "Retired" subsection with a superseded-by note.
5. **Commit on change** — this is a canonical doc, not a scratchpad.

---

*This Codemap is the single source of truth for Keystone OS feature state. When in doubt, check here first.*
