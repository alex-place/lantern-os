---
author: Alex Place
created: 2026-06-08
updated: 2026-06-20
---

# Keystone OS — AI Provider Chain Documentation

**Complete inventory of all 10 LLM providers, their configuration, and current status.**

---

## Configuration Overview

| Component | Location | Purpose |
|-----------|----------|---------|
| **Provider Registry** | `data/pcsf/provider.pcsf.json` | Declared providers, fallback order, default models |
| **Settings Manifest** | `data/pcsf/settings.pcsf.json` | Environment variables, state (present/absent), API key URLs |
| **Environment Template** | `.env.example` | Local copy with instructions |
| **Live Configuration** | `.env` (git-ignored) | User's actual API keys and settings |
| **Server Loader** | `apps/lantern-garage/server.js` | Reads .env at startup (regex `^[A-Z0-9_]+`) |
| **Hot Reload API** | `POST /api/settings/providers` | Change provider keys without restart |

---

## The 10 Providers

### ACTIVE (Recommended for Production)

#### 1. **Anthropic Claude** ✅
- **API Key:** `ANTHROPIC_API_KEY` (format: `sk-ant-...`)
- **Model Var:** `ANTHROPIC_MODEL` (default: `claude-haiku-4-5-20251001`)
- **State:** ✓ Present (configured)
- **Get Key:** https://console.anthropic.com/settings/keys
- **Endpoint:** `api.anthropic.com`
- **Streaming:** Yes
- **Use Case:** High-quality reasoning, long-context reasoning
- **Notes:** Free tier available. Recommended default. The kernel/autowork chain
  (`PROVIDER_CHAINS.kernel` in `lib/provider-router.js`, mirrored in
  `routes/providers.js`) uses `claude-sonnet-5` as its Anthropic tier — it's
  built for sustained, multi-step agentic sessions with self-correction and
  dynamic replanning, matching the long-running kernel/autowork workload.

#### 2. **OpenAI ChatGPT** ✅
- **API Key:** `OPENAI_API_KEY` (format: `sk-...`)
- **Model Var:** `OPENAI_MODEL` (default: `gpt-4o-mini`)
- **State:** ✓ Present (configured)
- **Get Key:** https://platform.openai.com/api-keys
- **Endpoint:** `api.openai.com`
- **Streaming:** Yes
- **Use Case:** Fast inference, cost-effective chat
- **Notes:** Pay-as-you-go. Widely compatible.

#### 3. **Google Gemini** ✅
- **API Key:** `GEMINI_API_KEY` (or `GOOGLE_API_KEY` as fallback)
- **Model Var:** `GEMINI_MODEL` (default: `gemini-2.5-flash`)
- **State:** ✓ Present (configured)
- **Get Key:** https://aistudio.google.com/app/apikey
- **Endpoint:** `generativelanguage.googleapis.com`
- **Streaming:** Yes
- **Use Case:** Vision/multimodal, fast responses
- **Notes:** Free tier generous (up to 1500 calls/min). Gemini 1.5 Flash available.

#### 4. **xAI Grok** ⏳ (Declared, Not Yet Implemented)
- **API Key:** `XAI_API_KEY`
- **Model Var:** `XAI_MODEL` (default: `grok-3-mini`)
- **State:** ✓ Present (configured) — but not yet in fallback chain
- **Get Key:** https://console.x.ai/
- **Endpoint:** `api.x.ai` (OpenAI-compatible)
- **Streaming:** Yes
- **Use Case:** Creative tasks, humor/personality
- **Notes:** OpenAI API-compatible. Real-time web access. **Reserved for future implementation** — currently declared in PCSF but not yet wired into fallback logic.

#### 5. **Ollama Local** ✅
- **Base URL:** `OLLAMA_BASE_URL` (default: `http://127.0.0.1:11434`)
- **Model Var:** `OLLAMA_MODEL` (default: `llama3`)
- **State:** ✓ Present (configured)
- **Installation:** https://ollama.ai
- **Endpoint:** Local HTTP server
- **Streaming:** Yes
- **Use Case:** Privacy-first, offline, no API keys
- **Notes:** Must run `ollama serve` separately. Install models via `ollama pull <model>`.

---

### OPTIONAL (Configured but Unused)

#### 6. **Mistral AI**
- **API Key:** `MISTRAL_API_KEY`
- **Model Var:** `MISTRAL_MODEL` (default: `mistral-large-latest`)
- **State:** ✗ Absent (not configured)
- **Get Key:** https://console.mistral.ai/api-keys/
- **Endpoint:** `api.mistral.ai`
- **Streaming:** Yes
- **Use Case:** Coding (Codestral), long-context chat
- **Cost:** Competitive pricing

#### 7. **Cohere** ✅
- **API Key:** `COHERE_API_KEY`
- **Model Var:** `COHERE_MODEL` (default: `command-a-plus-05-2026` — `command-r-plus` was retired 2025-09-15)
- **State:** ✓ Present (configured) — **implemented** in the main chat dispatch and the swarm orchestrator
- **Get Key:** https://dashboard.cohere.com/api-keys
- **Endpoint:** `api.cohere.ai/compatibility/v1/chat/completions` (Cohere's OpenAI-compatible surface — reuses the existing OpenAI SSE parser + tool-turn helper)
- **Streaming:** Yes
- **Use Case:** Long-context RAG, summarization
- **Cost:** Per-token, free tier for testing
- **Notes:** Wired via the OpenAI compatibility API rather than native `/v2/chat` so it shares the same streaming/tool-calling machinery as OpenAI/xAI. Verified end-to-end (HTTP 200 + streamed tokens) 2026-07-01.

#### 8. **Perplexity AI**
- **API Key:** `PERPLEXITY_API_KEY`
- **Model Var:** `PERPLEXITY_MODEL` (default: `sonar-pro`)
- **State:** ✗ Absent (not configured)
- **Get Key:** https://www.perplexity.ai/settings/api
- **Endpoint:** `api.perplexity.ai`
- **Streaming:** Yes
- **Use Case:** Search-augmented QA with live citations
- **Cost:** Per-token

#### 9. **DeepSeek**
- **API Key:** `DEEPSEEK_API_KEY`
- **Model Var:** `DEEPSEEK_MODEL` (default: `deepseek-chat`)
- **State:** ✗ Absent (not configured)
- **Get Key:** https://platform.deepseek.com/api_keys
- **Endpoint:** `api.deepseek.com`
- **Streaming:** Yes
- **Use Case:** Math/logic reasoning (DeepSeek-Reasoner)
- **Cost:** Low-cost reasoning-focused
- **Notes:** Emerging provider with strong reasoning capabilities.

#### 10. **OpenRouter**
- **API Key:** `OPENROUTER_API_KEY`
- **Model Var:** `OPENROUTER_MODEL` (default: `openai/gpt-4.1-mini`)
- **State:** ✗ Absent (not configured)
- **Get Key:** https://openrouter.ai/settings/keys
- **Endpoint:** `api.openrouter.ai`
- **Streaming:** Yes
- **Use Case:** Unified gateway to 100+ models, fallback routing, price optimization
- **Cost:** Per-token
- **Notes:** Can access models from all other providers through single API.

---

### VOICE/TTS (Not an LLM but Integrated)

#### 11. **ElevenLabs TTS** 🔊
- **API Key:** `ELEVENLABS_API_KEY`
- **Voice ID:** `ELEVENLABS_VOICE_ID` (default: `Rachel`)
- **State:** ✓ Present (configured)
- **Get Key:** https://elevenlabs.io/app/sign-up
- **Use Case:** High-quality voice output for responses
- **Notes:** Fallback chain: ElevenLabs → OpenAI TTS → Browser TTS

---

## Current Status

**As of 2026-06-08 21:15 UTC:**

### Live Fallback Chain (Actively Implemented)

| Provider | Implemented | API Key | Code Path | Order |
|----------|-------------|---------|-----------|-------|
| Gemini (Google) | ✅ Yes | Present | dream-chat.js:260 | #1 |
| Claude (Anthropic) | ✅ Yes | Present | dream-chat.js:300 | #2 |
| OpenAI | ✅ Yes | Present | dream-chat.js:344 | #3 |
| Ollama (Local) | ✅ Yes | Optional | dream-chat.js:387 | #4 |

### Declared in PCSF (Not Yet Implemented)

| Provider | Status | API Key | Reason |
|----------|--------|---------|--------|
| Grok (xAI) | ✅ Implemented | Configured | In streaming dispatch |
| Cohere | ✅ Implemented | Present | Via OpenAI-compat endpoint (main chat + swarm) |
| Mistral | ⏳ Declared | Absent | Not yet implemented |
| Perplexity | ⏳ Declared | Absent | Not yet implemented |
| DeepSeek | ⏳ Declared | Absent | Not yet implemented |
| OpenRouter | ⏳ Declared | Absent | Not yet implemented |

---

## Fallback Chain (Active Providers)

**Order used when a provider fails or key is absent (implemented in code):**

```
1. Gemini (Google)         ← Starts here (line 260)
2. Claude (Anthropic)      ← Next if Gemini fails (line 300)
3. OpenAI (ChatGPT)        ← Next if OpenAI fails (line 344)
4. Ollama (Local)          ← Last resort (line 387)
5. Local Persona Fallback  ← No network required (line 437)
```

⚠️ **Note:** xAI/Grok is declared in `provider.pcsf.json` but NOT YET implemented in the fallback chain code. It's reserved for future implementation.

**Where it's defined:**
- `data/pcsf/provider.pcsf.json` line 50–56: PCSF declarations (includes 5 active providers)
- `apps/lantern-garage/lib/dream-chat.js` lines 260–437: Actual fallback chain implementation
- Each provider checks: `const XXX_Key = process.env.XXX_API_KEY; if (XXX_Key && ...)`

---

## How to Use a Provider

### Set Up a New Provider

1. **Get the API key** from the provider's console (see table above)
2. **Add to `.env`:**
   ```bash
   echo "PROVIDER_API_KEY=your_key_here" >> .env
   echo "PROVIDER_MODEL=model_name" >> .env
   ```
3. **Hot-reload** (no restart needed):
   ```bash
   curl -X POST http://127.0.0.1:4177/api/settings/providers \
     -H "Content-Type: application/json" \
     -d '{"key": "PROVIDER_API_KEY", "value": "sk-..."}'
   ```
4. **Verify it works:**
   ```bash
   curl http://127.0.0.1:4177/api/settings/providers
   ```

### Provider Ranking (live, PCSF-backed)

Provider order is **not** a hand-edited static list. `lib/provider-router.js` picks a
task-type chain (`PROVIDER_CHAINS`: kernel/coding/reasoning/creative/default — the
candidate set + cold fallback) and reorders it by the **live ranking** in
`data/pcsf/provider.pcsf.json` → `routing.by_task_type`.

That ranking is regenerated on every server start by `lib/pcsf-refresh.js` from real
**leaderboard outcomes** (`agent-performance` compositeScore), constrained to the
providers the streaming dispatch can actually execute (`anthropic`, `gemini`,
`openai`, `xai`, `ollama`). With no outcomes yet it cold-starts (cloud explored
before local); real scores take over as calls accumulate.

- **Inspect** the current ranking: `cat data/pcsf/provider.pcsf.json` (the file is
  git-ignored — it is a generated runtime artifact, bootstrapped on first boot).
- **Force a refresh:** restart the server (the router caches the file for 60 s).
- **Kill-switch:** set `PCSF_ROUTING=0` to ignore PCSF and use the static chain order.
- An explicit `provider` on the request still pins to that provider (bypasses ranking).

### Use a Specific Provider

In the Dream Chat UI (port 4177):
1. Click ⚙️ **Settings**
2. Select provider from dropdown
3. Add API key if needed
4. Save

Or via API:
```bash
curl -X POST http://127.0.0.1:4177/api/dream/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"message": "hello", "provider": "claude"}'
```

---

## Environment File Locations

| File | Purpose | Status |
|------|---------|--------|
| `.env.example` | Template (version controlled) | ✅ In repo |
| `.env` | Live config (git-ignored) | 🔒 Local only |
| `.env.local` | User secrets (git-ignored) | 🔒 Optional |

**Load order (first match wins):**
1. `.env.local` (user overrides)
2. `.env` (local config)
3. `.env.example` (fallback defaults)

---

## Server Configuration

| Component | File | Port | Purpose |
|-----------|------|------|---------|
| **Lantern Garage** | `apps/lantern-garage/server.js` | 4177 | Main web server + API |
| **MCP Server** | `src/mcp_server/server.py` | 8771 | Tool integration (optional) |
| **Ollama** | `ollama serve` | 11434 | Local LLM (optional) |

---

## Serving Defaults & Decode Parameters (#730)

Lantern serves in one of two modes (`src/serving_modes.py`). **FAST** is the
product default; **DEEP** is opt-in via `OURO_NATIVE=1`. Each provider streamer in
`src/unified_agent_connector.py` injects the mode-appropriate anti-repetition
decode params on every call.

### Decode parameters by provider

| Provider(s) | FAST params | DEEP params |
|-------------|-------------|-------------|
| OpenAI / Groq / Deepseek / Gemini | `top_p=0.95, frequency_penalty=0.5` | `top_p=0.98, frequency_penalty=0.2` |
| Anthropic | *(no `frequency_penalty` — unsupported by API)* | *(unchanged)* |
| Local (Ollama-style API) | `top_p=0.95, repeat_penalty=1.1, repeat_last_n=64` | `top_p=0.98, repeat_penalty=1.05, repeat_last_n=128` |

`temperature` defaults to 0.7. Verified by `tests/test_serving_modes.py`.

### Benchmark, validation & honest metrics

`src/serving_benchmark.py` runs a 10-prompt golden set and records latency,
repetition_ratio, cost and throughput to `data/benchmarks/leaderboard.jsonl`.

**Honesty contract:** the connector silently returns a canned offline persona stub
when a provider is unreachable. The benchmark **pins the requested model** onto the
provider config, streams with `fallback=False`, and **rejects** any `source: offline`
or empty response — recording it as an error, never as data. A leaderboard row
therefore always belongs to the model it names.

**Validation contract (#730):**

| Mode | Latency | Repetition (target / floor) | Success |
|------|---------|------------------------------|---------|
| FAST | <= 2 s (hard) | 0.85 / 0.80 | >= 0.90 |
| DEEP | 70-85 s (native Σ₀ only; warn elsewhere) | 0.80 / 0.75 | >= 0.90 |

Repetition is WARN below target but ERROR only below the floor (token-loop
territory). Run / validate / monitor:

```bash
python src/serving_benchmark.py --providers anthropic:claude-haiku-4-5-20251001 --mode fast
python src/serving_benchmark.py --validate    # exit 1 on regression
python src/serving_benchmark.py --report      # -> data/benchmarks/REPORT.md
```

Daily automation: `.github/workflows/serving-benchmark.yml` benchmarks every
provider whose API key is a repo secret, then validates as a gate. Full design:
[docs/SERVING-ARCHITECTURE-2026.md](docs/SERVING-ARCHITECTURE-2026.md).

---

## Security Notes

⚠️ **API Keys:**
- Never commit `.env` to git (already in `.gitignore`)
- Rotate keys if accidentally exposed
- Use separate keys for dev/prod
- Consider OpenRouter for provider isolation (single key for all)

⚠️ **Local Ollama:**
- No authentication by default on `127.0.0.1:11434`
- For production, use reverse proxy + auth
- Models stored in `~/.ollama/` (check disk space)

---

## Status As of This Session

✅ **Currently Running:**
- Ollama: Started with `ollama serve` (responsive)
- Lantern Garage: Dual-boot (port 4177 stable, 4178 dev)
- Dream Chat UI: Fully functional

✅ **Verified Working:**
- Three Doors game: `!three-doors` command responded
- Fallback chain: Ollama caught request when no cloud keys set
- Multi-provider architecture: All 5 configured providers registered

**Last Updated:** 2026-06-08 10:42 UTC  
**Documentation Version:** 1.0.0  
**PCSF Provider Version:** provider.pcsf.json (1.0.0)
