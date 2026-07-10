# Dream Chat Handoff Package

**Prepared:** 2026-06-14  
**For:** Next Developer / Team Takeover  
**System:** Lantern OS Dream Journal  

---

## Quick Start

```bash
# 1. Install dependencies
npm install --prefix apps/lantern-garage

# 2. Copy environment template
cp .env.example .env

# 3. Add your API keys to .env
#    - Edit .env
#    - Add at least one: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY
#    - Or keep Ollama if you want offline mode

# 4. Start Ollama (optional, for offline AI)
ollama serve

# 5. Start MCP Server (required for live persona loading)
npm run mcp  # in separate terminal

# 6. Start Dream Chat server
npm start --prefix apps/lantern-garage

# 7. Open browser
# http://127.0.0.1:4177/dream-chat.html
```

---

## Architecture Overview

### System Layers

```
┌─────────────────────────────────────────────────────────────┐
│ Frontend: dream-chat.html                                   │
│  - Message UI (sidebar, chat, input)                        │
│  - Persona selector                                          │
│  - SSE stream handler (real-time updates)                   │
└────────────┬────────────────────────────────────────────────┘
             │ HTTP + WebSocket
             ↓
┌─────────────────────────────────────────────────────────────┐
│ API Layer: routes/dream.js                                  │
│  - POST /api/dream/create  (start new conversation)         │
│  - POST /api/dream/chat    (send message, get job ID)       │
│  - GET  /api/dream/stream  (SSE: real-time response)        │
│  - GET  /api/dream/greet   (agent greeting)                 │
│  - GET  /api/agent/health  (provider health)                │
└────────────┬────────────────────────────────────────────────┘
             │ Internal Calls
             ↓
┌─────────────────────────────────────────────────────────────┐
│ Dream Chat Engine: lib/dream-chat.js                        │
│  - Agent selection (persona matching)                        │
│  - Provider routing (with automatic failover)                │
│  - Prompt construction (agent personality + context)         │
│  - Response parsing (handle streaming)                       │
└────────────┬────────────────────────────────────────────────┘
             │ Parallel Processing
      ┌──────┼──────┬────────────┬──────────┐
      ↓      ↓      ↓            ↓          ↓
   Ollama  Claude OpenAI      Gemini    Offline
  (local) (cloud) (cloud)     (cloud)   (fallback)
```

### Data Flow for Single Message

```
User types message
    ↓
POST /api/dream/chat (request)
    ↓
Create Job (async processing)
    ↓
Return { jobId, status }
    ↓
Frontend polls GET /api/dream/job/{jobId}
    ↓
[Server processes message in background]
    ├─ Load recent conversation history
    ├─ Select agent persona
    ├─ Route to AI provider (with retry)
    ├─ Generate response (streaming)
    ├─ Save to conversation store
    └─ Update job status
    ↓
Frontend gets { status: "complete", result: "..." }
    ↓
Display message in UI
```

---

## File Structure

```
apps/lantern-garage/
├── server.js                          ← Main entry point
├── package.json                       ← Dependencies (Node 20+)
├── public/
│   ├── dream-chat.html               ← Frontend UI
│   ├── js/
│   │   └── dream-chat.js            ← Frontend logic (SSE handler)
│   └── css/
│       └── dream-chat.css           ← Styles
├── routes/
│   └── dream.js                      ← API endpoints (/api/dream/*)
└── lib/
    ├── dream-chat.js                 ← CORE: Agent + provider selection
    ├── stream-chat.js                ← Response streaming (SSE)
    ├── unified-agent.js              ← Greeting/health/inspect
    ├── provider-router.js            ← Provider failover logic
    ├── mcp-resource-client.js        ← Load personas from MCP
    ├── dreamer-store.js              ← Conversation persistence
    ├── csf-memory.js                 ← Memory integration
    ├── web-search-client.js          ← Gemini web search grounding
    └── ... (other services)

data/
├── dreamer/                          ← Conversation storage (JSONL)
│   └── {username}/
│       ├── dreams.jsonl             ← All dream entries
│       └── conversations/           ← Chat logs
└── contexts/
    └── personas.json                ← Agent personas (loaded via MCP)
```

---

## Startup Sequence (Detailed)

### 1. Environment Loading (server.js:1-50)
- Read `.env` file if exists
- Load all `process.env.*` variables
- Set defaults if not provided
- Validate required variables

### 2. Service Initialization (server.js:50-150)
```
A. Load core libraries
   - HTTP utilities (sendJson, sendFile, etc.)
   - File queues (async append-only writes)
   - Conversation storage (JSONL)
   - RAG House (knowledge base)

B. Initialize provider cache
   - Cache recent provider successes
   - Monitor provider health
   - Track fallback chain

C. Load Dream Chat engine
   - Load agent personas (from MCP or fallback)
   - Initialize provider router
   - Setup streaming SSE handler

D. Start async workers
   - Job queue processor (background)
   - Job worker (video analysis, exports)
   - PCSF refresh (configuration polling)
```

### 3. Server Startup (server.js:150+)
```
A. Attach route handlers
   - Dream Chat routes (/api/dream/*)
   - Agent health (/api/agent/health)
   - Server status (/api/status)
   - Creator Suite routes (/api/creator/*)
   - Static file server (public/)

B. Bind to port
   - Default: 127.0.0.1:4177
   - Configurable via LANTERNS_GARAGE_PORT/HOST

C. Log startup message
   - "Lantern Garage port 4177"
   - All providers initialized or logged as unavailable
```

---

## Provider Selection Algorithm

### When user sends a message:

```javascript
1. Get request body { message, provider?: "anthropic" | "openai" | ... }

2. If provider specified
   → Use that provider (or fail if invalid)

3. Else, try providers in order:
   a. Check provider cache (last success)
   b. Try Ollama (if OLLAMA_BASE_URL reachable)
   c. Try Anthropic (if ANTHROPIC_API_KEY set)
   d. Try Google Gemini (if GEMINI_API_KEY set)
   e. Try OpenAI (if OPENAI_API_KEY set)
   f. Fall back to hardcoded offline response

4. If provider succeeds
   → Cache it (next request tries same provider)
   → Return response to user

5. If provider fails
   → Try next in chain
   → If all fail → return "sorry, all providers down"
```

### Timeout Handling:
- **Ollama:** `OLLAMA_TIMEOUT_MS` (default 2 minutes)
- **Cloud APIs:** 5 seconds hardcoded
- If timeout → next provider in chain

---

## Required Services

### Critical
1. **Node.js 20+**
   - `npm start`
   - Web server, routing, persistence

2. **At least 1 AI Provider**
   - Anthropic (cloud)
   - OpenAI (cloud)
   - Google Gemini (cloud)
   - Ollama (local, optional)

### Highly Recommended
3. **MCP Server** (for live persona loading)
   - `npm run mcp` (separate terminal)
   - Loads `context://personas` resource
   - Falls back to hardcoded if unavailable

### Optional
4. **Ollama** (for offline AI capability)
   - `ollama serve` (separate process)
   - Enables 100% offline mode
   - Falls back to cloud if unavailable

5. **Stable Diffusion** (for image generation)
   - `python -m sd_cli` (if enabled)
   - Falls back gracefully if unavailable

6. **Discord Bot** (for Discord integration)
   - Requires `DISCORD_BOT_TOKEN`
   - Falls back if unavailable

---

## Known Issues & Workarounds

### Issue 1: "All providers down" on startup
**Symptoms:** Dream Chat returns "sorry, all providers down"  
**Cause:** No API keys set and Ollama not running  
**Fix:**
```bash
# Option A: Set an API key
export ANTHROPIC_API_KEY=sk-ant-...

# Option B: Start Ollama
ollama serve &

# Restart server
npm start
```

### Issue 2: "MCP resource not found"
**Symptoms:** Hardcoded personas load, custom personas missing  
**Cause:** MCP server not running or port mismatch  
**Fix:**
```bash
# Terminal 1: Start MCP server
npm run mcp

# Terminal 2: Verify it's running
curl http://127.0.0.1:8771/health

# Terminal 3: Restart Dream Chat
npm start
```

### Issue 3: Ollama timeout on slow hardware
**Symptoms:** "Ollama timeout" error after 2 minutes  
**Cause:** Model too large for available resources  
**Fix:**
```bash
# Increase timeout
export OLLAMA_TIMEOUT_MS=300000  # 5 minutes

# Or use smaller model
export OLLAMA_MODEL=qwen2.5-coder:7b
```

### Issue 4: Web Search Grounding not working
**Symptoms:** Gemini doesn't return web search results  
**Cause:** `GEMINI_GROUNDING=false` or `GEMINI_SEARCH_GROUNDING` needs key  
**Fix:**
```bash
export GEMINI_GROUNDING=true
export GEMINI_API_KEY=AIzaSy...  # Valid key required
```

---

## Testing Procedures

### Manual Testing
```bash
# 1. Start server
npm start --prefix apps/lantern-garage

# 2. Open browser
open http://127.0.0.1:4177/dream-chat.html

# 3. Test journey:
#    a. Click "New Chat"
#    b. Select persona (Lantern, Blinkbug, unisona.ai, etc.)
#    c. Type message: "Hello"
#    d. Check progress bar (should show 0-100%)
#    e. Wait for response
#    f. Verify response matches persona style
#    g. Send follow-up message
#    h. Check conversation history loads

# 4. Test provider switching:
#    a. In browser console: sessionStorage.setItem('forceProvider', 'anthropic')
#    b. Send message → should use Anthropic
#    c. Repeat with 'openai', 'gemini', 'ollama'

# 5. Test offline:
#    a. Kill all cloud API processes
#    b. Keep Ollama running
#    c. Send message → should use Ollama
#    d. Verify response received
```

### Automated Tests
```bash
# Run all tests
npm test --prefix apps/lantern-garage

# Run specific tests
npm run test:chat      # Dream Chat tests
npm run test:api       # API endpoint tests
npm run test:multiturn # Multi-message conversations
```

### Health Checks
```bash
# Check server status
curl http://127.0.0.1:4177/api/health

# Check agent health (providers available)
curl http://127.0.0.1:4177/api/agent/health

# Check full system status
curl http://127.0.0.1:4177/api/status
```

---

## Environment Variable Checklist

```
□ ANTHROPIC_API_KEY (or equivalent)
□ LANTERNS_GARAGE_PORT (or default to 4177)
□ LANTERNS_GARAGE_HOST (or default to 127.0.0.1)
□ OLLAMA_BASE_URL (optional, for offline)
□ GEMINI_API_KEY (optional, for web grounding)
□ OPENAI_API_KEY (optional, fallback provider)
□ MCP_SERVER_PORT (default 8771)
□ DISCORD_BOT_TOKEN (if Discord integration needed)

Minimum viable: 1 API key + Lanterns_GARAGE_PORT
```

---

## Monitoring & Debugging

### Enable Debug Logging
```bash
# In server.js or lib/dream-chat.js, uncomment:
console.log("[dream-chat]", ...);
console.error("[dream-error]", ...);
```

### Watch Logs
```bash
# See all dream-chat related logs
grep "\[dream" /tmp/lantern.log

# Monitor in real-time
tail -f /tmp/lantern.log | grep dream
```

### Check Provider Status
```bash
# See which providers are initialized
curl http://127.0.0.1:4177/api/agent/health | jq '.providers'

# Monitor provider failures
grep "provider.*failed\|fallback" /tmp/lantern.log
```

---

## Performance Characteristics

| Aspect | Value | Notes |
|--------|-------|-------|
| Message latency | 1-3 sec | Cloud provider, depends on model |
| Stream update freq | 200-500ms | Real-time progress updates |
| Memory usage | ~200MB idle | Grows with conversation history |
| Max message length | 16,000 chars | Hard limit in code |
| Conversation history | Unlimited | Stored to disk |
| Persona load time | <100ms | From cache or MCP |
| Failover timeout | 5 sec | Per provider attempt |

---

## Open TODOs & Future Work

- [ ] Implement conversation search (full-text index)
- [ ] Add voice input/output (ElevenLabs integration)
- [ ] Support context-aware persona switching
- [ ] Implement conversation branching (alternative responses)
- [ ] Add export conversation to PDF
- [ ] Performance: optimize dream.jsonl reads for large histories
- [ ] Add rate limiting per user/IP
- [ ] Implement conversation sharing (generate public links)

---

## Security Considerations

1. **API Keys**
   - Never log full API keys
   - Rotate keys every 90 days
   - Use different keys for dev/prod
   - Alert on unusual usage patterns

2. **User Data**
   - Dreams stored locally in `data/dreamer/`
   - No backup to cloud unless explicitly configured
   - GDPR: implement export/delete functionality
   - Consider encryption at rest

3. **Rate Limiting**
   - Not implemented (TODO)
   - Add before production deployment
   - Recommend: 10 req/sec per IP, 100 req/sec global

4. **Input Validation**
   - Max message length: 16,000 chars (enforced)
   - Persona selection validated against hardcoded list
   - Provider selection validated against known providers
   - Assume MCP resources are trusted

---

## Production Deployment Checklist

- [ ] All env vars set (use secrets manager, not .env)
- [ ] At least 2 AI providers configured (for redundancy)
- [ ] Ollama running on separate machine (if offline required)
- [ ] MCP server running on separate machine
- [ ] Reverse proxy configured (nginx or similar)
- [ ] HTTPS/TLS enabled
- [ ] Rate limiting configured
- [ ] Monitoring & alerting setup
- [ ] Log aggregation (ELK, CloudWatch, etc.)
- [ ] Backup strategy for `data/dreamer/` implemented
- [ ] Tested failover scenarios
- [ ] Load tested (expect <500ms latency at 100 req/sec)

---

## Contact & Support

**Repository:** https://github.com/anthropics/lantern-os  
**Issues:** [Lantern OS Issues](https://github.com/anthropics/lantern-os/issues)  
**Discord:** [Lantern Community Server](https://discord.gg/lantern)

**For Dream Chat Specific Issues:**
- Check logs: `grep "\[dream" server output`
- Run health check: `curl http://127.0.0.1:4177/api/agent/health`
- Verify env vars: `env | grep ANTHROPIC\|OPENAI\|GEMINI\|OLLAMA`

---

**Document Version:** 1.0  
**Last Updated:** 2026-06-14  
**Status:** Ready for handoff
