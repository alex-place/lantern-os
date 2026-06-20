# Keystone FT (LoRA-Tuned Claude Replacement) — Code Integration Map

## Current Architecture

### 1. Agent Configuration
**File:** `data/training/ft-result.json`
- Agent ID: `agent_01XLCumJKAJzNtUiB1FQTWrT`
- Memory Store: `memstore_01WYD6jnTDjbCDGPSHGWPeqx`
- Base Model: `claude-haiku-4-5-20251001`
- Training Data: `data/training/haiku-ft-pairs.jsonl` (984KB)

### 2. Chat Streaming Integration
**File:** `apps/lantern-garage/lib/stream-chat.js:906-943`
```javascript
// Provider 0b: Keystone FT managed agent
if (message && requestedProvider === "keystone-ft") {
  const sseStream = unifiedAgentStreamSSE(message, agent.id, "keystone-ft", dreamContext);
  // Streams via unified Python connector (managed sessions API)
  // Falls back to messages API if managed sessions unavailable
}
```

### 3. Unified Agent Connector
**File:** `apps/lantern-garage/lib/unified-agent.js`
- Function: `unifiedAgentStreamSSE()`
- Handles: SSE streaming, token parsing, error handling
- Fallback Chain: Managed Sessions API → Messages API → Ollama local

### 4. Provider Routing (Phase 1 ✓ IMPLEMENTED)
**File:** `apps/lantern-garage/lib/provider-cache.js:9-21`
```javascript
const PROVIDERS = [
  { id: "keystone-ft", env: ["ANTHROPIC_API_KEY"], managed: true },
  // ... other providers
];
```

### 5. Dream Chat Auto-Routing (Phase 1 ✓ IMPLEMENTED)
**File:** `apps/lantern-garage/lib/dream-chat.js:541-557`
```javascript
// Keystone FT: Auto-route Keystone agent to trained keystone-ft provider
if (agent.id === "keystone" && !rp) {
  if (fs.existsSync(path.resolve(__dirname, "../../data/training/ft-result.json"))) {
    rp = "keystone-ft";  // Auto-select keystone-ft for Keystone agent
  }
}
```

### 6. Model Registry Entry (Phase 1 ✓ IMPLEMENTED)
**File:** `apps/lantern-garage/lib/model-registry.js:7-15`
```javascript
keystone: {
  profileId: "keystone-ft",
  ftAgentId: "agent_01XLCumJKAJzNtUiB1FQTWrT",
  memoryStoreId: "memstore_01WYD6jnTDjbCDGPSHGWPeqx",
  baseModel: "claude-haiku-4-5-20251001",
  trainingData: "data/training/haiku-ft-pairs.jsonl",
  surfaces: ["dream-chat", "orchestration", "code-execution"],
}
```

### 7. Dream Chat Agent Selection
**File:** `apps/lantern-garage/lib/dream-chat.js:198-209`
- Keystone persona loaded from `data/contexts/personas.json` or `_DEFAULT_PERSONAS`
- System prompt: Technical coding assistant with GitHub issue handling
- Symbol: "technical guide, code expert, engineering support"

## Integration Roadmap

### ✅ Phase 1: Provider Registration & Auto-Routing (COMPLETE)
- [x] Agent created and trained
- [x] Memory store attached
- [x] SSE streaming handler present
- [x] keystone-ft added to PROVIDERS list in provider-cache.js
- [x] Auto-routing implemented in dream-chat.js (checks ft-result.json)
- [x] Model registry entry added with agent metadata

### Phase 2: Memory Optimization
- [ ] Validate memory store on each request
- [ ] Cache recent context (last 5 messages per session)
- [ ] Prune memory store if exceeds 50KB per session
- [ ] Add `lastContextRecall` timestamp to PCSF receipt

### Phase 3: Fallback & Degradation
- [ ] If keystone-ft fails, fall back to anthropic with Keystone system prompt
- [ ] Record provider chain attempts in PCSF receipt
- [ ] Log memory store errors separately (don't block chat)

### Phase 4: Observability
- [ ] Add metrics: keystone-ft usage count, latency, memory store hits
- [ ] Dashboard panel: "Keystone FT Stats" (success rate, avg latency)
- [ ] Enable debug mode: `?debug=keystone-ft` shows agent metadata

## File Dependencies

```
dream-chat.js (chat routing + auto-selection)
  ├─ checks → data/training/ft-result.json (agent config)
  ├─ uses → stream-chat.js (provider implementation)
  └─ reads → data/contexts/personas.json (Keystone definition)

stream-chat.js (chat streaming)
  ├─ routes keystone-ft → unified-agent.js
  └─ builds → PCSF receipt with agent metadata

unified-agent.js (SSE streaming)
  └─ streams from → Anthropic Agents API (managed sessions)

provider-cache.js (provider discovery)
  └─ tracks → keystone-ft in PROVIDERS list

model-registry.js (model profiles)
  └─ defines → keystone entry with FT agent IDs
```

## Test Vectors

### 1. Auto-routing Test
```bash
# Request Keystone agent (no provider specified)
curl "http://127.0.0.1:4177/api/dream/stream?userMessage=test&agent=keystone"

# Expected: Routes to keystone-ft automatically (checks ft-result.json)
# Log output: "[dream-chat] Keystone agent → auto-routing to keystone-ft"
```

### 2. Direct Provider Request
```bash
# Explicitly request keystone-ft
curl "http://127.0.0.1:4177/api/dream/stream?userMessage=test&agent=keystone&provider=keystone-ft"

# Expected: Uses managed agent API directly from ft-result.json
```

### 3. Memory Store Integration
```bash
# Multi-turn conversation
1. Send: "Remember this: I like Python development"
2. Send: "What do I like?" 
   Expected: Agent recalls Python preference from memory store
```

### 4. Error Handling
```bash
# Missing ft-result.json
rm data/training/ft-result.json
curl "http://127.0.0.1:4177/api/dream/stream?userMessage=test&agent=keystone"
# Expected: Falls back to anthropic with Keystone system prompt
```

### 5. Provider Chain
```bash
# No Anthropic key, keystone-ft should fail gracefully
unset ANTHROPIC_API_KEY
curl "http://127.0.0.1:4177/api/dream/stream?userMessage=test&agent=keystone&provider=keystone-ft"
# Expected: Falls back to gemini/openai/xai/ollama chain
```

## Key Files Modified

1. **provider-cache.js** — Added keystone-ft to PROVIDERS list (line 9)
2. **dream-chat.js** — Added auto-routing logic for Keystone agent (lines 543-557)
3. **model-registry.js** — Added keystone entry with FT metadata (lines 8-15)

## Environment Variables

No new environment variables required. Uses existing:
- `ANTHROPIC_API_KEY` — Required for keystone-ft (same as anthropic provider)
- `OLLAMA_BASE_URL` — Falls back to local Ollama if main providers unavailable

## Deployment Checklist

- [x] ft-result.json with valid agent & memory store IDs
- [x] Provider cache includes keystone-ft
- [x] Dream-chat checks ft-result.json on agent selection
- [x] Model registry includes keystone profile
- [ ] Test keystone-ft in local preview
- [ ] Verify memory store integration works
- [ ] Document in CLAUDE.md

## Next Sprint

1. Implement Phase 2 memory optimization
2. Add observability dashboard for Keystone FT metrics
3. Integrate into GitHub issue workflow (Keystone auto-routes to ft)
4. Training pipeline v2 (continuous improvement from chat logs)
