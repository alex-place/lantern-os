# Changelog

All notable changes to Lantern OS should be documented in this file.

The format follows the spirit of Keep a Changelog, with entries grouped by
release date. This project is currently private and local-first, so release
notes should be honest about what was verified locally and what remains design
intent.

## [1.2.0] — 2026-06-06 — Auto-Update + Convergance Sync

### Auto-Update
- `POST /api/actions/update` — git pull origin master → npm install → auto-restart server (detached spawn)
- `GET /api/version` — returns commit SHA, tag, branch, and date from git
- Client-side `update-checker.js` polls every 60s comparing local version to GitHub API latest master
  - Shows fixed banner with "Update & Restart" button when master diverges
  - Local dev: button POSTs to `/api/actions/update` and auto-reloads after restart
  - GitHub Pages: button hard-refreshes the page
- MCP tool `update_lantern_os` — agents can trigger full update pipeline via MCP protocol

### Dream Chat
- `!convergance` sync alias — quick chat command to trigger convergence loop
- Parallax zoom into dream door on scroll — background scales 1×→2.8×, hero text fades, glow orb drifts
- Scroll hint with bounce animation on empty state
- `.door-bg` element extracted from pseudo-element for GPU-transform parity
- Dream door hero uses `.webp` asset with optimized gradients and clipping fix

### Deploy
- Fixed GitHub Actions workflow (`actions/checkout@v4`, `actions/setup-python@v5`)
- Added `netlify.toml` + `.gitignore` for cloud deploy hygiene
- Version now auto-bumped and tagged as RC on every deploy

## [1.0.3] — 2026-06-06 — PCSF Provider Health Cache

### Server
- `apps/lantern-garage/lib/provider-cache.js` — 60-second in-memory TTL cache for provider routing state
  - `getProviderState()` — returns cached key-presence snapshot (gemini, anthropic, openai, xai, ollama); auto-refreshes when TTL expires
  - `recordProviderSuccess(id)` / `recordProviderFailure(id, error)` — update rolling 10-entry history per provider
  - `getRoutingSnapshot()` — redacted JSON snapshot (never exposes key values) for the telemetry endpoint
- `stream-chat.js` now reads `getProviderState()` once per request instead of re-reading `process.env.*`; all 5 providers record success/failure to the cache
- `GET /api/pcsf/routing` — new endpoint returning cache age, TTL, per-provider presence flags and recent history (safe to expose publicly)

### Versioning
- Bumped `version.json` → `1.0.3`

## [1.0.2] — 2026-06-06 — TTS Provider Chain + Version Badge

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

## [1.0.0] — 2026-06-05 — Dream Journal Orion Edition

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
- `cloud-server.js` unified with server.js — Railway/Render deploy via PORT env

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

## [1.0.1] — 2026-06-06 — Dream Journal Stability and Honesty Patch

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

## Changelog Rules

- Prefer concrete dates in `YYYY-MM-DD` format.
- Record local verification evidence for user-facing changes.
- Mark unverified, design-only, or future-facing claims explicitly.
- Keep private data, secrets, journal entries, and local receipts out of release
  notes unless they are referenced only as redacted evidence paths.
