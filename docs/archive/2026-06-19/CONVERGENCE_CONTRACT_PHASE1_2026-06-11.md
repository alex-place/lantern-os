# Phase 1: Convergence Contract (Complete)
**Date:** 2026-06-11  
**Status:** ✅ Documented  

---

## Python Convergence Engine

**Location:** `src/convergence_io_engine.py`  
**Type:** Python CLI + HTTP Server

### CLI Interface (Primary)
```bash
python src/convergence_io_engine.py converge \
  --message "What should I do next?" \
  --persona "lantern" \
  --provider "anthropic"
```

**Input:**
- `--message`: User request/input string
- `--persona`: Agent persona (lantern, keystone, founder, blinkbug, etc.)
- `--provider`: LLM provider (anthropic, openai, gemini, xai, grok, offline)

**Output:** JSON (stdout)
```json
{
  "status": "ok|error",
  "request_id": "string",
  "timing": { "latency_ms": number },
  "result": { "reply": "string", "agent": "string", ... }
}
```

### Other Commands
- `loop`: Main convergence loop (runs continuously)
- `daemon`: Background daemon with polling (--interval 30.0)
- `batch`: Process multiple tasks from JSON file
- `health`: Check system health
- `inspect`: Inspect convergence state
- `validate-ring`: Validate agent ring
- `watch`: Monitor for state drift

### HTTP Server
- Listens on port (configurable, default implied from context)
- Has health endpoint, batch endpoint
- Not currently wired to Node routes

---

## Node.js Integration (Current State)

**Location:** `apps/lantern-garage/lib/dream-chat.js::handleConvergenceCommand()`

### Current Implementation
- Checks for `!convergence` command in message
- Calls local **Ollama** (not Python TesseractEngine)
- Synthesizes recent dreams into insight
- Returns local JSON response

### Gap
**The Python convergence engine is NOT integrated with Node.**

Current flow:
```
Dream Chat → !convergence → Ollama (local) → Synthesis
```

Needed flow:
```
Dream Chat → Intent Router → Python TesseractEngine → Agent → Result
```

---

## What Router Needs (Phase 2+)

### Node Adapter for Python Convergence

Create thin wrapper in Node to call Python convergence CLI:

```javascript
// apps/lantern-garage/lib/convergence-adapter.js

async function callConvergence(message, persona, provider = "auto") {
  return new Promise((resolve, reject) => {
    const py = spawn("python", [
      path.join(REPO_ROOT, "src", "convergence_io_engine.py"),
      "converge",
      "--message", message,
      "--persona", persona,
      "--provider", provider
    ]);
    
    let stdout = "";
    py.stdout.on("data", (data) => { stdout += data; });
    py.on("close", (code) => {
      if (code === 0) {
        resolve(JSON.parse(stdout));
      } else {
        reject(new Error(`Convergence failed: ${code}`));
      }
    });
  });
}

module.exports = { callConvergence };
```

### Integration Point
In Dream Chat router (to be built):

```javascript
async function routeAndDelegate(intent, message, persona, surface) {
  if (surface === "convergence") {
    const result = await callConvergence(message, persona);
    return result;  // {reply, agent, timing, ...}
  }
  // Other surfaces...
}
```

---

## Architecture Decision

### Option A: Direct Python Subprocess Call
**Pros:** Simple, direct, no network overhead  
**Cons:** Blocks on Python execution, no streaming

**Recommended:** Start here for MVP

### Option B: HTTP Server
**Pros:** Async, non-blocking, can stream results  
**Cons:** Requires running separate Python server

**Recommended:** Phase 2+ for production

---

## Agents in Convergence

From `src/convergence_io_engine.py` line ~2443:

```python
{
  "id": "lantern",
  "name": "Lantern",
  "capabilities": ["dream_synthesis", "symbolic_guidance", "memory_integration"],
  "base_model": "claude-3.5-sonnet",
}
```

Available personas:
- `lantern`: Dream synthesis + symbolic
- `keystone`: Code/structure focus
- `founder`: Strategy/vision
- `blinkbug`: Rapid prototyping
- `waterfall`: Sequential/waterfall
- `xenon`: Chaos/exploration

---

## Status

✅ **Phase 1 Complete**
- [x] Convergence engine identified
- [x] CLI contract documented
- [x] Current Node integration gap identified
- [x] Adapter pattern defined
- [x] Agent personas known

🚀 **Phase 2 Ready**
- [ ] Build convergence-adapter.js
- [ ] Add intent classifier
- [ ] Build capability registry
- [ ] Wire sendMessage() to router

---

## Key Insight

**The convergence engine is ready. It just needs a Node wrapper.**

Dream Chat router can immediately call:
```bash
python src/convergence_io_engine.py converge \
  --message "$USER_INPUT" \
  --persona "$ROUTED_AGENT" \
  --provider "auto"
```

And surface the JSON result back to the user.

---

**Next:** Build Phase 2 (Intent Classification + Routing)

