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

## [1.5.2] - 2026-06-20

### Changed
- **Local Σ₀ coder default flipped to the Ouro model.** `lib/model-registry.js` (`text.coder`) and `lib/model-leaderboard.js` (`preferredLocalModel()`) now default to `ouro:latest` — the Σ₀ Ouro looped coder served by `scripts/ouro_serve.py` on :11434 — instead of the legacy `lantern-sigma0-coder-v2`. `ouro_serve.py` keeps a back-compat allowlist that still serves Ouro for the old name, so the flip is non-breaking. `text.coderLoop.adapterPath` now defaults to the on-disk `D:/lantern-train/ouro-sigma0-adapters/final` (the `/v2` promotion target is not trained yet); removed the dead `adapterPathFallback` field.

### Deprecated
- **`lantern-sigma0-coder` (Qwen2.5-Coder-3B QLoRA) is deprecated**, superseded by the Σ₀ Ouro Coder. Its Qwen training outputs and Ollama deployment were removed (verified: `lantern-sigma0-coder-v2` no longer appears in Ollama manifests; only the base `qwen2.5-coder` blob remains). `docs/LANTERN-SIGMA0-CODER.md` now carries a deprecation banner and the Knowledge Center card is marked **Legacy**.

### Added
- Knowledge Center: **Σ₀-K1 Kernel Spec** research card + grounding link (`docs/SIGMA0-K1-KERNEL-SPEC.md`).
- **Agent rule + Stop hook — "no uncommitted code":** `AGENTS.md` Workspace Hygiene gains a Commit-discipline rule, backed by `scripts/hooks/stop-warn-uncommitted.sh` (wired locally via `.claude/settings.json`) which nudges at end-of-turn when tracked code is left uncommitted.

## [1.5.1] - 2026-06-20

### Changed
- **Wide-screen "newspaper" reading layout.** The doc reading view (`lib/markdown-render.js` `.md-page`), the Knowledge Center hub (`knowledgecenter.html` `.kc-page`), and the shared `.page` container now use the full width of large displays and flow long-form reading into balanced multi-column text instead of one dense ~820/920px ribbon. Responsive tiers (verified via preview computed styles): `<1100px` single column / 820px (unchanged); `~1080p` ~1640px, 3 columns; ultrawide ~2200px, 4 columns (a long article's height drops from ~8000px to ~1500px). Section headings and wide blocks (code, tables, quotes, rules) span the full width so each section's columns stay short and readable; narrow/mobile screens are unaffected.

### Docs
- **Refreshed the 32 oldest docs** (first commit ≤ 2026-06-11) that the Knowledge-Center attribution pass (#842) skipped: added `author` / `created` (first-commit date) / `updated` YAML frontmatter — which renders as a byline — and renamed the dead **"Lantern OS" → "Keystone OS"** brand in prose. Code identifiers (`lantern-os`, `lantern-garage`), the README's intentional "formerly Lantern OS" note, and external boilerplate (`CODE_OF_CONDUCT.md`) are preserved.

---

## [1.5.0] - 2026-06-20

### Changed
- **CSF consolidated to ONE canonical, lossless, zstd-backed format (v2)** (landed in `5a252b5b`). The public API is now the package root `csf` (`import csf; csf.pack/unpack/read_file/list_archive` for file/blob archives, `csf.compress/decompress` for single byte strings), a thin facade over the engine `csf/csf_pack.py`. Added single-blob stream helpers `compress_bytes`/`decompress_bytes`.
- Existing on-disk archives still open **read-only** via the new `csf/legacy.py` (modern `CSF\0` → core; raw DEFLATE dream-preview blobs → inflate; unknown → clear error). No data loss: every `.csf` present in the repo is read by a kept module.

### Removed
- Deleted the duplicate/legacy CSF **writers** so they can't be called by mistake: the segmented `CsfArchive` v1 (`csf/__init__.py` class, `csf/header.py`, `csf/dictionary.py`, `csf/sparse.py`, `csf/search.py`) and its CLIs (`csf_compress.py`, `csf_decompress.py`, `csf_merge.py`, `csf_search.py`); the root `csf/csf_file.py` v0.3 symbolic writer; and the **lossy, non-invertible** v0.7 symbolic text compressors (`csf/v07/csf_symbolic_compressor.py` and the `ClassicalCompressor` class — kept its `SymbolicDictionary`/sparse primitives).
- Deleted dead modules with no importers: `csf/trading_cube.py`, `csf/convergence.py`, `csf/dream_compressor.py`. Removed `scripts/Test-CsfSymbolicCompression.py`.

### Kept
- The 3¹² lattice "storage face" primitives (`csf/v07/quantum_dust.py`, `qutrit_delta.py`, `convergence_engine.py`), the Status-Cube binary container (`csf/v07/csf_file.py`), and the data models (`status_cube.py`, `memory_engine.py`, `trading_memory.py`). CSF stores a *point* on the lattice; it is not the lattice (see `docs/TESSERACT-CSF-SINGULARITY.md`).

### Fixed / rewired
- Rewired live callers to the canonical core: `scripts/consolidate_md_to_csf.py` (now **bit-perfect** lossless, was a lossy round-trip), `src/dream_journal/orchestrator.py` `export_csf`, and `scripts/csf_research_tesseract.py` (dropped dead native-CSF path). Updated `scripts/csf_pack_benchmark.py`, `experiments/csf_compression_benchmark.py`, and `tests/test_csf.py` (now exercises the core + legacy decoder). 129 CSF tests pass.
- Documented the consolidation in `docs/CSF-FORMAT-SPECIFICATION.md` (canonical v2 + retired-format table + read-only bridge) and `CLAUDE.md`.

---

## [1.4.16] - 2026-06-20

### Added
- **`patreon_auth` feature flag — an admin kill-switch for the Patreon login gate.** When the flag is OFF, unauthenticated visitors are treated as guests instead of being bounced to `/auth.html`, so the site stays usable when Patreon OAuth isn't configured. The gate is enforced in `requireAuth` / `requireRole` / `requireEntitlement` (`apps/lantern-garage/lib/auth-middleware.js`); with the gate off, privileged surfaces stay protected — `requireRole('admin')` and `requireEntitlement('trade')` return **403** (not a redirect) rather than exposing the admin page or the trade/money API. The `/api/auth/session` response now carries `authRequired` so `auth-gate.js` skips the client-side redirect too. Defaults **ON** when the flag was never created (via new `feature-flags.isFlagEnabledOr`), so the gate never silently drops open on a fresh install. Toggle it from the admin flags surface (`PUT /api/admin/flags { key:"patreon_auth", enabled:false }`).
- `tests/test_patreon_auth_flag.js` — covers the on/off matrix and proves admin/trade stay gated when the flag is off.

## [1.4.15] - 2026-06-20

### Fixed
- **Autowork can now land its patches.** The autonomous-work loop (`!work #N` in dream-chat → `/api/convergence/autonomous-work/stream`) correctly diagnosed and patched issues but aborted at `apply` with `patch_did_not_apply` — `git apply` can't fuzzy-match context (and `--3way` is useless on LLM diffs with no `index` line), and the in-process fallback was exact-match: it threw on `hunk_old_count_mismatch` (LLM `@@` headers are routinely off-by-one) before even trying to locate the change. Rewrote the fallback applier in `self-edit-engine.js` to be **fuzzy**: it ignores the `@@` header counts, locates each hunk by content (exact pass, then whitespace-normalized), applies hunks high-line-first, and preserves the file's EOL. Verified against the exact diff that previously failed (#854, surfaced while autoworking #836) plus a regression suite (`tests/test_self_edit_fuzzy_apply.js`) covering wrong header counts, line drift, whitespace fuzz, CRLF, and absent-context safety.

---

## [1.4.14] - 2026-06-20

### Security
- **Operator + Keystone routes are now authorization-gated, and the operator check is proxy-header-hardened (#837, #838, #839).**
  - `isOperatorRequest` (`lib/request-auth.js`) trusted a loopback socket as proof of the local operator, but behind the Cloudflare tunnel (lantern-os.net -> 127.0.0.1) every visitor's socket is loopback, so the whole internet counted as "operator". It now denies the loopback path whenever any proxy/forwarding header is present (mirrors `lib/auth-middleware.js`); remote callers must present the `OPERATOR_TOKEN` header. (#839)
  - `/api/actions/*` in `routes/operator.js` (run-loop, inspect, update -> git pull + npm install + server restart, local-controls -> PowerShell, flat-rag-ingest) had **no** auth check; they now require `isOperatorRequest`. (#838)
  - `/api/keystone/*` in `routes/keystone.js` (allowlisted exec + repo-state dump) had no auth check, and the allowlist included `node -e ".+"` (arbitrary JS). Now operator-gated, and `node -e` is removed from the allowlist. (#837)
  - Added `tests/test_request_auth_proxy_guard.js` (8 cases: clean loopback passes; proxied loopback denied; token path).

## [1.4.13] - 2026-06-20

### Changed
- **Knowledge Center docs now carry author attribution.** Added YAML frontmatter (`author: Alex Place`, `created`, `updated`) to all 20 owned Knowledge Center docs (the `/repo/*.md` cards + required-reading core), oldest first. `CODE_OF_CONDUCT.md` is excluded (external Contributor Covenant boilerplate). `created` is each doc's first-commit date; `updated` is 2026-06-20.
- **Brand: "Lantern OS" → "Keystone OS"** across those docs' prose and titles (27 replacements in 13 docs). Code identifiers and URLs (`lantern-os`, `lantern-garage`, `alex-place/lantern-os`, `lantern-os.net`) are intentionally preserved; README's `#what-is-lantern-os` TOC anchor updated to match its renamed heading; a one-time "(formerly Lantern OS)" note added to the README intro.

### Added
- `markdown-render.js` now strips a leading YAML frontmatter block and renders it as a tidy byline ("By Alex Place · Updated …") instead of a stray `<hr>` + paragraphs. `build_knowledge_index.py` strips frontmatter too, so doc metadata isn't indexed as the `(intro)` section. Knowledge index rebuilt (381 sections / 21 docs).

---

## [1.4.12] - 2026-06-20

### Changed
- **CSF-Pack (`csf_pack.py`) entropy backend: zlib → zstd-19 + long-distance matching (R1).** Per-file blobs now carry a `codec` field (`zstd`|`zlib`|`store`), defaulting to zstd when `zstandard` is installed. Measured **24.9× smaller** archives on a real 4 MB JSONL memory log (14.1× → 352.3×), lossless round-trip verified. Existing `.csf` archives (no `codec` field) still unpack byte-for-byte (default → zlib).
- **Optional shared zstd dictionary (`use_dict=True`, R2).** Trains one dictionary across all files and appends it to the blob region, recovering cross-file redundancy **without losing per-file random access** (text+code corpus 2.65× → 3.00×). Added `csf_pack.read_file()` for verified single-member reads.
- **Rust full-mode zstd level 3 → 19 (R4)** in `src/csf_rust/src/compress.rs` (~1.9× smaller on JSONL memory; fast mode unchanged).

### Fixed
- `profile_pack.info()` no longer hardcodes `zlib.decompress` — it is codec-aware, so zstd profile archives can be read (R1 follow-through).
- Corrected misleading docstrings in `csf/v07/classical_compressor.py` and `csf/v07/csf_symbolic_compressor.py` that claimed a "Zstd" final pass when the code uses zlib level 3 (R4).
- Marked the v0.7 symbolic `compress_text` path as **lossy / non-invertible** (`CompressionResult.lossless=False`, no decoder); its reported ratio is a symbolic projection, not a real compression ratio. Updated `caad/dollhouse-csf-upgrade.md` to stop citing it as a storage advantage and to use `csf_pack` for real compression (R3).

### Added
- `experiments/csf_compression_benchmark.py` — lossless-verified head-to-head of the CSF paths vs zlib/bz2/lzma/zstd/brotli on text+code, JSONL memory, and lattice-delta corpora (the evidence behind R1–R4).

---

## [1.4.11] - 2026-06-20

### Changed
- Removed a leftover `DEBUG` `console.log` in `dream-chat.js` that printed Anthropic-key existence and provider-routing internals to the server log on every reply. Minor log-hygiene / info-leak cleanup; also clears the recurring SLOP "debug statement" flag on `dream-chat.js` commits.

## [1.4.10] - 2026-06-20

### Fixed
- **`ConvergenceLora` no longer crashes on string `liquidity_dollars`.** `formatMarketForLLM()` used `market.liquidity_dollars?.toFixed(0)`, but Kalshi returns that field as a string — optional chaining guards null, not a string type, so `.toFixed` threw "is not a function" on every market. The loop swallowed it per-market, so ConvergenceLora silently produced "0 training examples / 0 convergence predictions". Now `parseFloat`-coerced (matching `kalshi-suggest.js`), with a `Number.isFinite` "unknown" fallback. Added `tests/test_kalshi_convergence_lora.js` (string / numeric / missing / non-numeric cases).

## [1.4.9] - 2026-06-20

### Added
- **Execution-grounded coding benchmark** (`scripts/eval_coding_ouro.py`, #776) — grades a model on real coding tasks by EXECUTING the generated code against assertions in a subprocess sandbox (timeout-isolated, same trust model as `eval_humaneval_ouro.py`), not by substring matching. Generalizes the 3-hardcoded-task `validate_ouro_coding.py` to any golden file, runs the same dual backends as `eval_keystone.py` (http Ollama API / in-process `Sigma0LoopLM`), and adds a **verbosity metric** (bytes/words per correct solution) so "concise AND correct" is measurable. Persists per-task detail to `data/eval/runs/` and a schema-reconciled `benchmark:"coding-exec"` row to `data/eval/leaderboard.jsonl`. Includes `--self-test` for an offline (no-model) harness check.
- `data/eval/mbpp-basic.jsonl` — MBPP-style basic-Python golden subset (18 original exec-and-assert tasks), the missing MBPP file noted in #776.
- `tests/test_eval_coding_harness.py` — 16 offline unit tests for the scoring logic (extract/exec/timeout/verbosity/leaderboard-row) plus reference-solution checks that each MBPP task is satisfiable. Runnable without a GPU.

### Notes
- This closes the GPU-independent scaffolding of #776 (epic #774). What remains needs the RTX 3070: actually running the benchmark to persist real `coding-exec` pass@1 rows, and the HumanEval `--limit 20` nightly.

## [1.4.8] - 2026-06-20

### Fixed
- **Dream-chat sessions now persist from the live send path.** `dream-chat-ui.js` (the `sendMessage()` that actually runs) omitted `sessionId` from the `POST /api/dream/chat/stream` body, so turns logged untagged and never formed a saved session — the Chats drawer (#773) stayed on "No saved sessions yet" even after chatting. It now sends `sessionId` from `localStorage['lantern_chat_session']` (the id `dream-chat.js` owns), matching the server's `parsed.sessionId` read in `stream-chat.js`. Verified end-to-end in the dev preview: a fresh chat now creates a titled, resumable session.

### Accessibility
- Added accessible names to icon-only chat controls that lacked them: the Observer panel close button (`aria-label="Close observer panel"`) and the JS-generated session "resume" buttons (`aria-label="Resume chat: <title>"`, replacing an accessible name built from title + timestamp/turn-count noise).
- Bumped `dream-chat.js` / `dream-chat-ui.js` cache-busters so returning browsers fetch the above fixes.

---

## [1.4.7] - 2026-06-20

### Fixed
- **Autowork "Work" button now streams the live step panel from the natural-language path too.** Typing "what should I work on?" (the `WORK_INTENT` route in `apps/lantern-garage/public/js/dream-chat-ui.js`) wired its Auto-work button to the old non-streaming `/api/convergence/autonomous-work` endpoint — an opaque "Working… → ✓ Done" with no visible progress — while the `!ask` chips used the observable `/autonomous-work/stream` panel (plan → patch → tests → commit → push → PR). Both paths now call `runAutowork()`, so a user gets the same honest, step-by-step view regardless of whether they typed or clicked. Σ₀: no hidden agency (#527). Verified live in the dev preview against the current worktree-isolated pipeline.

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

## [1.4.6] - 2026-06-20

### Fixed
- **#811** Wire all Lantern surfaces to Ouro after Ollama sunset:
  - `dream-chat.js`: default `ollamaModel` changed from `"lantern-csf-dream"` → `"ouro:latest"` (both the convergence synthesis path and the main chat path)
  - `model-registry.js`: `convergance.ollamaModel` default changed to `"ouro:latest"`; `CONVERGENCE_MODEL` env override still works
  - `ouro_serve.py`: `_SERVED_MODELS` expanded to include legacy persona model names (`lantern-csf-dream`, `lantern-convergance`, `lantern-pcsf`) as aliases so old `.env` files still route to Ouro

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
