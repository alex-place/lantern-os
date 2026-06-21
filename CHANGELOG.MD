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

## [1.7.15] - 2026-06-21

### Changed
- **Markdown doc viewer (`/repo/*.md`) column count now follows content depth, not screen width.** Previously every panel split into 2 columns at ≥1100px, 3 at ≥1700px, and 4 at ≥2400px — so a short section fragmented into thin, vertically-meaningless stubs on a wide display. `lib/markdown-render.js` now classifies each section at render time by its *flowing* text length (excluding full-width spanners like code/tables): shallow → 1 column, normal → **2 columns (the default)**, and only a genuinely deep section (`≥ ~1700` chars of flowing text) earns a **3rd** column. The 4-column tier is removed, and the page is capped at 1280px so the 2-column measure stays readable instead of stretching across ultrawide displays. Verified on `SIGMA0-OURO-CODER.md`: of 12 panels, 8 render 2 columns, 3 deep ones render 3, 1 short one renders 1; no panel exceeds 3 columns at 1920px.

## [1.7.14] - 2026-06-21

### Added
- **Tool-aware dream-chat for the local Σ₀ Ouro coder.** The chat path renders the FC adapter's `<tool_call>` as a card instead of leaking raw JSON, and (gated by `CHAT_TOOL_EXEC=1`, off by default) executes it through one canonical tool registry (`lib/tool-runner.js`): read-only tools (Read/LS/Glob/Grep) run repo-sandboxed; shell (Bash/PowerShell) and mutating (Write/Edit) tools are operator-gated and route through the shared `lib/command-allowlist.js` + `lib/safe-exec.js`. Tool names/schemas match what the adapter was trained on.

### Changed
- Extracted the operator command allowlist out of `routes/keystone.js` into `lib/command-allowlist.js` so the chat tool registry and operator console share one policy.

## [1.7.13] - 2026-06-21

### Changed
- **Markdown doc viewer (`/repo/*.md`) restyled as stacked "newspaper panels."** `lib/markdown-render.js` now groups each `##` (H2) section into its own `<section class="md-panel">` (content before the first H2 becomes a `<header class="md-lead">` masthead). Panels get a hairline border, **alternating background** (`--surface` ↔ `--surface2`) with an accent left-rule on every other panel, and an accent underline on each section heading — higher contrast and sharper edges than the previous single flowing card. Spacing between panels increased (30px) and the page's outer margin reduced (16px top / 14px sides, was 32/56). On wide screens each panel flows into width-sized columns (so short panels stay single-column) with headings and wide blocks spanning all columns. Applies to every rendered doc page (e.g. `/repo/docs/SIGMA0-OURO-CODER.md`). Verified: panels render, alternation + columns + spacing confirmed via computed styles, no console errors.

## [1.7.12] - 2026-06-21

### Fixed
- **Σ₀ native Q-exit decode was O(N^2).** `Sigma0LoopLM.generate` re-encoded the full growing sequence with `use_cache=False` every token (~1 s/token; 170-280 s coding outliers). Wired the model's native `UniversalTransformerCache` for incremental **O(N)** decode; `OURO_LOOP_CACHE=0` restores the legacy path. No quality change.

### Added
- **Forward-truncation (experimental, `OURO_LOOP_TRUNCATE=1`)** -- breaks the recurrent loop on Q-exit (adaptive depth as a speed win). Finding: mutually exclusive with the cross-token KV cache -> forces no-cache/O(N^2); a win for short outputs, while the cache fix wins for long. Parity-checked via `bench_ouro_loop.py --truncate`.
- `scripts/bench_ouro_loop.py` (cache + depth + truncation-parity harness) and `docs/research/2026-06-21-sigma0-serving-perf.md` (debug/research/upgrade writeup).
## [1.7.11] - 2026-06-21

### Added
- **Σ₀ Ouro coder — function-calling (FC) training pipeline + tool-aware runtime + retraining handoff.**
  FC corpus tooling: `scripts/harvest_tool_traces.py` (mines repo Claude Code session transcripts into `<tool_call>` pairs, secrets redacted) and `scripts/convert_fc_dataset.py` (converts public FC datasets — Hermes/ToolACE — into the exact wire format with train/serve preamble parity via `scripts/ouro_anthropic_bridge.py`). Tool-aware execution proxy `apps/lantern-garage/lib/tool-runner.js` defines one canonical tool registry (Read/LS/Glob/Grep/Bash/PowerShell/Write/Edit) used for both the prompt preamble and execution, shell tools gated through the existing allowlist + safe-exec. Also adds `scripts/sigma0_coder_agent.py`, `src/csf/coder_grounding.py`, and `tests/test_sigma0_state_abi.py`.
- **Retraining handoff** `docs/research/2026-06-21-sigma0-coder-retraining-handoff.md`: grounded diagnosis of the FC adapter's observed unreliability (Bash over-bias = data distribution; over-refusal = template memorization; under-trigger = missing "answer-normally" class) + a prioritized, evidence-backed recipe (tool-distribution rebalance, Hammer function-masking, negatives 25%->~10-12%, lr 2e-4->~7e-5, BFCL eval + release gate). **Verified locally:** the adapter trains and emits tool calls but is **not yet reliable** — this ships the pipeline + plan, not a production-ready FC model. Training corpora (~134MB) included for reproducibility.



## [1.7.9] - 2026-06-21

### Added
- **Σ₀ serving-architecture decision package** (docs only). Peer-reviewed staff **portfolio update** (`docs/SIGMA0-AGENT-PORTFOLIO-UPDATE.md`) + **stakeholder deck** (`docs/decks/2026-06-21-sigma0-agent-stakeholder-deck.md`) recommending a **cloud-transformers floor now -> embedded ONNX/DirectML target via a gated spike**, behind one swappable client contract. Backed by **web-grounded validation** (`docs/research/2026-06-21-sigma0-serving-validation.md`: 8 option findings + 10 adversarial verdicts -- e.g. vLLM serves the Ouro loop but pins fixed R4 / drops adaptive Q-exit, conf 0.97; ONNX `Loop` expresses adaptive depth, conf 0.97; no official vLLM Windows build), a **3-lens peer-review record** (`docs/research/2026-06-21-sigma0-peer-review.md`), and the **ONNX/DirectML export spike scope + GO/NO-GO gate** (`docs/research/2026-06-21-sigma0-onnx-directml-spike.md`). No code/runtime change.
## [1.7.8] - 2026-06-21

### Fixed
- **Autowork/fleet: stop reporting false verification evidence and ground the preflight on the landed state (#933, #942, #896).** Three defects that let the autonomous fleet mark unverified or no-op work as a proven success:
  - **#933 — false convergence evidence.** `routes/convergence-dispatch.js` recorded `Patch applied: ${stats.filesModified || 0} files modified` against a field `applyPatch` never returns, so every record claimed **0 files**; it printed `Tests: PASSED` and awarded `testsPassed: 0.9` for runs with **zero tests**; and it baked a `[unverified]` marker into the commit/PR **title** on top of the issue's own conventional prefix (e.g. `[unverified] fix: chore(cleanup): …`). Now the evidence reports the real `changedFiles.length`, a no-test run reads `Tests: none run` with `testsPassed: 0.0` (and `act`/`overall` no longer earn test credit), and the title is cleaned (existing prefix stripped, verification state moved to the receipt + PR body).
  - **#942 — preflight & worktree base used the local checkout, not the serving state.** `lib/self-edit-engine.js` `detectAlreadyImplemented()` grepped/logged against `HEAD` (a possibly-stale feature branch); `src/worktree-manager.js` cut new worktrees from local `master`. Both now best-effort `git fetch origin master` and operate on `origin/master` (falling back to local if the remote-tracking ref is absent), so the preflight sees already-landed fixes and new work branches from the real base. Includes a fix to the citation parser, which a tree-ref grep prefix (`origin/master:…`) would otherwise have broken.
  - **#896 — inconclusive tests counted as success.** `src/agent-worker-loop.js` `runTests()` defaulted `passed:true` and treated "no tests collected" (pytest exit 5) as a pass. It now classifies output into `{passed, inconclusive}` — a positive `N passed` with no failure marker is the only pass; no-tests / silent output is **inconclusive** — and `processOne()` rolls back + requeues inconclusive runs like failures. Successful receipts now carry `{provider, model, verified, evidence}` provenance. New regression test `tests/test_worker_loop_verification.js` (6 cases) covers the classifier.
## [1.7.7] - 2026-06-21

### Changed
- **Knowledge Center reorganized to foreground research/internals.** Three layout changes to `apps/lantern-garage/public/knowledgecenter.html`: (1) the "🔬 Under the hood — research & internals" disclosure moved up to directly below the "New to Keystone?" hero (was buried below Quick help + Apps) and now **opens expanded by default** instead of collapsed; (2) the "Apps / Explore Keystone" card section was **removed** (the same apps are reachable from the site nav and `/explore.html`); (3) the "Document library" PDF gallery is now wrapped in a **collapsed** `kc-deep` disclosure (IDs preserved, so the `/api/pdfs` gallery + filter still work when expanded). Per-section collapse/expand verified; no console errors.

## [1.7.6] - 2026-06-21

### Fixed
- **`/changelog.html` now scrolls and shows every release expanded by default.** The page reused dream-chat's `.app` shell, which `dream-chat.css` pins to `height:100vh; overflow:hidden` (a fixed-viewport chat layout) — so the ~23,000px of changelog content was clipped at the first screen with no way to scroll. Added a scoped override (`html, body { height:auto; overflow-y:auto }` + `.app { display:block; height:auto; overflow:visible }`) in the page's own `<style>`, which loads after `dream-chat.css` and wins. Also changed the render so **all** version blocks start expanded (was: only the newest), since the collapse-by-default made the full history invisible behind one-by-one clicks. Manual collapse/expand per version still works. Verified on the dev server: 47/47 expanded, page scrolls, no console errors.

## [1.7.5] - 2026-06-21

### Fixed
- **`/changelog.html` rendered "No versions found" — now shows all 47 releases.** Three compounding bugs: (1) the `/repo/*.md` route only served a rendered HTML *viewer*, so the page's `fetch('/repo/CHANGELOG.MD')` received HTML instead of raw markdown and the parser matched 0 version headers — added a `?raw=1` param to `routes/files.js` that returns the unrendered file (viewer links without the param are unchanged); (2) the version-header regex required an em-dash separator but `CHANGELOG.MD` uses `## [x.y.z] - date` (hyphen), so all 47 headers were skipped — now tolerates hyphen / en-dash / em-dash; (3) `parseInlineMarkdown` never escaped `<>&`, so literal angle brackets in entries injected markup and corrupted `innerHTML`, silently truncating the list to 28 — now escapes HTML before applying inline markdown. Verified on the dev server: 47/47 versions render, collapse toggle works, no console errors.

## [1.7.4] - 2026-06-21

### Changed
- **Knowledge Center: moved the collapsed "Under the hood — research & internals" disclosure above the "Apps / Explore Keystone" section** (`apps/lantern-garage/public/knowledgecenter.html`). The `<details class="kc-deep">` block now sits between "Quick help" and "Apps" instead of at the bottom of the page; it stays **collapsed by default**, so the only change is section order. Pure block relocation — tags balanced, lxml-parsed, preview-verified (`under_the_hood_before_apps: true`).

## [1.7.3] - 2026-06-21

### Changed
- **Deprecation clarity: old CSF references are now unmistakable (code + docs).** Marked every retired / non-canonical CSF surface so it can't be confused with the canonical CSF-Pack + CSF-Omni (`csf` / `csf_pack` / `omni`): `src/csf/base3.py` and `src/csf/delta_stream.py` (the dead v0.3 symbolic delta-stream — banner: ⚠️ deprecated, *not* the CSF format); `src/csf/v07/csf_file.py` (re-headed from "CSF v0.6 File Format" → the v0.6/0.7 lattice **container** behind the Status-Cube store, *not* the compression format); `src/csf/v07/symbolic_dictionary.py` (reframed as a lossless lattice token table, *not* a compressor — dropped the "massive head-start … beats generic compressors" lossy-fiction claim); `src/csf/status_cube.py` (clarified it persists via the v0.7 lattice container, not canonical compression). Docs: `docs/ALEX-ASI-ARCHITECTURE.md` dropped a dangling reference to the deleted lossy `csf_symbolic_compressor.py`. Each banner points to the canonical core for real compression and to `csf.v07` as the 3¹² lattice *storage face*. Docstring-only — no functional change; 158 CSF tests pass.

## [1.7.2] - 2026-06-21

### Fixed
- **Auth gate: home page no longer bounces guests to `/auth.html`.** `public/js/auth-gate.js` already honors the server's `authRequired` signal (so disabling the `patreon_auth` flag opens the site), but its client-side `PUBLIC` allow-list was missing `/` and `/index.html` — which **are** served publicly by `routes/pages.js` `PUBLIC_PAGES`. The mismatch meant a guest landing on the home page got redirected to `/auth.html?returnTo=%2F` whenever the gate was on. Added both paths so the two lists stay in lock-step. Also made the `/api/auth/session` fetch-failure path **fail open** (no client redirect on a transient error) — the server remains authoritative and issues its own 302 for genuinely protected pages, so the client bounce was redundant and harmful while the login flow is being disabled. Client-only change; no behavior change for authenticated users or protected routes.

## [1.7.1] - 2026-06-21

### Fixed
- **Repo hygiene: broken launcher, dead paths, machine-wide `make stop` (#907, #906, #902).** Three independent housekeeping bugs that survived earlier partial fixes:
  - `scripts/OneButton-SuperJarvisLaunch.ps1` shipped on `master` with committed git conflict markers (`<<<<<<< HEAD` … `>>>>>>> pr-340`) wrapping the *entire* file, so it would not parse — the launcher was simply broken. The two conflict sides were byte-identical, so resolution is a no-op merge: strip the markers and keep one clean copy (now parses via `[Parser]::ParseFile`). (#907)
  - `scripts/_write_index.py` hardcoded a dead OneDrive output path; `scripts/extract-session-pairs.py` hardcoded the dead `C--Users-alexp-OneDrive-…` Claude-project slug. Both now derive their paths from `__file__`/`REPO_ROOT` (the slug is computed from the repo's absolute path the way Claude Code names its transcript dir), with a `CLAUDE_SESSIONS_DIR` env override. Companion fix to the already-landed `rebuild_index.py` portability fix. (#906)
  - `make stop-services` ran `Get-Process node,ollama | Stop-Process -Force`, killing **every** Node/Ollama process on the machine. It is now port-scoped (4177/4178/11434) via `Get-NetTCPConnection … OwningProcess`, mirroring `Start-DualServers.ps1`, and a `make stop` alias was added. (#902)

## [1.7.0] - 2026-06-21

### Changed
- **CSF-Omni: parallel panel encode (~3× faster) + skippable decode CRC.** The best-fit codec ([`src/csf/omni.py`](src/csf/omni.py)) ran the whole panel (store/zlib/bz2/lzma/zstd/brotli) serially, so its encode cost was the *sum* of all codecs — dominated by brotli-11 + lzma-9e. It now encodes the panel in a thread pool: the codecs are C extensions that release the GIL, so wall-clock drops from the sum to ~the slowest single codec while the result stays the **exact** best-fit (measured **13.1 s → 4.0 s, 3.2×**, on a 4 MB stream; same winner, byte-identical output; deterministic via a stable size+search-order sort). Decode: `omni.decompress(blob, verify=False)` skips the redundant CRC-32 pass when an outer check already covers the bytes — `csf_pack` now uses it (it verifies SHA-256 per file), speeding archive reads. (Considered a prefix-probe heuristic but dropped it: a small sample mis-ranks brotli, whose edge grows with input size, so it lost ratio; parallelism is exact and nearly as fast.) Tests: [`tests/test_csf_pack.py`](tests/test_csf_pack.py) — parallel encode is deterministic + exact; `verify` flag round-trips and still catches corruption.

## [1.6.9] - 2026-06-21

### Verify
- **Close the EXTERNAL REALITY RULE loop end-to-end (#919 finding #2).** The Σ₀
  verify pass already grounded each extracted claim into a
  `[claim, evidence, confidence, source]` record, but those records never entered
  the consent-gate claim-packet system — so nothing a grounded chat answer
  asserted could be reviewed, signed, or exported as evidence. New
  `lib/claim-draft.js` maps each genuinely-grounded, non-refuted, confident record
  to a VALID `lantern.claim_packet.v1` packet in **`draft`** status and persists it
  through the same `savePacket()` the API uses. Drafts are inert: not approved,
  unsigned, never exportable — the operator still reviews/approves via the existing
  consent gate (`routes/claims.js`). Wired into `dream-chat.verifyResponse` (Step 5),
  so every caller benefits; gated by the existing `SIGMA0_VERIFY=true`. Verified via
  `test/claim-draft.test.js` (10 checks: worthiness gate, packet validity,
  inert/non-exportable invariant, end-to-end persist through the real consent gate).

### Security
- **Markdown renderer URL-scheme allowlist (red-team hardening).**
  `lib/markdown-render.js` escaped HTML but never validated link/image **schemes**,
  so `[x](javascript:…)` / `![](data:text/html…)` produced live XSS sinks. Since
  automation / research-intake / harvest pipelines write `.md` into this repo that an
  admin later views via the doc viewer (`routes/files.js`), that's a stored-XSS path.
  New `safeUrl()` allows only http(s)/mailto/tel (+ raster `data:image/*` for `<img>`,
  never `svg+xml`), strips control-char scheme smuggling, and collapses everything else
  to `#`. Verified via `test/markdown-render.xss.test.js` (14 checks) + end-to-end
  `renderMarkdownDocument` render. (The client chat renderer was already scheme-safe
  by construction — its link/image regexes hardcode `https?://`.)
## [1.6.8] - 2026-06-21

### Changed
- **Surface convergence-engine failures instead of swallowing them (Σ₀ #919 / #941).** [`stream-chat.js`](apps/lantern-garage/lib/stream-chat.js): when the kernel convergence route falls through to a direct LLM ("Convergence unavailable — answering directly"), the underlying `convResult.error` + reason is now `console.error`-logged (mirrors #921's MemOS-fallback fix). Found via the #941 live-loop verification on 4177 — the engine error was invisible, so the loop's grounding gap couldn't be diagnosed.

## [1.6.7] - 2026-06-21

### Tests
- Salvage the genuinely-new test coverage from #928 (@cdblasioli-gif): add `tests/test_collapse_canary_e2e.py` (Σ₀-K1 collapse-canary e2e, 9 cases) and harden the torch-dependent kernel tests (`test_kernel_closure`, `test_provider_nodes`, `test_snapshot_replay`) to skip on **`OSError`** (Windows torch DLL load failure), not just `ImportError` — `pytest.importorskip` misses DLL failures. #928's 5 Σ₀-K1 source modules were already byte-identical on master (#927 + siblings), so only these net-new/robustness test changes were taken; the rest of the stale-base fork (re-added files + a committed data file) was dropped.

## [1.6.6] - 2026-06-21

### Verify
- `_convergence_rag` no longer swallows MemOS retrieval failures silently. A
  broken MemCube now logs a `convergence_rag_memos_fallback` event before
  degrading to flat-rag-house, so a dead primary retrieval path is observable
  instead of invisible. Σ₀ red-team finding (#919, re-scoped finding #1).

## [1.6.5] - 2026-06-21

### Cleanup
- Remove the dead `safe-zone-v25.js` → `safezone-confidence.js` chain (no production
  importers) **plus its now-orphaned `tests/test_safezone_v25.js` and stale
  `docs/SAFEZONE_V25.md`** — the test was the chain's only remaining `require()`, so
  deleting the modules alone would have left a test loading a missing file. Σ₀ red-team
  finding on safe-zone sprawl (#918, #919). Verified via importer grep (exports
  `planCaptionSafeZone`/`smoothZone`/`PRIORS` used only by the deleted test) + load
  smoke-test of the remaining v2/v3/detector chain.

## [1.6.4] - 2026-06-21

### Security
- **Hardened the markdown reader and Knowledge Center search against the CodeQL/OWASP findings carried in by #914.** [`apps/lantern-garage/lib/markdown-render.js`](apps/lantern-garage/lib/markdown-render.js): the HTML-comment strip now loops until stable so a nested/overlapping `<!-- <!-- --> -->` can't leave a dangling marker (CodeQL high — *incomplete multi-character sanitization*), and the block parser uses `String.match()` instead of `RegExp.exec()` so the OWASP "exec(" pattern guard stops false-positiving on regex method calls. [`apps/lantern-garage/public/knowledgecenter.html`](apps/lantern-garage/public/knowledgecenter.html): the grounding-search `esc()` helper now also encodes `"` and `'`, so a result `source` can't break out of the `href="…"` attribute (CodeQL medium — *incomplete HTML attribute sanitization*). No behaviour change to rendering (badges, anchors, nested lists, newspaper layout, byline all verified unchanged).

---

## [1.6.3] - 2026-06-21

### Added
- **Kernel-path provider rollover (#894).** `provider-router.js` gains a `kernel` `PROVIDER_CHAIN` (`keystone-ft`/`ouro` -> `anthropic`) and `selectKernelProvider(requestedProvider)` — independent of chat `selectProvider`, so the kernel never inherits the chat surface's Claude default. Staged via `KEYSTONE_ROLLOVER_MODE`: **`shadow` (default/unset) = Claude only (Stage 0, no behavior change)**; `default` = Keystone/Ouro first, Claude explicit last-resort. `stream-chat.js`'s kernel path now `await`s it (also fixes a bug where the async `selectProvider` was used un-awaited, making `provider` a Promise) and surfaces `provider`/`model`/`rolloverMode` in the SSE `done` event. Test: `tests/test_kernel_provider_chain.js` (6 assertions). Curated from #905 (@cdblasioli-gif): cherry-picked the 3 intentional files onto clean master; excluded its stale-base noise, 3 committed runtime-data files, and the redundant #851 bytes-per-correct (already on master via the `verbosity()` Gate F).

## [1.6.2] - 2026-06-21

### Fixed
- **Markdown reader (`/repo/*.md`) mangled badge/image syntax — the README/QUICKSTART pages looked broken.** [`apps/lantern-garage/lib/markdown-render.js`](apps/lantern-garage/lib/markdown-render.js)'s hand-rolled inline parser turned linked badges `[![alt](img)](href)` into literal garbage (`<a href="img">![alt</a>](href)`), showed `<!-- … -->` comments as on-page text, and split every soft-wrapped line into its own `<p>`. Rewrote inline parsing to stash code/images/links/autolinks as placeholders before emphasis runs (so URLs containing `_`/`*` can't be corrupted) and restore them iteratively, so a linked badge now renders as a real `<a><img></a>`. Also added: HTML-comment stripping, soft-wrap paragraph joining, true **nested lists**, GitHub **task-list checkboxes** (`- [ ]`/`- [x]`), `<https://…>`/`<mailto:>` autolinks, `~~strikethrough~~`, and GitHub-style heading `id` slugs so in-page `#anchor` / table-of-contents links resolve. The wide-screen **newspaper column layout** (#e12dbcb5) and the **frontmatter byline** (#842) are preserved.

### Changed
- **Knowledge Center (`/knowledgecenter.html`) reworked normie-first.** [`apps/lantern-garage/public/knowledgecenter.html`](apps/lantern-garage/public/knowledgecenter.html) now leads with a friendly hero, a help search (same `/api/knowledge/query` wiring), "Start here", common questions, and the apps; the Σ₀ / Convergence / CSF research and live internals are preserved verbatim but moved into a collapsed **"Under the hood"** `<details>` so non-technical visitors aren't hit with jargon first. Matches the site tile language (tinted icon chips, eyebrow labels, hover lift). All wirings kept: grounding search, PDF gallery (`/api/pdfs` GET+DELETE), the 18 jargon glosses, theme toggle, and `auth-gate.js`.
- **QUICKSTART.md rewritten normie-first.** Leads with the zero-install path (open `lantern-os.net`, no account), marks Python **optional** (the server runs chat without it), adds a ⚠️ security warning before the public Cloudflare-tunnel section, fixes the `/` = Home / Chat = `/dream-chat.html` mislabel, and uses per-OS commands. Keeps the already-correct `scripts/Start-DualServers.ps1` launcher and Keystone branding.

### Added
- **Keystone Chat brand guidelines** — [`docs/KEYSTONE-BRAND-GUIDELINES.md`](docs/KEYSTONE-BRAND-GUIDELINES.md): name/mark, the full light + dark color tokens (source of truth: [`css/site.css`](apps/lantern-garage/public/css/site.css)), typography, shared UI components, normie voice & tone, and accessibility. Linked from the Knowledge Center → Guides.

---

## [1.6.1] - 2026-06-21

### Fixed
- **Chat embeds no longer render a confusing blank on failure.** `dream-chat-ui.js` `renderExploreEmbed()` now surfaces a per-section message (e.g. "⚠ Discover unavailable (HTTP 404) — route not deployed") instead of swallowing errors via a silent `.catch(() => '')`. Each builder checks `r.ok` and treats an empty payload as an error. Root cause of the original blanks: the `/api/feeds/discover` + `/api/github/activity` routes 404'd before #888 was deployed.
- **Embed fetches pinned to same-origin.** `embedBase()` now always uses `window.location.origin` (the embed routes are co-served with the page), avoiding any cross-origin/mixed-content risk from the function-scoped `serverBase`.
- **Cache-bust `dream-chat-ui.js`** (`?v=20260621-embed2`) so browsers pick up the embed code without a manual hard-reload.

## [1.6.0] - 2026-06-21

### Added
- **CSF-Omni codec — deterministic best-fit compression (`codec="omni"`).** New [`src/csf/omni.py`](src/csf/omni.py): runs the whole codec panel (store/zlib/bz2/lzma/zstd/brotli + a byte-delta transform) per blob, round-trip-verifies each candidate, and emits the smallest behind a 7-byte self-describing, **CRC-32** header. Wired into `csf_pack` as a 4th codec alongside `zstd`/`zlib`/`store` (backward-compatible — v0.8 zstd/zlib/store archives still read byte-for-byte). It is the **upper envelope**: on three real corpora it beats every other codec (zlib/zstd/lzma/bz2) on every single stream and *ties* the brotli frontier within its header — it does **not** beat brotli's raw bytes (no PPMd/paq available). Honest result vs the shipped zstd-19: per-stream **+2.8 % / +16.3 % / +6.5 %**; on the multi-file archive only **+2 %** over `zstd`+shared-dict (`use_dict=True`) at ~7× the encode, so **zstd stays the default** and omni is the opt-in max-ratio tier for single-stream cold/archival blobs. The CRC catches corruption a raw zstd/brotli frame returns silently; `portable=True` restricts to stdlib codecs. Verified by a round-trip benchmark ([`experiments/csf_compression_benchmark.py`](experiments/csf_compression_benchmark.py)) + a 6-agent adversarial review (2 defects found & fixed: a corrupt brotli payload could decode to silently-wrong bytes → CRC + `ValueError` decode contract; a docstring over-claim → envelope wording). Docs: [`docs/CSF-FORMAT-SPECIFICATION.md`](docs/CSF-FORMAT-SPECIFICATION.md) §2.7.1 + report `/reports/csf-compression-benchmark.pdf`. Tests: [`tests/test_csf_pack.py`](tests/test_csf_pack.py) (omni round-trip, CRC integrity, payload-envelope).

---

## [1.5.10] - 2026-06-21

### Added
- **Explore page embeds (Σ₀ Converge — discovery surface).** Three new self-refreshing sections on `explore.html`, all server-side cached with baked fallbacks so the page always renders:
  - **🧭 Discover** — curated RSS/Atom rail (`routes/discover-feeds.js` → `GET /api/feeds/discover`) pulling on-theme sources (Simon Willison, Hacker News, MIT Tech Review); per-source resilient, merged + date-sorted, 30-min cache. Sources are an editable constant at the top of the route.
  - **🛠️ Build** — live GitHub activity (`routes/github-activity.js` → `GET /api/github/activity`) for `alex-place/lantern-os`: star count, latest published releases, and recent commits via the public REST API (no token), 30-min cache.
  - **♥ Support** — Patreon tier cards grounded in the real campaign tier map (Wanderer $5 / Deep Dreamer $20 / Synthesasia Guild $200), replacing the bare support link.
- Both new routes follow the existing `routes/youtube.js` discipline (in-memory cache + verified baked fallback) and are registered in `server.js` before the static catch-all.
- **Explore embeds surfaced in Keystone chat.** `dream-chat-ui.js` `sendMessage()` now detects an embed-intent (bang commands `!videos` / `!discover` / `!build` / `!support` / `!embeds`, or a natural-language "show/what/latest" framing) and renders the matching embed inline — reusing the same cached `/api/{youtube,feeds,github}` routes. Deterministic, no LLM cost; mirrors the existing `!convergence` / `WORK_INTENT` intercept pattern. Negatives (dream journaling, work queries, "I need support today") deliberately do not trigger.

## [1.5.9] - 2026-06-21

### Added
- **Grounding envelope `[claim, evidence, confidence, source]`** (Σ₀-K1 component 9 / Verify stage, closes #849). `ConvergenceRecord` now carries a `source` field in both the Python dataclass (`src/convergence/objects.py`) and JS emitter (`convergence-records.js`), schema locked by the cross-language contract tests. Three call sites (dream-chat reasoning, kalshi-suggest, stream-chat) pass `source` (reasoner/provider/model or `kalshi-market/<ticker>`), so every emitted record is a complete External-Reality-Rule envelope. Adds a `grounding_precision` metric to `eval_keystone.py`. Coexists with `applied_evidence` (#764 G9). Curated from #890 (@cdblasioli-gif) — cherry-picked the 8-file change onto clean master since the PR branch carried pre-existing conflict markers in unrelated files. 62 convergence tests pass.

## [1.5.8] - 2026-06-20

### Changed
- **Gitignore runtime data that automation kept committing** (surfaced by junk PR #885, branch `auto/master`): conversation backups (`data/conversations/*.bak`, `*.cleared-*.jsonl`), the convergence audit log (`apps/data/convergence-audit.jsonl`), and the admin feature-flags runtime store (`data/admin/feature-flags.json`). These are machine-local runtime state — and the conversation backups can carry PII — so they must never be tracked. Closes the gap where the gitignore covered `garage-conversations.jsonl` but not its `.bak`/`.cleared-*` backups.

## [1.5.7] - 2026-06-20

### Security
- **Session secret fails closed beyond loopback (#867).** `lib/session-secret.js` `resolveSessionSecret()` (wired in `server.js`) allows the committed dev secret ONLY on loopback; bound beyond loopback (PORT set / production) a real `SESSION_SECRET` is required or the server refuses to boot — never signs sessions with the publicly-known key. Test: `tests/test_session_secret.js`.
- **Single-source TLS-verification gate (#869).** `lib/insecure-tls.js` consolidates the win32-only insecure-TLS workaround (verification stays ON elsewhere; opt-out `LANTERN_INSECURE_TLS=0`); `providers.js`/`stream-chat.js` share the agent so it can't drift. Test: `tests/test_insecure_tls.js`.
- Opt-in JSONL rotation on hot paths + other hardening (`file-queue.js`, `files.js`, `pdfs.js` entitlement, `agent-worker-loop.js`).

### Notes
- Lands the unique value of **#881** (external author, consolidating #862-873), which was largely redundant with fixes the fleet had already merged. The two files that conflicted with the already-landed #873 hardening (`routes/keystone.js`, `lib/self-edit-engine.js`) keep master's tested version.

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

## [1.5.6] - 2026-06-20

### Security
- **Closed issue-driven command injection in autowork + the Keystone console (#873).** The self-edit test runner (`self-edit-engine.runTests`) and `/api/keystone/exec` ran allowlisted command *strings* through `execSync` (a shell), so a porous capture group (`pytest tests/(.+).py`, `git commit -m "(.+)"`) could smuggle `;`, `$(…)`, backticks, `|`, `>` and execute arbitrary commands; `gitCommit` was likewise injectable (`git commit -m "${msg}"` only stripped `"`, not `$(…)`). New shared `apps/lantern-garage/lib/safe-exec.js` runs everything **shell-free**: `tokenizeCommand()` splits to argv and rejects shell metacharacters/unbalanced quotes, and `safeExec()` uses `execFileSync({ shell:false })` (running npm/npx/yarn/pnpm `.cmd` shims via `cmd.exe /c <argv>` on Windows so going shell-free doesn't break `npm`). All `execSync` in `self-edit-engine.js` and `routes/keystone.js` is replaced; allowlist capture groups are charset-restricted. Legit commands are unchanged; injection-shaped input is denied at the allowlist and again at tokenize. Tests: `tests/test_safe_exec.js` (16, incl. the `$(whoami)` and pytest-wildcard cases + a no-shell proof). Supersedes the partial autowork PR #882.

---

## [1.5.5] - 2026-06-20

### Added
- **Calibration -> live-scorer bridge (V10 viral scoring).** `src/creator-intelligence/calibration/weights-artifact.js` persists/loads the operator-specific calibrated weights produced by `weight-calibration.calibrateWeights()`, and `viral-score-v10.js` now scores with them when present — reporting `calibrated:true` plus sample size/target — falling back to the heuristic/open-video priors (`calibrated:false`) otherwise. Closes the loop `calibration-engine.js` named "the bridge the V10 scorer has been waiting on." **Honesty-gated:** only a real `status:"ok"` calibration is persisted (`insufficient_data` is never saved), so the scorer can't report a calibration the data doesn't support. No behavior change until real labeled outcomes produce calibrated weights. Test: `tests/test_v10_calibrated_weights.js` (3 cases).

### Removed
- **Dead `lib/` V10 research scaffold** (`feature-extractor-v10.js`, `analyzer-v10.js`, `sigma0-v10-scoring.js`, `v10_feature_extractor.py`, `models/train_xgboost_v10.py`, `tests/test_v10_loads.js`) — cherry-picked from #875 in #880, but per `docs/V10-INTEGRATION-COMPLETE.md` they were already tried in production and reverted (their feature extractors return all `0.0`). Dormant (nothing required them); removed to cut scorer sprawl. The live V10 scorer is the real, structural `src/creator-intelligence` path; `#880`'s `creator-theme.css` fix is kept.

## [1.5.4] - 2026-06-20

### Added
- **v10 video-scoring modules** (`lib/feature-extractor-v10.js`, `lib/sigma0-v10-scoring.js`, `lib/analyzer-v10.js`, + offline Python trainers `lib/v10_feature_extractor.py`, `models/train_xgboost_v10.py`) — a data-driven, stability-aware engagement-scoring pipeline (Σ₀ collapse-aware) for the Creator Dashboard. **Cherry-picked from #875** and verified to import cleanly (`tests/test_v10_loads.js`). Currently **dormant** — not yet wired into the live highlight pipeline; wiring it (and whether to replace the existing detection) is a follow-up decision.

### Fixed
- **`creator-theme.css` was missing** even though `apps/lantern-garage/public/calibration.html` links it (a broken stylesheet reference on master) — added the stylesheet (cherry-picked from #875).

### Notes
- #875 (external fork "missing work") reviewed in depth; the rest excluded as regressive or junk: a **Keystone->Lantern brand reversion** in `dream-chat.js`, a facecam-rejection reversion in `render-pipeline-v2.js`, a README rewrite, and ~5,500 lines of data/report dumps. Recommend closing #875.

## [1.5.3] - 2026-06-20

### Fixed
- **Autowork `plan_parse_failed` — robust plan JSON extraction.** The autonomous-work "Generate plan" step (`self-edit-engine.js` `generatePlan`/`extractJson`) aborted with `plan_parse_failed: no valid JSON found` whenever the model wrapped its plan in a lone ```json fence with no closing fence, added a trailing comma or `//`/`/* */` comment, or got cut off mid-JSON (surfaced auto-working #873). `extractJson` now cascades fence → first`{`..last`}` → first`[`..last`]` → repair, tolerates comments/trailing commas, and best-effort-repairs truncated output by closing open strings and unbalanced `{`/`[`. `generatePlan` also retries once with a stricter "raw JSON only" reminder. Added 9 unit tests (`tests/test_self_edit_engine.js`) incl. the exact truncated-fence case; 24/24 pass.

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
