# Dream Chat Architecture Pivot — 2026-06-11

## Executive Summary

**Old Architecture (Invalid):**
Dream Chat is an interface that switches between modes (RP, Engineering). It has a mode-switcher that detects keywords and alters behavior.

**New Architecture (Correct):**
Dream Chat is an **orchestration router/dispatcher**. It classifies user intent, routes to the appropriate agent via capability registry, invokes !convergence loop if needed, waits for results, and surfaces the final answer.

---

## The Pivot

### Before (Issue #341 — Now Void)
```
User: "integrate the trading agent"
  ↓
Dream Chat detects "integrate" (engineering trigger)
  ↓
Dream Chat becomes "Engineering Mode"
  ↓
Outputs structured engineering plan
  ↓
User reads direct output from Dream Chat
```

### After (Issue #342 — New Direction)
```
User: "integrate the trading agent"
  ↓
Dream Chat classifies intent: code
  ↓
Dream Chat routes to: Keystone (engineer) via convergence loop
  ↓
Dream Chat displays: "Routing to Keystone via convergence…"
  ↓
Keystone (downstream agent) handles the request
  ↓
Dream Chat waits for convergence result
  ↓
Dream Chat surfaces final output from Keystone
```

**Key Insight:** Engineering behavior is now a **route destination**, not a Dream Chat mode.

---

## What Changed

### Issue #341 (Engineering Mode)
**Status:** VOID with comment explaining the pivot

**Why:** The framing was incorrect. Dream Chat should not be an engineer. Engineering is a downstream route.

### Issue #342 (Orchestration Router)
**Status:** CREATED to track correct architecture

**What it covers:**
- Route decision model
- Agent capability registry
- Intent classification
- UI wait state / progress
- Convergence delegation
- Phase 0-5 implementation plan

---

## Route Model

Each user request produces:

```json
{
  "intent": "code|rp_game|strategy|memory_export|dream_analysis|trading|unknown",
  "agent": "keystone|founder|lantern|blinkbug|trading|csf|three_doors",
  "surface": "dream_chat|three_doors|convergence|csf_export",
  "confidence": 0.0-1.0,
  "reason": "string explaining why",
  "requires_convergence": boolean
}
```

Examples:

| User Input | Intent | Agent | Surface | Converges |
|-----------|--------|-------|---------|-----------|
| "make changes" | code | keystone | convergence | true |
| "play three doors" | rp_game | three_doors | three_doors | false |
| "help me think" | strategy | founder | convergence | true |
| "export dreams" | memory_export | csf | csf_export | true |
| "what do my dreams mean?" | dream_analysis | lantern | dream_chat | false |
| "check trades" | trading | trading | convergence | true |
| "hey what's up?" | unknown | lantern | dream_chat | false |

---

## Agent Capability Registry

Each agent declares:
- id, name, display name
- intents it handles (["code", "refactor", "bug_fix"])
- trigger examples (["make changes", "integrate", "implement"])
- input/output contracts
- Whether it converges (runs through !convergence loop)
- Whether it's blocking (UI waits for completion)

---

## UI/UX for Wait State

Dream Chat should NOT silently block.

```
[User sends request]

[Routing card appears]
"Intent: code"
"Agent: Keystone via convergence loop"
"Status: queued"

[Spinner begins]
"Routing through convergence…"
"Keystone is handling this…"
"Waiting for result…"

[On completion]
[Result from Keystone displays in chat]
```

---

## Preserved Work (Not Deleted)

Commit `574da1a` (Engineering Mode) should NOT be blindly reverted.

Useful pieces to preserve:
- Engineering triggers array (refactor to intent classification)
- Engineer persona (keep as downstream Keystone capability)
- Structured output format (Problem/Approach/Changes/Verification/Notes)
- Door suppression logic (keep for code routing rules)
- ENGINEERING_MODE.md (refactor into routing docs)

Refactoring pattern:
```javascript
// Old (invalid):
const engineeringMode = detectEngineeringMode(message);
if (engineeringMode) {
  setAgent("engineer");
  suppressDoors = true;
}

// New (correct):
const route = classifyAndRoute(message);
if (route.intent === "code") {
  convergeWith(route.agent);
  suppressDoors = true;
}
```

---

## Related Issues — Updated

| Issue | Status | What Changed |
|-------|--------|--------------|
| #341 | VOID | Engineering mode framing superseded; pivot explained in comment |
| #342 | CREATED | New orchestration router architecture |
| #332 | Updated | RP responsiveness is now a route target; linked to #342 |
| #305 | Updated | Three Doors CSF is now a route destination; pivot clarified |
| #333–#337 | Updated | Three Doors phases are route targets; completion status valid |
| #325 | Updated | Trading cube still separate; engineering state no longer needed |

---

## Implementation Phases (Per Issue #342)

### Phase 0 — Issue Reconciliation
- Void/rescope #341 ✅
- Create #342 ✅
- Update related issues ✅
- Capability registry stub

### Phase 1 — Convergence Contract
- Inspect src/convergence_io_engine.py
- Inspect Node convergence routes
- Decide: direct call vs thin adapter
- Document convergence API

### Phase 2 — Intent Classification & Routing
- Create intent classifier (rules first, embedding later)
- Implement agent capability registry
- Refactor engineeringMode → intent classification
- Add routing decision logic

### Phase 3 — UI Wait State
- Add routing card to Dream Chat UI
- Add waiting/progress state
- Add result rendering
- Add failure state

### Phase 4 — Convergence Delegation
- Wire sendMessage() to routing decision
- Call convergence layer if needed
- Poll/block on result
- Surface agent output

### Phase 5 — Tests
- Code request routes to Keystone
- Three Doors request routes to RP_GAME
- Memory export routes to CSF
- Ambiguous defaults to Lantern
- Failed convergence handled gracefully
- !three-doors still works

---

## Key Architectural Decisions

1. **Dream Chat = Router, not Agent**
   - It does not become engineer/RP/anything
   - It routes to agents with those capabilities
   - Result: Cleaner separation of concerns

2. **Intent Classification First, Embedding Later**
   - Start with deterministic rules/keywords
   - Structure for embedding/LLM classification in future
   - Result: Predictable routing initially; more flexible later

3. **Convergence Layer is Delegation Mechanism**
   - Don't duplicate convergence logic in Dream Chat
   - Call existing Python convergence implementation
   - Result: Single source of truth for orchestration

4. **Preserve Useful Work from 574da1a**
   - Don't delete engineering triggers/persona
   - Move them behind routing
   - Result: No wasted work; cleaner abstraction

5. **Three Doors Remains Unchanged**
   - Not removed; explicitly a RP_GAME route target
   - Phases 0-4 complete; no rework needed
   - Result: Game continues working; now properly scoped

6. **Agent Registry is Extensible**
   - New agents can be added without Dream Chat code changes
   - Agents declare capabilities; Dream Chat just routes
   - Result: Scales to many agents without monolithic Dream Chat

---

## Convergence Contract (TBD)

Phase 1 must clarify:
- Does convergence have a stable CLI contract?
- Does it have an HTTP/REST API?
- Input: what does convergence accept? (JSON request object? command string?)
- Output: what does it return? (status, result, error)
- Blocking: does it return immediately or stream/poll?

---

## Status

**Phase 0:** ✅ COMPLETE (issue reconciliation done)
**Phase 1:** ⏳ NEXT (inspect convergence contract)
**Phase 2-5:** 📋 PLANNING (await Phase 1 findings)

---

## Files Changed (Phase 0)

- ARCHITECTURE_PIVOT_2026-06-11.md (this file)
- GitHub issues: #305, #325, #332, #333–#337, #341, #342 (comments/updates)
- issue-341-void-comment.txt (temp)
- issue-router-body.txt (temp)

---

**Next:** Phase 1 — Inspect convergence contract in src/convergence_io_engine.py and Node routes.

**Author:** Claude Code  
**Date:** 2026-06-11
