---
author: Alex Place
created: 2026-06-08
updated: 2026-06-20
---

# Keystone OS Skills & Capabilities

**⚠️ REQUIRED READING: Before working with any skill, all agents must review [SECURITY.md](SECURITY.md)**

---

## Convergence Loop (Σ₀)

The entire system is one loop: **Observe → Remember → Reason → Act → Verify → Converge**

Every skill must strengthen one stage. Nothing outside this loop is in scope.

### AGI Benchmark (as of 2026-06-16)
| Stage | Score | Target | Bottleneck |
|-------|-------|--------|------------|
| Observe | 0.85 | 0.95 | GitHub + web fetch |
| Research | 0.80 | 0.95 | Web grounding (DuckDuckGo) |
| Reason | 0.82 | 0.90 | JSON parse resilience (extractJson) |
| Act | 0.78 | 0.90 | Branch/PR management |
| Verify | 0.60 | 0.90 | Playwright test coverage |
| Converge | 0.75 | 0.90 | Evidence logging + confidence |
| **Σ₀ Overall** | **0.77** | **0.92** | |

Scores updated per-run in `data/agi-benchmark.jsonl`.

---

## Live Skills (real implementations)

### dream_journal
Dream Journal entry creation, management, and RAG-backed search.
- Create dream entries with metadata (emotions, tags, symbols, lucidity)
- Search/filter across dream history
- Export to CSV/JSONL format
- CSF compression for efficient storage

### lucid_dreaming
Lucid dreaming coaching and reflection tools.
- Technique suggestions (WILD, DILD, WBTB)
- Dream sign tracking
- Reality checks and sleep window planning
- Integration with dream journal for pattern analysis

### archive_curator
Documentation, archival, and knowledge management.
- Markdown rendering and repo file serving
- RAG house building (flat document index)
- Knowledge base search and retrieval
- CSF/CADD memory exports

### voice_curator
Text-to-speech and audio generation via ElevenLabs/OpenAI.
- Voice selection and model control
- Streaming audio output
- Provider fallback (ElevenLabs → OpenAI)
- Caching and rate-limit handling

### autonomous_work *(Σ₀ grounded)*
Fully autonomous issue resolution via `/api/convergence/autonomous-work/stream`.
- Observe: fetch GitHub issue + extract keywords
- Research: grep codebase + DuckDuckGo web search
- Reason: Claude generates JSON plan via `extractJson` (4-strategy fallback)
- Act: apply unified diff patch to correct `auto/issue-N` branch
- Verify: run allowlisted test commands
- Converge: log evidence + confidence to `data/convergence-autonomous-work.jsonl`
- Commit + push + open draft PR (graceful "already exists" handling)
- **Confidence:** codebase 0.85 · web 0.80 · tests 0.90 · observable 1.0

### provider_management
Live API key management without server restart.
- `POST /api/providers/set-key` — write key to `.env.local`, hot-patch `process.env`
- `DELETE /api/providers/set-key` — remove key from `.env.local`
- `POST /api/providers/test/:provider` — ping provider API to verify key
- `GET /api/providers/status` — which providers have keys configured
- Supports: anthropic · gemini · openai · xai

---

## Agent Personas

| Agent | Strengths | Keywords |
|-------|-----------|----------|
| **Lantern** | Reflection, guidance, wisdom | dream, reflect, meaning, symbol |
| **Blinkbug** | Analysis, patterns, data | analyze, pattern, track, data |
| **Keystone** | Autonomous testing, QE, convergence | test, scan, audit, keystone, issue |
| **Waterfall** | Flow, emotion, narrative | feel, story, journey, flow |
| **Xenon** | Creativity, imagination, play | create, imagine, play, explore |
| **Founder** | Vision, goals, direction | goal, vision, plan, future |

Selection is automatic; override with `?agent=NAME`.

---

## Provider Chain

Cascade order for LLM calls (auto mode):

| Priority | Provider | Status | Model |
|----------|----------|--------|-------|
| 1 | **Anthropic Claude** | ✓ Live | claude-haiku-4-5-20251001 |
| 2 | **Gemini** | ⚠ Quota (free tier) | gemini-2.5-flash |
| 3 | **OpenAI** | ⚠ Quota | gpt-4.1-mini |
| 4 | **xAI Grok** | ✓ Live | grok-3-mini |
| 5 | **Ollama** (local) | ✗ Not running | lantern-csf-dream |

Configure via `/api-keys-settings.html` — keys persist to `.env.local` with hot-patch.

---

## Fleet Integration

### Autonomous Test Fleet (Keystone)
Trigger in dream-chat: `"test the app"` / `"scan for issues"` / `"audit the system"`

**Scenarios:** home-load · dream-chat-init · dream-chat-first-message · theme-toggle ·
dream-chat-agent-select · dream-chat-error-handling · home-nav-links ·
trader-dashboard-load · responsive-mobile · responsive-tablet ·
console-monitoring · network-monitoring · slow-network

**Confidence gate:** ≥0.8 → file immediately · 0.5–0.79 → needs-review · <0.5 → log only

### MCP Server
`src/mcp_server/server.py` — FastAPI + SSE on port 8771:
`queue_status` · `task_intake` · `dispatch_work` · `boot_check` · `list_skills` · `get_status`

### Discord Bot
Optional — set `DISCORD_BOT_TOKEN` + `LANTERN_DISCORD_GUILD_ID` in `.env.local`.

---

## Open Issues — Fleet Growth Queue

| # | Issue | Stage | Priority |
|---|-------|-------|----------|
| [#585](https://github.com/alex-place/lantern-os/issues/585) | Hardening: error recovery & resilience | Act | High |
| [#586](https://github.com/alex-place/lantern-os/issues/586) | Perf: parallelize scenario execution | Act | High |
| [#587](https://github.com/alex-place/lantern-os/issues/587) | Validation: self-test the test harness | Verify | High |
| [#590](https://github.com/alex-place/lantern-os/issues/590) | Infra: Cloudflare tunnel down | Observe | Medium |
| [#592](https://github.com/alex-place/lantern-os/issues/592) | AGI Benchmark: Σ₀ self-assessment | Converge | High |
| [#593](https://github.com/alex-place/lantern-os/issues/593) | Fleet: provider fallback + JSON resilience | Converge | High |

Run `!convergence` in dream-chat or `Auto-work #N` in the convergence panel.
