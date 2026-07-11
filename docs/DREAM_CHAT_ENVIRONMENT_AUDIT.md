# Dream Chat Environment Audit

**Document Version:** 1.0  
**Generated:** 2026-06-14  
**System:** Lantern OS Dream Journal + Creator Suite

---

## Executive Summary

Dream Chat is the conversational AI interface of Lantern OS, providing multi-agent dialogue through 6 distinct personas (Lantern, Blinkbug, unisona.ai, Waterfall, Xenon, Founder). It supports 4 AI providers with automatic failover and health monitoring.

**Required Services:**
- At least 1 AI provider (Anthropic, OpenAI, Google Gemini, or local Ollama)
- MCP Server (for context loading, persona data)
- Optional: Stable Diffusion (for image generation), Ollama (for offline AI)

**Port Requirements:**
- `4177` — Lantern Garage (main web server, Dream Chat frontend)
- `8771` — MCP Server (context://personas resource)
- `7860` — Stable Diffusion (image generation)
- `11434` — Ollama (local LLM, offline mode)
- `5050` — Trading Service (optional, not required for Dream Chat)

---

## Environment Variables Reference

### AI Provider Credentials

| Variable | Purpose | Required | Default | Service Dependency | Where Used |
|----------|---------|----------|---------|-------------------|-----------|
| `ANTHROPIC_API_KEY` | Claude API authentication | Optional | — | Anthropic cloud | dream-chat.js, routes/dream.js |
| `ANTHROPIC_MODEL` | Claude model to use | Optional | `claude-haiku-4-5-20251001` | Anthropic cloud | dream-chat.js (line 532) |
| `OPENAI_API_KEY` | ChatGPT API authentication | Optional | — | OpenAI cloud | dream-chat.js, routes/dream.js |
| `OPENAI_MODEL` | OpenAI model to use | Optional | `gpt-4.1-mini` | OpenAI cloud | dream-chat.js (line 621) |
| `GEMINI_API_KEY` | Google Gemini API key | Optional | — | Google cloud | dream-chat.js (line 576) |
| `GOOGLE_API_KEY` | Fallback for Gemini | Optional | — | Google cloud | dream-chat.js (line 576) |
| `GEMINI_MODEL` | Gemini model to use | Optional | `gemini-2.5-flash` | Google cloud | dream-chat.js (line 579) |
| `GEMINI_GROUNDING` | Enable web search grounding | Optional | `true` | Google cloud | dream-chat.js (line 679) |
| `OLLAMA_BASE_URL` | Local Ollama server URL | Optional | `http://127.0.0.1:11434` | Local Ollama | dream-chat.js (lines 159, 470) |
| `OLLAMA_MODEL` | Ollama model name | Optional | `lantern-csf-dream` | Local Ollama | dream-chat.js (lines 160, 471) |
| `OLLAMA_TIMEOUT_MS` | Ollama request timeout | Optional | `120000` (2 min) | Local Ollama | dream-chat.js (line 192) |

**Provider Priority (fallback chain):**
1. User-selected provider (from request)
2. Cached provider (recent success)
3. Ollama (if available locally)
4. Anthropic (if `ANTHROPIC_API_KEY` set)
5. Google Gemini (if `GEMINI_API_KEY` set)
6. OpenAI (if `OPENAI_API_KEY` set)
7. Offline fallback (hardcoded responses)

---

### Server Configuration

| Variable | Purpose | Required | Default | Where Used |
|----------|---------|----------|---------|-----------|
| `LANTERN_GARAGE_PORT` | Main server port | Optional | `4177` | server.js |
| `LANTERN_GARAGE_HOST` | Server bind address | Optional | `127.0.0.1` (or `0.0.0.0` if `PORT` set) | server.js |
| `PORT` | Alternative port (for cloud) | Optional | — | server.js |
| `HOST` | Alternative host (for cloud) | Optional | — | server.js |

---

### MCP Server Configuration

| Variable | Purpose | Required | Default | Where Used |
|----------|---------|----------|---------|-----------|
| `MCP_SERVER_HOST` | MCP server address | Optional | `127.0.0.1` | lib/mcp-resource-client.js |
| `MCP_SERVER_PORT` | MCP server port | Optional | `8771` | lib/mcp-resource-client.js |
| `MCP_CLIENT_TIMEOUT` | MCP request timeout | Optional | `5000` (5 sec) | lib/mcp-resource-client.js |

**MCP Resources Required:**
- `context://personas` — Agent persona definitions (loaded from `data/contexts/personas.json`)

---

### Image Generation (Optional)

| Variable | Purpose | Required | Default | Service Dependency | Where Used |
|----------|---------|----------|---------|-------------------|-----------|
| `SD_HOST` | Stable Diffusion server | Optional | `127.0.0.1` | Local SD | routes/image.js |
| `SD_PORT` | Stable Diffusion port | Optional | `7860` | Local SD | routes/image.js |
| `ELEVENLABS_API_KEY` | Voice synthesis API | Optional | — | ElevenLabs cloud | routes (if TTS enabled) |
| `ELEVENLABS_VOICE_ID` | ElevenLabs voice ID | Optional | `Rachel` | ElevenLabs cloud | dream-chat.js (line 805) |

---

### Discord (Optional)

| Variable | Purpose | Required | Default | Service Dependency | Where Used |
|----------|---------|----------|---------|-------------------|-----------|
| `DISCORD_BOT_TOKEN` | Discord bot token | Optional | — | Discord API | lib/discord-lounge-bot.js |
| `LANTERN_DISCORD_GUILD_ID` | Discord server ID | Optional | — | Discord API | lib/discord-lounge-bot.js |

---

### Advanced / Optional Features

| Variable | Purpose | Required | Default | Where Used |
|----------|---------|----------|---------|-----------|
| `LANTERN_CLOUD_MIRROR_URLS` | Cloud backup mirrors | Optional | — | getCloudMirrorStatus() |
| `LANTERN_IMAGE_LORA` | Image generation LoRA model | Optional | `models/csf-image/checkpoints/lantern-door-lora-final.safetensors` | image generation |
| `CHILD_OF_LEVISTUS_PATH` | Special model path | Optional | — | (research use) |
| `THREE_DOORS_IMAGE_POOL_DIR` | Image pool directory | Optional | — | routes/three-doors-image-pool.js |
| `HFF_REPO_PATH` | Human Flourishing Frameworks repo | Optional | — | startup script |

---

## Startup Dependency Graph

```
START
  ├─ Load .env (if exists)
  ├─ Initialize File Queues
  ├─ Load Dreamer Store (conversations)
  ├─ Load RAG House (knowledge base)
  ├─ Load Provider Cache (health checks)
  ├─ Start Job Queue Worker (background job processing)
  ├─ Start Job Worker (async video analysis, exports, etc.)
  ├─ Refresh PCSF (settings)
  ├─ Load MCP Resource: context://personas
  │   └─ Fallback: Hardcoded personas if MCP unavailable
  ├─ Initialize Dream Chat Engine
  │   ├─ Load Agent Personas (from MCP or fallback)
  │   ├─ Setup Provider Router (with failover chain)
  │   └─ Verify ≥1 provider available
  └─ Start HTTP Server (port 4177)
      ├─ Attach Dream Chat routes (/api/dream/*)
      ├─ Attach Stream routes (/api/dream/stream)
      └─ Serve static UI (dream-chat.html)

SERVICES THAT CAN FAIL GRACEFULLY:
  ✓ Ollama (falls back to cloud providers)
  ✓ Stable Diffusion (image gen disabled)
  ✓ Discord Bot (messaging disabled)
  ✓ MCP Server (uses hardcoded fallback personas)
  ✓ All cloud providers (falls back to offline responses)

SERVICES THAT ARE CRITICAL:
  ✓ File system (for storing dreams/conversations)
  ✓ At least 1 AI provider OR hardcoded fallback
```

---

## Health Check Endpoints

### Server Status
```
GET /api/health
Returns: { status: "ready" | "initializing" | "degraded", ...details }

GET /api/status
Returns: Full system status (all services)

GET /api/agent/health
Returns: AI provider health and capabilities
```

### Provider Health
The system automatically monitors provider health:
- Success = next request tries same provider
- Failure = automatic failover to next in chain
- Timeout after `OLLAMA_TIMEOUT_MS` or 5sec (cloud)

---

## Configuration Scenarios

### Scenario 1: Local Only (No Cloud APIs)
```env
# Requires: Ollama running on http://127.0.0.1:11434
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=lantern-csf-dream
OLLAMA_TIMEOUT_MS=120000
```
**Status:** Dream Chat works offline  
**Limitation:** No web search grounding (Gemini feature)

### Scenario 2: Anthropic Only
```env
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022
```
**Status:** Always available  
**Limitation:** No web search, no local fallback

### Scenario 3: Multi-Provider (Recommended)
```env
# Primary (if available)
ANTHROPIC_API_KEY=sk-ant-...

# Secondary (Gemini with grounding)
GEMINI_API_KEY=AIzaS...
GEMINI_GROUNDING=true

# Fallback (OpenAI)
OPENAI_API_KEY=sk-...

# Local fallback (if all cloud unavailable)
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=lantern-csf-dream
```
**Status:** Automatic failover, offline capable  
**Cost:** Only used if previous provider fails

---

## Known Limitations

1. **Web Search Grounding:** Only Google Gemini provides live web search results
   - Other providers return cached/trained knowledge
   - Set `GEMINI_GROUNDING=false` to disable web search

2. **Persona Loading Failure:** If MCP server unavailable
   - Falls back to 6 hardcoded personas
   - Functionality unaffected, but persona data not live-updateable

3. **Provider Timeout:**
   - Ollama: configurable via `OLLAMA_TIMEOUT_MS`
   - Cloud APIs: hardcoded 5 second timeout
   - No timeout = request hangs indefinitely

4. **Token Limits:**
   - Max message input: 16,000 characters
   - Max generation: varies by provider
   - Long conversations may exceed context window

---

## Troubleshooting

### Dream Chat Not Responding
1. Check `/api/agent/health` endpoint
2. Verify at least 1 API key is set
3. If using Ollama, check `OLLAMA_BASE_URL` is reachable
4. Check logs: `[dream-chat]` entries in server output

### All Providers Failing
1. Check internet connection (for cloud APIs)
2. Verify API keys are correct (no typos)
3. Check quota/rate limits on cloud providers
4. Fallback to local Ollama if available

### MCP Resource Not Found
1. Verify `data/contexts/personas.json` exists
2. Check MCP server is running (`npm run mcp`)
3. Verify `MCP_SERVER_PORT=8771`
4. System continues with hardcoded fallback personas

---

## Security Notes

- **Never commit `.env` with real API keys**
- **API keys in memory are vulnerable if process dumps are enabled**
- **Consider running on `127.0.0.1` only (local network)**
- **To expose on internet, use authenticated reverse proxy**
- **Dream data is stored locally in `data/dreamer/`** — ensure file system is secure

---

## Files Modified for Dream Chat

**Core:**
- `apps/lantern-garage/lib/dream-chat.js` — Agent engine, provider selection
- `apps/lantern-garage/lib/stream-chat.js` — SSE streaming
- `apps/lantern-garage/lib/unified-agent.js` — Greeting/health/inspect
- `apps/lanterns-garage/lib/provider-router.js` — Provider failover logic
- `apps/lantern-garage/routes/dream.js` — API endpoints
- `apps/lantern-garage/public/dream-chat.html` — Frontend UI
- `apps/lantern-garage/public/js/dream-chat.js` — Frontend logic

**Dependencies:**
- `apps/lantern-garage/lib/mcp-resource-client.js` — Context loading
- `apps/lantern-garage/lib/dreamer-store.js` — Conversation persistence
- `apps/lantern-garage/lib/csf-memory.js` — Memory integration
- `apps/lantern-garage/lib/web-search-client.js` — Grounding search

---

**Last Updated:** 2026-06-14
