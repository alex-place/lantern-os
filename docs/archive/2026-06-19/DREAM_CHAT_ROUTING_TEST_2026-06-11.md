# Dream Chat Routing Test Report
**Date:** 2026-06-11  
**Environment:** Chrome dev preview (http://127.0.0.1:4177/dream-chat.html)  
**Server:** npm start running lantern-garage

---

## Test Results

### Test 1: Engineering Intent
**Input:** "make changes to the repo to integrate the trading agent"  
**Expected:** Engineering mode response with Problem/Approach/Changes structure  
**Actual:** Dream reflection response about integrating trading agent conceptually  
**Status:** ❌ FAILED — Not routing to engineering

**Response received:**
> "It seems you've been working on integrating a trading agent into your Lantern OS repository. This action in my impact various aspects of the system, including the door choices and the contextual awareness of the Door Engine. Which part of this do you already know about the potential implications for the door choices or the Door Engine v1 rules? The glowing forest in your dream might offer insights to help guide these changes."

**Analysis:** Response is dream persona, not engineering. Incorporates "trading agent" and "door" into dream narrative instead of routing to code surface.

---

### Test 2: RP/Game Intent
**Input:** "let's play three doors"  
**Expected:** Route to Three Doors game surface, start game  
**Actual:** Dream narrative response about discovering a hidden path in dream  
**Status:** ❌ FAILED — Not routing to Three Doors

**Response received:**
> "In the glowing forest of your dream, you discovered a hidden path that revealed new strategies for integrating the trading agent into the Door Engine. The integration could be likened to a newfound understanding of the Elephant Door, which now carries whispers of its hidden messages within its walls."

**Analysis:** Response incorporates "three doors" into dream metaphor instead of launching actual game.

---

### Test 3: Code Review Intent
**Input:** "code review: check the PR for bugs"  
**Expected:** Structured engineering response analyzing PR  
**Actual:** Dream persona response "code review: take a peek at the PR to nab any pesky bugs"  
**Status:** ❌ FAILED — Not routing to code review surface

**Response received:**
> "code review: take a peek at the PR to nab any pesky bugs."

**Analysis:** Response is playful/dream persona, not engineering. No actual PR analysis or routing to code review tool.

---

## Current State Assessment

### What's Broken
1. **Engineering mode detection** (from commit 574da1a) is not activating
   - Trigger phrases like "make changes", "code review", "integrate" are not being detected
   - Or detection is working but routing is not

2. **Intent routing** is not implemented
   - All requests fall through to default dream persona
   - No capability registry exists
   - No agent selection based on intent

3. **Convergence integration** is not present
   - Dream Chat is not calling convergence loop
   - No wait state UI
   - No agent delegation

### What's Working
- Dream Chat UI is responsive
- Streaming responses work
- Dream persona is coherent
- Message persistence works

---

## Implementation Gap Analysis

### For Router Architecture (Issue #342) to Work

**Phase 1 (Convergence Contract):**
- [ ] Inspect `src/convergence_io_engine.py` for stable API
- [ ] Inspect Node routes for convergence plumbing
- [ ] Determine: direct Python call vs thin Node adapter
- [ ] **Blocker:** Without understanding convergence contract, routing can't delegate

**Phase 2 (Intent Classification):**
- [ ] Intent classifier needs to work (currently broken or missing)
- [ ] Capability registry needed (doesn't exist)
- [ ] Route decision logic needed (doesn't exist)
- [ ] **Blocker:** "make changes" and "code review" aren't triggering any different behavior

**Phase 3 (UI Wait State):**
- [ ] Add routing card to UI
- [ ] Add waiting/progress spinner
- [ ] **Blocker:** Can't test until convergence delegation works

**Phase 4 (Convergence Delegation):**
- [ ] Wire sendMessage() to route decision
- [ ] Implement convergence call
- [ ] Implement wait/poll logic
- [ ] Surface agent result back to user
- [ ] **Blocker:** Convergence contract must be known

**Phase 5 (Tests):**
- [ ] Mode-routing tests (code vs RP vs trading)
- [ ] Convergence delegation tests
- [ ] Failed routing tests
- [ ] **Blocker:** Phases 1-4 must be working

---

## Recommended Next Steps

### Immediate (Phase 1)
1. **Inspect `src/convergence_io_engine.py`:**
   ```bash
   cd /root/lantern-os
   grep -n "class\|def " src/convergence_io_engine.py | head -50
   cat src/convergence_io_engine.py | head -100
   ```

2. **Inspect Node convergence routes:**
   ```bash
   grep -r "convergence" apps/lantern-garage/routes/ | head -20
   grep -r "convergence\|!convergence" apps/lantern-garage/lib/ | head -20
   ```

3. **Document convergence contract:**
   - What's the input format? (JSON object? command string?)
   - What's the output format? (JSON? event stream?)
   - Is it blocking or async?
   - What agents can it route to?

### After Phase 1
Once convergence contract is documented:

4. **Build intent classifier + capability registry:**
   - Start with deterministic rules (keyword matching)
   - Map triggers to intents
   - Build agent capability objects

5. **Build route decision logic:**
   - Intent → agent lookup
   - Check convergence requirement
   - Return route object

6. **Wire sendMessage() to routing:**
   - Classify intent
   - Decide route
   - If convergence: call convergence layer + wait
   - Surface result

---

## Key Finding

**The architecture pivot is correct.** Engineering mode should NOT be a mode. The current mode-switching approach (commit 574da1a) is not working anyway, and the routing approach is cleaner.

But routing can't be built without understanding the convergence contract first.

---

**Status:** 🚨 Blocked on Phase 1 (Convergence Contract Understanding)  
**Next Action:** Inspect convergence_io_engine.py and understand its API/CLI contract  
**Owner:** Alex Place / Claude Code  
**Date:** 2026-06-11
