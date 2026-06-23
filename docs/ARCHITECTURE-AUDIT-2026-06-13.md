# Architecture Audit — ConvergenceIO, PCSF, and Runtime Systems

> **⚠ Historical (superseded 2026-06-23).** The canonical current-state architecture is now
> [ARCHITECTURE.md](ARCHITECTURE.md). This dated audit is retained for history only; do not
> treat its specifics as current without re-verifying against the tree.

**Date:** 2026-06-13  
**Method:** Direct code inspection (implementation, call graph, state transitions, persistence boundaries)  
**Auditor:** Independent review — no assumptions from prior documentation accepted without verification

---

## 1. Architecture Map

```
┌─────────────────────────────────────────────────────────────────────┐
│  HTTP Layer  apps/lantern-garage/server.js                          │
│  Routes: dream.js stream-chat.js status.js features.js (30+ files) │
└────────────────────────┬────────────────────────────────────────────┘
                         │
        ┌────────────────┴──────────────────────┐
        │                                       │
┌───────▼────────┐                   ┌──────────▼──────────┐
│ JS Path        │                   │ Python Path         │
│ lib/stream-    │                   │ src/convergence_io  │
│ chat.js        │                   │ _engine.py          │
│ lib/dream-     │                   │ (TesseractEngine,   │
│ chat.js        │                   │  ConvergenceLoop)   │
│ lib/pcsf-      │                   └──────────┬──────────┘
│ refresh.js     │                              │
└───────┬────────┘                   ┌──────────▼──────────┐
        │                            │ src/convergence_io/ │
        │                            │ engine.py (ConvergenceIO)│
        │                            │ pcsf.py ceg.py      │
        │                            │ aapf.py ccf.py nap.py│
        │                            │ dcf.py dilation.py  │
        │                            │ hot_swap.py         │
        │                            └──────────┬──────────┘
        │                                       │
        └──────────────┬────────────────────────┘
                       │
        ┌──────────────▼───────────────┐
        │  Persistence Layer           │
        │  data/dream_journal/*.jsonl  │
        │  data/agent-fleet/slots.json │
        │  data/pcsf/*.json            │
        │  data/csf_memory/*.jsonl     │
        │  manifests/evidence/*.json   │
        └──────────────────────────────┘
```

---

## 2. Dependency Map

### Critical finding: Two separate "convergence engines" with no connection

| Component | File | Size | Callers |
|-----------|------|------|---------|
| `TesseractEngine` | `src/convergence_io_engine.py` | 1858 LOC | `git-convergance-loop.sh`, CLI only |
| `ConvergenceIO` | `src/convergence_io/engine.py` | 271 LOC | Not called from JS server — design contract only |
| `ConvergenceLoop` | `src/convergence_io_engine.py` | Embedded | CLI `loop` subcommand only |
| `CEGExecutor` | `src/convergence_io/ceg.py` | New | Not wired to any caller |
| `csf_agent.*` | `src/csf_agent/` | New | Not wired to any caller |

**Key finding:** `ConvergenceIO` (the typed primitive stack engine in `src/convergence_io/engine.py`) is **never called** by the Node.js server. The actual chat routing happens in `apps/lantern-garage/lib/stream-chat.js` and `lib/dream-chat.js`, which call external LLM APIs directly. The ConvergenceIO engine is a design contract that has not replaced the ad-hoc JS routing.

### PCSF — Three implementations, one function

| Implementation | File | What it actually does |
|---------------|------|-----------------------|
| `pcsf.py` | `src/convergence_io/pcsf.py` | Provider health tracking, circuit breakers, fallback chain |
| `pcsf-refresh.js` | `apps/lantern-garage/lib/pcsf-refresh.js` | Reads MCP resource files, writes JSON to `data/pcsf/` |
| `PCSFOptimizer` | `src/convergence_io/ceg.py` | Cost-minimizing plan selector over CEG graph |
| `data/pcsf/*.json` | `data/pcsf/` | Static config: agent slots, model names, env vars |

These are four different things named PCSF. They share no code and no runtime connection.

### ESF — Not found

ESF (Event Synchronization Framework) does not exist in the codebase as implemented code. It may be a planned abstraction or a documentation artifact. No file, class, or function named ESF, EventSync, or EventSynchronization was found in `src/`, `apps/`, or `scripts/`.

---

## 3. Data-Flow Diagram

### Actual chat request flow (what runs):

```
User message
  → POST /api/dream/chat/stream (dream.js)
      → lib/stream-chat.js
          → reads ANTHROPIC_API_KEY / GEMINI_API_KEY from env
          → calls Anthropic/Gemini/OpenAI API directly
          → SSE tokens back to browser
          → appends to data/dream_journal/*.jsonl
          → appends to data/csf_memory/raw.jsonl (trading signals only)
```

### Intended chat request flow (design contract, not wired):

```
User message
  → ConvergenceIO.route_chat()
      → CCF.check_capability()
      → NAP.check_authority()
      → PCSF.select_provider()  ← capacity fallback chain
      → DCF.classify_data()
      → call LLM provider
      → AAPF.record_action()    ← provenance
      → return RouteResult
```

### Convergence loop flow (runs via CLI only):

```
python src/convergence_io_engine.py loop
  → ConvergenceLoop.run()
      → 20 phase methods (inspect_repo → promote_or_hold)
      → writes manifests/evidence/convergence-*.json
      → NOT called by web server
      → NOT triggered by user requests
```

---

## 4. Top 10 Technical Debt Items

### TD-001: Two convergence engines with identical names, no connection
**Severity: Critical**  
`src/convergence_io_engine.py` (TesseractEngine) and `src/convergence_io/engine.py` (ConvergenceIO) are both called "the convergence engine" in docs. They share no code, no callers, and serve different purposes. The JS server uses neither for actual chat routing.

### TD-002: ConvergenceIO primitive stack is a dead abstraction
**Severity: High**  
`src/convergence_io/` (PCSF, CCF, AAPF, NAP, DCF, CEG) contains ~3000 LOC of well-designed primitives. None of it is called from the production chat path. `lib/stream-chat.js` routes directly to APIs with a simple `if/else if` provider chain.

### TD-003: SlotManager accumulates slots indefinitely
**Severity: High**  
`SlotManager` in `convergence_io_engine.py` writes to `slots.json` on every `claim()` but never purges old entries. Released slots remain in the file forever. The only cleanup is the orphan check in `_phase_check_asi_benchmarks` which reads but does not delete. Over time `slots.json` grows without bound.

**Evidence:** `release()` sets `status = "released"` but does not remove the key.

### TD-004: Persona cache is not LRU — it is "clear all when full"
**Severity: Medium**  
`TesseractEngine._persona_cache` is documented as "LRU-style cache eviction" but the implementation calls `dict.clear()` when `len >= 1000`, discarding all 1000 entries at once. This is a cache flush, not eviction. A true LRU would evict the least-recently-used entry.

**Evidence:** Lines 1423–1424: `self._persona_cache.clear()`

### TD-005: `_phase_cache` in ConvergenceLoop has no eviction
**Severity: Medium**  
`_phase_cache` stores `PhaseResult` objects keyed by phase name. The cache is cleared when the repo state hash changes, but never size-bounded. In a long-running process with frequent phase result writes, this grows without bound (bounded only by phase count in practice — low risk but misleading).

### TD-006: PCSF validation ring `_simulate_validators` is deterministic
**Severity: Medium**  
`ValidationRing._simulate_validators()` runs the same check function three times and calls them "alpha", "beta", "gamma" validators. Because they run the same deterministic lambda, they always vote identically — the consensus mechanism adds no information. This is "blockchain-inspired" in name only.

### TD-007: `convergence_io_engine.py` imports from `src/` but is tested as top-level
**Severity: Medium**  
Tests do `sys.path.insert(0, 'src')` and import `convergence_io_engine` directly. The file itself does `sys.path.insert(0, str(REPO_ROOT / "src"))`. This dual-path setup means the module can be imported two ways with different identities, breaking `isinstance()` checks across import boundaries.

### TD-008: csf_agent chain has no integration into the production server
**Severity: Low-Medium**  
`src/csf_agent/` (scanner, embedder, scorer, suggester, loop) is fully implemented and tested but has no entry point in the web server or CI pipeline. It runs only manually via `python src/csf_agent/loop.py`.

### TD-009: Feature Runtime (`feature-graph.js`) reads health from env vars
**Severity: Low**  
`buildSystemState()` reads `PROVIDER_HEALTH` and `PROVIDER_LATENCY_MS` from env vars. In production these are never set, so health always defaults to `1.0` and latency to `500ms`. The feature graph evaluates on stale mock data, not live provider state.

### TD-010: Validation chain JSONL grows without bound
**Severity: Low**  
`ValidationRing` appends to `data/agent-fleet/validation-chain.jsonl` on every run. No rotation, no size cap. Each convergence loop run appends up to 10 records. Running the loop hourly generates ~240 records/day.

---

## 5. Top 10 Simplification Opportunities

### S-001: Consolidate the two engines into one
`TesseractEngine` and `ConvergenceIO` can be merged or one deprecated. TesseractEngine is the CLI tool; ConvergenceIO is the chat router. The chat router should replace the ad-hoc JS provider switching in `stream-chat.js`.

### S-002: Replace 30+ `if url.pathname === ...` blocks with a router
`server.js` loads 30+ route modules, each using `if (url.pathname === "/api/...")` chains. A simple `Map<string, handler>` or trie would eliminate O(n) route scanning on every request.

### S-003: Unify the 4 PCSF implementations
Four things named PCSF. Collapse to: one Python provider-routing class + one JSON config file. The JS `pcsf-refresh.js` is a file sync utility that should be renamed.

### S-004: Replace "clear all" persona cache with `collections.OrderedDict` LRU
One-line fix: replace `dict` + manual eviction with `OrderedDict` and `move_to_end` / `popitem(last=False)`. Makes the "LRU-style" claim actually true.

### S-005: Add SlotManager.purge_released() called from convergence loop
Released slots are never removed. Add a `purge_released(older_than_hours=24)` method called from phase 19 (`record_evidence`) to trim the file.

### S-006: Delete ESF references from documentation
ESF does not exist. Remove all mentions to reduce cognitive load on auditors and new contributors.

### S-007: Make ValidationRing validators actually independent
Use three different check strategies per job (file-based, git-based, hash-based) rather than running the same lambda three times. True independence makes the consensus metric meaningful.

### S-008: Wire ConvergenceIO into stream-chat.js
Replace the `if/else if` provider chain in `lib/stream-chat.js` with `ConvergenceIO.route_chat()`. This is the intended architecture. The primitive stack already handles fallback, circuit-breaking, and provenance.

### S-009: Add convergence loop to CI
The convergence loop (`python src/convergence_io_engine.py loop`) runs locally only. Running it in CI with `--dry-run` would catch repo invariant failures before merge.

### S-010: Collapse csf_agent into a single CLI entry point
`scanner → embedder → scorer → suggester → loop.py` is a 5-file chain with no shared runner. A single `python -m csf_agent` entry point would make it discoverable and reduce onboarding friction.

---

## 6. Top 5 Convergence Risks

### CR-001: ConvergenceLoop promotion_ready never fires in early-exit path
When all 20 phases pass on tick 0 and 1, the loop early-exits after tick 1 via the `consecutive_clean_ticks >= 2` break. The `record_evidence` (phase 19) and `promote_or_hold` (phase 20) are in `external_io_phases` and are **skipped on internal ticks**. Early exit means they never run. No receipt is written, no promotion decision is made — despite `status = "clean"`.

**Risk:** The loop reports clean convergence without ever recording evidence or making a promotion decision.

### CR-002: Phase caching survives repo state changes only when hash differs
`_phase_cache` is invalidated by `_repo_state_hash()` — a `git status --short -uno` SHA1. Untracked files are excluded (`-uno`). If an agent writes a new file without staging it, the cache is not invalidated.

### CR-003: Dilation field not applied in ConvergenceIO engine (only in CEGExecutor)
`CEGExecutor` correctly calls `dilation.apply_to_graph()` each tick. But `ConvergenceIO.route_chat()` (the production path) does not use dilation at all — it selects providers via a simple fallback chain. Time dilation is implemented but disconnected from the actual routing decision.

### CR-004: Circuit breakers in TesseractEngine share no state with PCSF circuit breakers
`TesseractEngine._circuit_cache` holds `CircuitBreaker` objects per provider. `src/convergence_io/pcsf.py` has its own circuit breaker logic in `ProviderCapacityState`. They do not communicate. A provider failing in one does not trip the other.

### CR-005: Bayesian belief posteriors are hardcoded constants
`_phase_update_bayesian_beliefs()` returns fixed posteriors (e.g., `health: 0.8 if hff_app.exists() else 0.3`). These are not computed from observations or updated across runs. The "Bayesian" framing is aspirational — no prior × likelihood → posterior update occurs.

---

## 7. Top 5 Performance Risks

### PR-001: `_phase_inspect_repo` walk on large repos
Fixed in recent commit: skip-list walk replaces `rglob("*")`. However, `stack` grows proportionally to directory depth × branching factor. On a large monorepo this could still OOM.

**Mitigation:** Add a `max_files` cap (e.g., 50,000) with early termination.

### PR-002: ValidationRing runs up to 10 jobs × 3 validators per convergence tick
With `max_seconds=15`, each run blocks for up to 15 seconds. The git diff secret scan (`subprocess.run(["git", "diff", "--cached"])`) runs synchronously inside a file-system lock. This blocks the entire validation ring for its duration.

### PR-003: SlotManager.flush() never called automatically
`SlotManager` has a `flush()` method for lazy disk persistence, but it is never called in the engine's normal execution path. The `_dirty` flag is set but never flushed. Slots written during a converge call are lost on process restart.

**Evidence:** No call to `self.slots.flush()` anywhere in `TesseractEngine`.

### PR-004: ThreadPoolExecutor in TesseractEngine never shut down
`TesseractEngine.__init__` creates a `ThreadPoolExecutor(max_workers=4)` stored as `self._executor`. There is no `__del__`, `close()`, or context manager. In long-running processes the executor threads are never joined, and in tests `shutdown(wait=False)` must be called manually (visible in `test_convergence_io_engine.py`).

### PR-005: SSE feature stream polls every 10s regardless of change
`routes/features.js` sends a full feature payload every 10 seconds unconditionally. Each payload re-evaluates all features and serializes JSON. With many connected clients, this generates `10s × n_clients` evaluations per 10 seconds. Should use ETag/conditional GET or diff-based SSE.

---

## 8. Recommended Roadmap (by impact)

### Phase 1 — Critical correctness fixes (1–2 days)

| # | Action | File | Impact |
|---|--------|------|--------|
| 1 | Fix early-exit: always run `record_evidence` + `promote_or_hold` on clean exit | `convergence_io_engine.py` | Convergence receipts actually written |
| 2 | Fix SlotManager: call `flush()` after claim/release; add `purge_released()` | `convergence_io_engine.py` | Prevents unbounded slot file growth |
| 3 | Fix ThreadPoolExecutor: add `__del__` or explicit `close()` to TesseractEngine | `convergence_io_engine.py` | Prevents thread leak in tests/prod |
| 4 | Replace persona cache `clear()` with true LRU (`OrderedDict`) | `convergence_io_engine.py` | Makes LRU claim actually true |

### Phase 2 — Integration (3–5 days)

| # | Action | Files | Impact |
|---|--------|-------|--------|
| 5 | Wire `ConvergenceIO.route_chat()` into `lib/stream-chat.js` as provider backend | `stream-chat.js`, `convergence_io/engine.py` | Activates the entire primitive stack for production chat |
| 6 | Wire `feature-graph.js` to live provider health (from `/api/status`) | `lib/feature-graph.js` | Feature activation reflects real system state |
| 7 | Add `python src/convergence_io_engine.py loop` to CI as a dry-run check | `.github/workflows/ci.yml` | Catches invariant regressions before merge |

### Phase 3 — Simplification (1 week)

| # | Action | Impact |
|---|--------|--------|
| 8 | Merge or deprecate one of the two "convergence engines"; rename clearly | Eliminates #1 architectural confusion |
| 9 | Collapse 4 PCSF implementations → 1 Python class + 1 config file | Eliminates PCSF namespace confusion |
| 10 | Add simple route registry to server.js (Map<string, handler>) | Eliminates O(n) route scan per request |
| 11 | Make ValidationRing validators genuinely independent | Makes consensus metric meaningful |
| 12 | Remove ESF from all documentation | Reduces onboarding confusion |

### Phase 4 — Quality (ongoing)

| # | Action | Impact |
|---|--------|--------|
| 13 | Add `max_files` cap to `_phase_inspect_repo` | Prevents OOM on large repos |
| 14 | Add ETag/diff to SSE feature stream | Reduces redundant evaluations |
| 15 | Make Bayesian posteriors actually Bayesian (EMA over observations) | Makes phase 14 meaningful |

---

## Summary

**Intended architecture:** A typed primitive stack (ConvergenceIO → CEG → PCSF → AAPF/NAP/CCF/DCF) routing all chat through a constraint-satisfying execution graph with provenance recording.

**Implemented architecture:** A Node.js server with a direct `if/else if` provider chain in `stream-chat.js`, plus a separate Python CLI tool (`convergence_io_engine.py`) that inspects the repo in 20 phases and writes JSON receipts. The typed primitive stack exists and is tested but is not connected to any production path.

**Observed architecture:** Production chat uses `stream-chat.js` directly. The convergence loop runs manually. The ConvergenceIO primitives, CEG executor, csf-agent, and feature runtime are all implemented but unintegrated.

**Single highest-value action:** Wire `ConvergenceIO.route_chat()` into `lib/stream-chat.js`. This activates the entire typed primitive stack for production use with one integration point.
