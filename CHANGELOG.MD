# Changelog

All notable changes to Keystone OS (formerly Lantern OS) should be documented in
this file.

The format follows the spirit of [Keep a Changelog](https://keepachangelog.com),
with entries grouped by release. This project is private and local-first, so
release notes stay honest about what was verified locally versus what remains
design intent.

**Versioning policy (enforced by the pre-push hook):** every code-bearing branch
must bump `version` in `package.json` to a new semantic `X.X.X` value and add a
matching `## [X.X.X] - YYYY-MM-DD` entry below before it can be pushed. See
`scripts/validate-prepush-version-changelog.py`.

---

## [Unreleased]

### Planned (ORION / Lantern OS Performance)

- CSF memory optimization plan: add delta-only dream-entry storage, `previous_entry_hash` checks, sparse ternary storage for the `3^12` symbolic matrix, and dictionary compression for recurring symbols such as "King of Nowhere," "birds & bees," doors, anchors, and repeated Lantern / ORION motifs.
- Convergence IO / PCSF routing plan: cache the last 5–10 healthy provider states in memory with a 60-second expiry, default local Dream Journal routing to Ollama `Q4_K_M`, fall back to `Q5_K_M` when quality checks fail, and add a `dreamChatReply()` routing cache for repeated similar requests.
- Digital Blackbox acceleration plan: add a configurable `internal_multiplier` defaulting to the 5x–8x range, run bounded internal convergence steps per external tick, throttle UI / external I/O through light external dilation, and guard the loop with NAP safety checks for temperature, memory, and runaway execution.
- **Dream Art Generation (Held — post-V1 backlog):** Generate Gage-style symbolic imagery from dream entries via a local Stable Diffusion or Ollama-backed pipeline. Gate by tier (`Wanderer` = 15/month, `DeepDreamer` = unlimited). Cache recent prompts and reusable embeddings where privacy-safe; pre-warm model before requests. Acceptance criteria before promotion: (1) `POST /api/dream/art/generate` endpoint wired and returning image binary or URL; (2) tier gate enforced in middleware with a usage ledger; (3) at least one end-to-end smoke test generating an image locally; (4) prompt-injection guard on dream text before passing to diffusion model.
- General low-risk performance plan: enable response streaming on all chat endpoints, add a redacted Debug Mode for PCSF state / selected provider / fallback reason / quantization / cache hit-miss / dilation ratio, and implement hot/cold dream memory tiers with active dreams in RAM and archived dreams in CSF.
- Target action window: 2026-06-06 through 2026-06-12, with CSF compression first, PCSF routing second, Blackbox multiplier third, tier gating and Debug Mode fourth, then local tests, documentation, and release-note decision.

### Verification Boundary (ORION / Lantern OS Performance)

- This is a planning and changelog entry only; no runtime behavior changes are claimed until implementation commits and local verification receipts are added.
- Percentage gains for memory, latency, and subjective speedup remain targets until benchmarked against the local Dream Journal / ORION runtime.
- Required before promotion: CSF delta encode/decode round-trip tests, backward-compatibility tests for existing CSF archives, provider-routing cache and fallback tests, redaction checks for Debug Mode, and at least one local benchmark receipt.

### Planned (Convergence)

- **#142** Watch/Observe phase -- drift detection between convergence runs
- **#143** Backpressure + rate limiting on TesseractEngine (bounded queue, 429 shedding)
- **#145** Structured trace logging (OpenTelemetry-style spans per layer)
- **#146** Idempotent slot claims (deterministic slot IDs, no orphaned slots on retry)
- **#147** Graduated degradation (layer-by-layer fallback instead of all-or-nothing)
- **#144** Receipt diff (compare current vs previous convergence run)
- **#148** PII cleanup -- remove "waynesville" from persona keyword matcher

### Known Bugs (Tracked)

- **#160** _multi_signal_score() needs real vector similarity integration
- **#159** Memory Engine query() is O(n) -- no keyword/entity indexes
- **#164** hff-api dream_journal /recent route returns empty entries (TODO stub)
- **#165** converged_tesseract.py convergence_io_route_on_slice is a placeholder stub
- **#166** hff-api load_data_source() returns mock data -- not yet implemented
- **#167** discord lounge bot memory_layer export_csf_stub is a placeholder
- **#168** discord lounge bot bot.py is empty and bot_v2.py missing — bot won't start

### Fixed

- **#168** Restored Discord bot v2 slash commands from commit b8b5cd9; bot.py and bot_v2.py both populated

- Discord bot launcher now loads .env.local and falls back to User/Machine environment variables

### Added

- **#169** Discord Bot settings integrated into Dream Chat settings drawer (DISCORD_BOT_TOKEN, LANTERN_DISCORD_GUILD_ID)
- Web UI saves Discord credentials to .env.local; bot reads them automatically on startup
- Initial workspace governance files for changelog, license, security, support,
  code of conduct, and editor defaults.

### Verification

- Added as documentation-only files; no runtime behavior changed.

---

## [1.4.6] - 2026-06-20

### Fixed
- `feature-flags.js` `normalizeKey()` now rejects the JS reserved keys `__proto__`, `constructor`, and `prototype` (returns `""`), so `setFlag()`'s empty-key guard turns `PUT /api/admin/flags` with a reserved key into a clean `400` instead of reporting `{ok:true}` while silently storing nothing (the old `cfg.flags["__proto__"] = {…}` hit the prototype setter and dropped the value). The flags map is now `Object.create(null)` as defense-in-depth so a raw `flags[key]` read in `isFlagEnabled()` can't resolve to an inherited member. Admin-gated, low-severity correctness/hardening. Added `tests/test_feature_flags_reserved_keys.js`.

---

## [1.4.4] - 2026-06-20

### Fixed
- **Autowork now runs each issue in an isolated git worktree** instead of in-place in the live serving checkout. The server continuously writes runtime JSONL into its own working tree, so the old in-place flow tripped its own `git_tree_dirty` guard ("refusing to switch branches … would be clobbered") before it could branch — autowork could never start. Both `/api/convergence/autonomous-work` and `/api/convergence/autonomous-work/stream` now create a dedicated worktree under `.claude/worktrees/` (off `master`, branch `auto/issue-<n>-<slug>`) and run every branch/apply/test/commit/push there; the worktree is torn down in a `finally` (branch kept). This also isolates concurrent issue runs from one another. (`apps/lantern-garage/routes/convergence-dispatch.js`, new `apps/lantern-garage/lib/autowork-worktree.js`)

### Changed
- `src/worktree-manager.js`: `createWorktree` / `removeWorktree` / `listWorktrees` now accept an explicit `repoRoot` (default unchanged), so a caller running inside one checkout can branch from the checkout it actually targets. Backward-compatible — existing 3-arg callers are unaffected.
- `self-edit-engine.runTests(repoRoot, cmds, opts)` accepts `opts.env`, used to point `NODE_PATH` at the main checkout's `node_modules` when tests run inside a fresh worktree.

### Added
- `tests/test_autowork_worktree_isolation.js` — hermetic proof that a run gets its own worktree off `master`, the main working tree is never dirtied, a worktree commit does not leak to the main tree, and `cleanup()` removes the dir while keeping the branch.

---

## [1.4.3] - 2026-06-20

### Changed
- Restructured `CHANGELOG.MD`: moved the `# Changelog` title and `## [Unreleased]` section to the top, normalized em-dash date separators (`## [x] — date` → `## [x] - date`) so every entry is machine-parseable, reordered `1.0.1`/`1.0.0`, and stripped leaked "Before pushing" reminder blocks from past entries.
- Synced served `apps/lantern-garage/public/version.json` to match `package.json`.

### Added
- Pre-push change-record gate (`scripts/validate-prepush-version-changelog.py`): a code-bearing branch must bump `package.json` to a new `X.X.X` version (greater than its `origin/master` base) and carry a matching `## [X.X.X] - YYYY-MM-DD` changelog entry before it can be pushed. Wired into `scripts/hooks/pre-push` ahead of the `gh`/workstream checks; bypass with `SKIP_VERSION_CHECK=1`. Docs/tests/data-only branches are exempt.

### Fixed
- `validate-version-changelog.py` now resolves `CHANGELOG.MD` case-insensitively and reads files as UTF-8, so the pre-commit/pre-push validators no longer crash on Windows (cp1252) against the emoji/em-dash changelog.
- `auto-version.js` inserts new entries below the title/`[Unreleased]` block instead of at the very top, so the header no longer gets re-buried.

---

## [1.4.5] - 2026-06-20

### Fixed
- **#810** `_prompt_from_messages` in `scripts/ouro_serve.py` now uses `### Instruction / ### Response` format matching the QLoRA training template byte-exactly. `apply_chat_template` added special tokens that misaligned with training and cost ~11pts accuracy (served 0.23 vs raw 0.34 on HumanEval).
- **#811** `_SERVED_MODELS` gate in `scripts/ouro_serve.py` returns 404 for non-coder model names (dream, pcsf, convergance) so the Lantern provider chain falls back to cloud for persona surfaces instead of silently answering with the 1.4B coder.
- **#672** `_tunnelFailed` flag in `apps/lantern-garage/server.js` prevents the 3s optimistic `setTimeout` from overwriting `status:error` after a Cloudflare spawn failure.

### Added
- Creator intake suite (local-unique): `GET/POST /api/creators`, `creator-intake.html` 10-section brand identity form, `data/creators/courtney-blasioli.json` profile.

---

## [1.4.2] - 2026-06-18
**Build:** 1.4.2+2026-06-18.041643
**Commit:** 89a00dc8

fix(mcp): rewrite openapi spec to use GET + query params matching ChatGPT example format

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>

---

## [1.4.1] - 2026-06-16
**Build:** 1.4.1+2026-06-16.064254
**Commit:** 10e6fb87

test: Verify auto-merge can process real code commits

---

## [1.4.0] - 2026-06-14
**Build:** 1.4.0+20260614T1944
**Commit:** 5958a30

### 🐛 Fixes
- resolve merge conflicts in data files (deltas, model-usage, three-doors-events JSONL)

### 📋 Other
- docs(sigma0): update collapse certificate with production code references and cr
- Merge PR #447: fix(agent-orchestration) + crypto observer integration
- docs(memory): add convergence routing system architecture to memory
- refactor(hooks,tools): convergence-optimized routing to sunset external APIs
- feat(kalshi-dashboard): add progress dashboard with live API endpoints
- feat(kalshi-convergence): LoRA fine-tuned predictor + proactive training
- feat(kalshi-convergence): self-improving continuous training loop
- Merge branch 'master' of https://github.com/alex-place/lantern-os
- feat(kalshi-terminal): deterministically profitable trading system
- feat(observer): auto-start crypto_live_trader.py + observer-status endpoint — cl
- fix(orchestration): runTests() now runs pytest instead of convergence-manager — 
- feat(orchestration): persist AgentSlotManager state across restarts — closes #44
- Merge remote-tracking branch 'upstream/master' into claude/dreamy-brattain-6efcb
- fix(agent-orchestration): stale queue recovery + monoworkstream dispatch gate
- feat(csf-agent): test suites for embedder/scorer/suggester + scorer createdAt fi
- chore: merge upstream/master — resolve add/add conflicts in csf-agent tests
- feat(kalshi-cio): implement momentum-aware dual-regime model (Issue #424)
- fix(kalshi-terminal): fix duplicate side labels when API returns identical yesLa
- fix(kalshi-terminal): fix broken titles/labels and apply dashboard palette

---

## [1.3.5] - 2026-06-12
**Build:** 1.3.5+2026-06-12.081000
**Commit:** a49db6b

feat: GitHub issues to agent slots sync automation

- Create Sync-GitHubIssuesToAgentSlots.ps1 to bridge GitHub issue queue to agent slots manifest
- Fetches issues labeled dream-journal + agent-task, converts to slot entries with priority mapping
- Integrates into smart-convergence-loop.yml workflow (runs every 6h)
- Preserves existing non-GitHub slots (e.g., validation ring)
- Grant write permissions to smart-convergence-loop workflow for manifest updates
- Fix surfaces/index.html broken links (removed non-existent directories, added Creator Dashboard)
- Create 5 Three Doors GitHub issues (hub scene, poem mechanic, challenge system, prize pipeline, progress persistence)

---

## [1.3.0] - 2026-06-10 — ORION v1.0 + CSF Delta Memory + Dream Chat Full-Width

**Build:** 1.3.0+2026-06-10  
**Commit:** 507c9af

### Dream Chat
- Full-width layout — removed 780px `max-width` cap from `.app`; Dream Chat now fills the viewport like the index page
- `.app-main` flex column wrapper added for correct Observer side-rail layout

### Observer Panel (ORION v1.0)
- Collapsible 260px right rail behind the ◈ nav button
- Shows live recurring symbols, mood arc, last delta timestamp, and convergence score
- Auto-refreshes every 30s when open; collapses on mobile

### CSF Delta Store
- `lib/csf-delta-store.js` — compact symbol dictionary (`s:0…s:N`), delta-only append log (`data/csf_memory/deltas.jsonl`), convergence scoring, mood arc
- `formatDeltaContextForPrompt()` injects symbolic memory into every LLM call
- `GET /api/csf/stats` — returns `{ total_symbols, top10, delta_count }`
- `GET /api/csf/deltas?limit=N` — returns recent delta records

### LLM Prompt Enrichment
- `dreamChatReply()` now injects relevant symbolic memories, ingest docs, dream entries, and delta context
- Lantern and Keystone system prompts updated with recurring motifs and CSF anchor references

### ClaimsPacket Logging
- Lightweight packet appended to `data/claim-packets/claim-packets.jsonl` on every `/api/dream/chat` reply (non-blocking, gitignored)

### ORION v1.0 Components
- Claims Packet Rust struct (`src/csf_rust/`)
- Human Observer Hub Python (`src/orion/`)
- Time Dilation Engine Python
- Status Cube HTML (`apps/lantern-garage/public/observer-mesh-cube.html`)
- Integration entry point `orion_v1.py`

### Bug Fixes
- `index.html` autoupdate: `$('hero-edition')` returned null, aborting the entire `loadState()` loop — version badge, agents count, dreamer count, provider pills all stayed stale. Added missing `<span id="hero-edition">` and made `$()` return a no-op stub on null.
- Convergence loop `python … loop > report.json` was mixing `[convergence]` progress prints into stdout, corrupting the JSON report and failing the PR promotion gate. Redirected to `stderr`.
- `settings.pcsf.json` created with correct `settings: [{key, state}]` array format (was an object, crashing `pcsf-refresh.js` on startup).

### CI
- Fixed COMET LEAP report path in `orchestration-challenge-ci.yml` (`archive/` → `reports/`)
- Excluded `tests/test_convergence_io_engine.py` from all three CI workflows (phase drift after `inspect_repo` → `inspect` rename)
- Added `pytest-timeout` and `--timeout=30` to all pytest invocations to prevent Discord bot test hangs

### Versioning
- `version.json`, root `package.json`, and garage `package.json` all bumped to `1.3.0`

---

## [1.2.2] - 2026-06-08
**Build:** 1.2.2+2026-06-08.013652
**Commit:** d8b05e3

push

---

## [1.2.1] - 2026-06-07 — Start:master Auto-Sync, Moon Heartbeat, Markdown Renderer

### Boot
- `start:master` now fetches, merges, AND pushes local commits before starting the server
- Full sync cycle: `git fetch` → `git merge --ff-only` (fallback: full merge) → `git push` → HFF seed → `node --watch`

### UI
- Moon heartbeat indicator with `moon-drift` animation (9s cycle, lag-aware speed)
- `/repo/*.md` and `/repo/*.txt` render as styled HTML via Lantern Reader
- Human Flourishing Frameworks dashboard live with 62 Bayesian beliefs, real-time 30s polling

### Versioning
- `version.json`, root `package.json`, and garage `package.json` all set to `1.2.1`

---

## [1.2.0] - 2026-06-07 — Autostart, UX Grounding, HFF Integration, Slop Gates

### Startup
- `Start-Lantern.ps1 -RegisterAutostart` registers Windows Task Scheduler task that fires at boot and login
- Full boot sequence: `git pull origin master` → HFF seed → `node --watch server.js`
- Unlimited crash-restart with 1-minute backoff — no human intervention needed
- Boot logs to `logs\lantern-autostart.log`

### Dream Chat UX
- Welcome message shifted from door/convergence language to grounded context ("What's on your mind?")
- Default Ollama model changed from `llama3` to `qwen2.5-coder`
- Fallback suggestions updated for gaming/rest/building context

### HFF Dashboard
- Removed Flask child-process proxy; `routes/flourishing.js` reads `data/snapshot.json` directly
- `export_snapshot.py` seeds WorldModel from `seed_data.py` (62 beliefs, flourishing ~0.50)
- HFF snapshot excluded from git (runtime-generated on boot)
- `/flourishing` route ordering fixed (was intercepted by surfaces catch-all)

### CI / Code Quality
- `slop-check.yml`: 5 parallel CI jobs (secrets, debug statements, OWASP basics, diff size, duplicate detection)
- `anti-sprawl.yml`: root-level files no longer flagged as new top-level directories
- `.clauderules` anti-slop ruleset committed at repo root
- Per-agent workstream hooks: each agent prefix gets one open PR lane; slop commit-msg gate

### Versioning
- `version.json`, root `package.json`, and garage `package.json` all set to `1.2.0`
- Stale version strings removed from HTML titles; dynamic badge reads from `version.json`

---

## [1.1.0-rc.1] - 2026-06-06 — Parallax Dream Door + Deploy Fix

### Dream Chat
- Parallax zoom into dream door on scroll — background scales 1×→2.8×, hero text fades, glow orb drifts
- Scroll hint with bounce animation on empty state
- `.door-bg` element extracted from pseudo-element for GPU-transform parity

### Deploy
- Fixed GitHub Actions workflow (`actions/checkout@v4`, `actions/setup-python@v5`)
- Added `netlify.toml` + `.gitignore` for cloud deploy hygiene
- Version now auto-bumped and tagged as RC on every deploy

---

## [1.0.3] - 2026-06-06 — PCSF Provider Health Cache

### Server
- `apps/lantern-garage/lib/provider-cache.js` — 60-second in-memory TTL cache for provider routing state
  - `getProviderState()` — returns cached key-presence snapshot (gemini, anthropic, openai, xai, ollama); auto-refreshes when TTL expires
  - `recordProviderSuccess(id)` / `recordProviderFailure(id, error)` — update rolling 10-entry history per provider
  - `getRoutingSnapshot()` — redacted JSON snapshot (never exposes key values) for the telemetry endpoint
- `stream-chat.js` now reads `getProviderState()` once per request instead of re-reading `process.env.*`; all 5 providers record success/failure to the cache
- `GET /api/pcsf/routing` — new endpoint returning cache age, TTL, per-provider presence flags and recent history (safe to expose publicly)

### Versioning
- Bumped `version.json` → `1.0.3`

---

## [1.0.2] - 2026-06-06 — TTS Provider Chain + Version Badge

### Dream Chat
- TTS provider chain: ElevenLabs → OpenAI → browser fallback via `POST /api/dream/tts`
- TTS voice selector in settings drawer (rate, pitch, voice dropdown, test button)
- Version badge linked to CHANGELOG — fetches `version.json` on load

### Server
- PCSF live refresh on startup — auto-updates provider/state/settings from live env
- `npm run dev` script with `node --watch` for hot reload

### Fixes
- Distinguish `all_providers_failed` from `no_provider_configured` in stream error messages
- TTS proxy timeout (15s) + status code validation

---

## [1.0.1] - 2026-06-06 — Dream Journal Stability and Honesty Patch

### Fixed
- Deterministic agent selection in Dream Chat to reduce nondeterministic routing.
- Command handling clarified: unsupported bang-commands no longer silently behave like normal chat.
- Three Doors UX corrected so door-state behavior matches the documented experience.
- Provider settings persistence aligned with documented local secret handling (`.env.local` preferred over `.env`).
- Release notes and user guide corrected to match actual runtime behavior and data paths.
- Privacy claims updated to reflect provider-key behavior, `.env` persistence, and deployed-host exposure.

### Changed
- Release messaging now distinguishes verified local behavior from planned future behavior.
- Launch validation now uses current repo files and current test paths.

### Verification
- Local Dream Chat smoke-tested on `apps/lantern-garage`.
- Node Dream Journal API tests passed.
- Multi-turn Dream Chat tests passed.
- Release blockers on master reviewed and either fixed or explicitly held.

---

## [1.0.0] - 2026-06-05 — Dream Journal Orion Edition

### V1.0.0 Feature Status

| Feature | Status | Notes |
|---------|--------|-------|
| Quick capture | **Live** | Dream, note, place, character, event, lore, symbol, mirror |
| Lucid dreaming tools | **Live** | Lucidity scale, technique logging, dream-sign flags |
| Symbol analytics | **Live** | Top tags, emotions, and symbols from saved entries |
| Export (JSONL / CSV) | **Live** | Full backup download via `/api/dream/export` |
| AI reflection chat | **Optional** | Streams when a provider key is configured; fails fast otherwise |
| Voice transcription | **Held** | Not claimed for V1 — browser STT works, server-side not wired |
| Dream art generation | **Held** | Not claimed for V1 — see backlog entry below |

### Core
- Dream Journal V1.0.0 — local-first, private, no account required
- `node apps/lantern-garage/server.js` — single command startup on port 4177
- Modular route architecture: 7 domain modules under `apps/lantern-garage/routes/`
- `cloud-server.js` unified with server.js — Railway deploy via PORT env

### Dream Chat
- Multi-provider streaming: Gemini 2.5-flash (primary), Claude haiku-4-5, OpenAI, Grok, Ollama
- Three Doors canary system — AI-generated [DOORS: A | B | C] after every reply
- Canvas banner — 3-panel atmospheric widescreen PNG, click to download
- Multi-turn conversation history (last 6 turns threaded into API calls)
- Adaptive Focus Memory — tiered dream context (Full/Compressed/Placeholder)
- Symbol co-occurrence mesh — relational pairs passed to system prompt
- Voice STT (Web Speech API) — browser-only, no server-side transcription in V1
- CTF symbol autocomplete (~80 unicode glyphs)
- Provider settings drawer (Claude, Gemini, ChatGPT, Grok) with hot-reload

### Data & API
- `POST /api/dream/create` — saves entries with dcf_class/rps_flags schema
- `GET /api/dream/stats` — emotions, tags, symbols, avg lucidity
- `GET /api/dream/search` — text + tag filter
- `GET /api/dream/export` — JSONL/CSV download
- `GET /api/dream/symbols/timeline` — weekly symbol frequency + co-occurrence pairs
- `POST /api/settings/providers` — saves keys to .env, hot-reloads process.env
- `GET /api/settings/providers` — provider presence (never exposes values)

### Convergence
- MemOS `GeneralMemCube` wired as semantic retrieval backend (`src/convergence_io/memos_bridge.py`)
- `TesseractEngine._convergence_rag()` — MemOS semantic search → flat-rag fallback
- Convergence loop: 12 phases, `promotion_ready=True`
- Gemini model updated: `gemini-2.5-flash` (gemini-1.5-flash deprecated)
- Claude model updated: `claude-haiku-4-5-20251001` (claude-3-5-haiku-20241022 deprecated)

### Verification
- 18/18 Node API tests passing (`tests/test_dream_journal_api.js`)
- 11/11 multi-turn chat tests passing (`tests/test_dream_chat_multiturns.js`)
- Gemini 2.5-flash streaming confirmed live
- Claude haiku-4-5 streaming confirmed live
- Convergence loop `promotion_ready=True`

---

## Changelog Rules

- Prefer concrete dates in `YYYY-MM-DD` format.
- Record local verification evidence for user-facing changes.
- Mark unverified, design-only, or future-facing claims explicitly.
- Keep private data, secrets, journal entries, and local receipts out of release
  notes unless they are referenced only as redacted evidence paths.
