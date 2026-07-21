---
author: Alex Place
created: 2026-06-08
updated: 2026-07-20
---

# unisona.ai Skills & Capabilities

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

> **⚠️ These are INTERNAL self-assessed per-stage estimates, and the table above is stale
> (2026-06-16) — not external marks.** For the current, grounded standing against *public*
> benchmarks, read the eval ledgers (`data/eval/leaderboard.jsonl`, `data/longmemeval/runs.jsonl`)
> and the maintained [BENCHMARKS.md](docs/BENCHMARKS.md) registry. **Latest review (2026-07-20):**
> HumanEval-chat 0.83 (served qwen2.5-coder) / 0.70 (sigma0-coder distill) / 0.22 (raw Ouro-1.4B);
> SWE-bench Lite **0/5** resolved; LongMemEval multi-recall@5 0.775 — the SWE-bench resolved rate
> is the top capability gap (frontier ~95%).

---

## Live Skills (real implementations)

> **Audit (2026-06-29):** 7 design-only relic skills were deleted and the design-only ones banner-flagged in a Σ₀ scope-discipline pass — see git history of docs/SKILLS-AUDIT-2026-06-29.md](docs/SKILLS-AUDIT-2026-06-29.md). The `convergence` skill (below) was added to give the Converge loop stage a real contract.

### convergence
The Converge stage as a skill — grounded synthesis + Convergence Records. Backs the `!convergance` chat command.
- Synthesizes recent entries into ONE insight; grounds forward-looking claims via the `research` skill's task loop (1-2 bounded rounds of fan-out + gap-driven refinement — falls back to a single web search on error)
- Appends evidence-bearing records to `data/convergence/records.jsonl` (`grounded`, `sources`, `grounding_task_id`, honest confidence)
- `!convergance <topic>` grounds on an explicit topic; `!convergance log an issue <title>` files a GitHub issue (shell-free)

### research *(Σ₀ grounded)*
Persisted, resumable long-running research tasks — the Remember + Verify stages made durable across chat turns.
- `!research <topic>` (or plain language: "research X" / "look into X" / "investigate X") starts a TASK, not a single search
- Each round runs the wide-search Observe→Reason→Verify→Converge loop (fan-out sub-queries, low-fidelity prune, high-fidelity cited synthesis), then a gap-check decides whether another round is warranted
- State persists to `data/research-tasks/<id>.json` after every round — survives server restarts; `!research continue <id>` resumes an unfinished task from where it left off
- Bounded by `RESEARCH_TASK_MAX_ROUNDS` (default 8 total) and `RESEARCH_ROUNDS_PER_TURN` (default 3 per HTTP turn)
- On completion, emits a Convergence Record (`reasoner: "research-task"`) and a CSF memory entry
- Backs both `!convergance`'s grounding (1-2 bounded rounds) and autowork's issue research (`AUTOWORK_RESEARCH_ROUNDS`, default 2) — one engine, three entry points
- Implementation: `apps/lantern-garage/lib/research-task.js` (task state) + `lib/wide-search.js` (per-round search loop)

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
- Research: grep codebase + the `research` skill's task loop (up to `AUTOWORK_RESEARCH_ROUNDS` rounds, default 2, targeting each round's gaps)
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
| **unisona.ai** | Autonomous testing, QE, convergence | test, scan, audit, keystone, issue |
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

### Autonomous Test Fleet (unisona.ai)
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
