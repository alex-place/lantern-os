# Lantern OS Code → Convergence Core Mapping

Maps existing codebase to the four core objects and six-stage loop. Identifies what aligns, what diverges, and what needs refactoring.

> **⏱ Real-time status (updated 2026-06-19).** This document reads as a *future migration plan* ("Action: create a Memory class…"). Re-grounded against the tree on 2026-06-19, **most of it has already landed** — the four objects, the six-stage orchestrator ([`src/convergence/kernel.py`](../src/convergence/kernel.py)), the verify/closure ([`verify.py`](../src/convergence/verify.py)), and pattern extraction all exist in Python. The honest open gap is **wiring, not building**: the live serving path doesn't yet drive the Kernel end-to-end. **Landed since this doc was written:** token-budgeted Memory context (#772, `66ad7024`) and the **first end-to-end loop slice closing** (Kalshi: Reason→Verify→Converge, `8608e5e7`). Treat the "Action:" items below as the *original* plan — cross-check current open work against [`docs/research/2026-06-19-convergence-core-agent-spine.md`](research/2026-06-19-convergence-core-agent-spine.md) (file-by-file grounding) and [`docs/KEYSTONE-PROGRESS-REPORT-2026-06-19.md`](KEYSTONE-PROGRESS-REPORT-2026-06-19.md) (executive status).

---

## Four Core Objects

### 1. Memory — Append-Only Persistence

**Definition:** Immutable log entries (timestamp, source, confidence, content).

**Current Implementation:**
| File | Status | Notes |
|------|--------|-------|
| `data/*.jsonl` | ✓ Aligned | JSONL logs (conversations, trading, agent audits) |
| `csf/` + `caad/` | ✓ Aligned | CSF binary archive for compression + versioning |
| `src/mcp_server/` | ⚠ Partial | Exposes queue/task status but not structured memory read |
| `.memos/logs/` | ⚠ Partial | Task memory but not queryable as Convergence Records |

**Gaps:**
- No unified memory query interface (scattered across JSON read, CSF unpacking, MCP tools)
- No confidence field in JSONL entries (would enable "what do I know vs guess")
- No source tracking (which tool/agent/observation produced this)

**Action:** Create `Memory` class that wraps JSONL + CSF with query API:
```python
memory.append(timestamp, source, confidence, content)
memory.query(pattern, min_confidence=0.5)
```

---

### 2. Task — Goal + Constraints + Status

**Definition:** Work item with explicit goal, constraints, and progress tracking.

**Current Implementation:**
| File | Status | Notes |
|------|--------|-------|
| GitHub Issues | ✓ Aligned | #507-#523 define scope, acceptance criteria, blocking deps |
| `TaskCreate` tool | ⚠ Partial | Tracks work but doesn't expose constraints to reasoning |
| Dream chat | ⚗️ Diverged | User goals are freeform text, not structured Task objects |

**Gaps:**
- No structured Task object in codebase (just issues + git branches)
- Constraints are implicit in issue descriptions, not machine-readable
- No task-to-memory linkage (which memories does this task depend on?)

**Action:** Create `Task` dataclass:
```python
@dataclass
class Task:
    id: str
    goal: str
    constraints: List[str]  # must do X, must not do Y, deadline Z
    status: TaskStatus      # queued, in_progress, blocked, complete
    required_memories: List[MemoryId]
    
    def is_blocked(self, memories: List[Memory]) -> Tuple[bool, str]:
        # Check if all required_memories have confidence > threshold
        pass
```

---

### 3. Tool — Executable Capability

**Definition:** Something that takes input, produces output, reports success.

**Current Implementation:**
| File | Status | Notes |
|------|--------|-------|
| `apps/lanterns-garage/routes/` | ✓ Aligned | 60+ REST endpoints (trading, dream, convergence, etc.) |
| `src/mcp_server/server.py` | ✓ Aligned | MCP tools (task intake, dispatch, status) |
| `src/cio_sde/` | ⚠ Partial | Collapse detection + surprise monitor are computational, not I/O tools |
| Agent capabilities | ✗ Diverged | Agents are personas, not Tool objects |

**Gaps:**
- Tools don't report structured success/failure (mostly return JSON)
- No tool retry logic or confidence scoring on output
- Tools aren't composable (can't say "call Tool A then Tool B")

**Action:** Wrap existing routes in `Tool` abstraction:
```python
@dataclass
class Tool:
    name: str
    input_schema: Dict
    output_schema: Dict
    
    def call(self, input: Dict) -> ToolResult:
        result = self._impl(input)  # call actual route
        return ToolResult(
            success=result.get("ok", True),
            output=result,
            confidence=0.9 if result.get("ok") else 0.3
        )
```

---

### 4. Convergence Record — Hypothesis → Evidence → Result

**Definition:** One cycle of reasoning: "I hypothesize X, here's my evidence, this is the result."

**Current Implementation:**
| File | Status | Notes |
|------|--------|-------|
| `src/cio_sde/collapse.py` | ✓ Core pattern | `collapse_certificate()` is exactly this: hypothesis (α < margin) + evidence (eigenvalues) + result (guaranteed boolean) + confidence (active_dim) |
| `src/cio_sde/surprise.py` | ✓ Core pattern | NIS computation: hypothesis (model accurate) + evidence (ν^T S^-1 ν) + result (spook flag) + confidence (threshold) |
| Dream chat responses | ⚗️ Diverged | LLM outputs are text, not structured convergence records |
| Trading decisions | ⚗️ Diverged | Kalshi suggests are probabilities but not linked to memory/evidence |

**Gaps:**
- `collapse_certificate()` and `surprise.py` don't store results; they're ephemeral
- No linkage: "this convergence record was informed by these memories"
- LLM doesn't produce structured convergence records (just text)

**Action:** Create `ConvergenceRecord` and make reasoning chain explicit:
```python
@dataclass
class ConvergenceRecord:
    hypothesis: str
    evidence: List[MemoryId]  # which memories support this?
    result: Any               # claim / decision / output
    confidence: float         # 0.0-1.0
    timestamp: datetime
    reasoner: str             # which tool/agent produced this?
```

---

## Six-Stage Loop

### Stage 1: Observe

**Definition:** Capture external state via tools.

**Current Implementation:**
| Component | Status | Notes |
|-----------|--------|-------|
| Kalshi polling | ✓ Active | 6s interval, tight-band price stream |
| Conversation logs | ✓ Active | dream-chat.html captures user input |
| Trading history | ✓ Active | Order execution logged to JSONL |
| MCP server status | ✓ Active | Health checks available |

**Assessment:** ✓ Observe stage is solid. Data is continuously collected.

---

### Stage 2: Remember

**Definition:** Store and retrieve observations as memories.

**Current Implementation:**
| Component | Status | Notes |
|-----------|--------|-------|
| JSONL append | ✓ Functional | Logs are written; no conflict |
| CSF archive | ✓ Functional | Compression works for historical data |
| Memory queries | ✗ Missing | No API to ask "what price has Kalshi been at?" |
| Confidence tracking | ✗ Missing | All memories treated as equal credibility |

**Gap:** Remember stage is write-only. Need read interface.

**Action:** 
```python
# User asks: "What's been the lowest Kalshi price I've seen?"
memories = memory.query("kalshi price", order_by="value", asc=True, limit=1)
# Returns: Memory(timestamp=..., source="kalshi-collector", 
#                 confidence=0.99, content={"price": 23.50})
```

---

### Stage 3: Reason

**Definition:** Use memories + tools to form a hypothesis.

**Current Implementation:**
| Component | Status | Notes |
|-----------|--------|-------|
| Dream chat | ✓ Active | LLM reasons over conversation context |
| Convergence router | ✓ Active | Deterministic routing (120 cached patterns) |
| Kalshi suggest | ✓ Active | Tight-band entry algorithm |
| CIO-SDE engine | ✓ Active | Collapse certificate computes stability bounds |

**Assessment:** ✓ Reason stage works but outputs are heterogeneous:
- LLM → text
- Router → action choice
- Kalshi → price + confidence
- Collapse cert → boolean guarantee

**Gap:** No unified reasoning output format.

**Action:** Make all reasoners produce `ConvergenceRecord`:
```python
# Dream chat
record = ConvergenceRecord(
    hypothesis="The user is asking about trading strategy",
    evidence=[memory_of_prior_conversation],
    result="Recommend entering on tight-band compression",
    confidence=0.75,
    reasoner="dream-chat"
)

# Kalshi suggest
record = ConvergenceRecord(
    hypothesis="Tight-band is compressed (low vol)",
    evidence=[price_history_memory],
    result={"entry_price": 45.2, "target": 48.1},
    confidence=0.82,
    reasoner="kalshi-suggest"
)
```

---

### Stage 4: Act

**Definition:** Execute tool based on reasoning.

**Current Implementation:**
| Component | Status | Notes |
|-----------|--------|-------|
| API routes | ✓ Functional | dream, trading, convergence endpoints |
| Tool execution | ✓ Working | Keystone can spawn agents, place orders |
| Success reporting | ⚠ Partial | Routes return JSON but no standardized success field |

**Assessment:** ✓ Act stage is functional.

**Gap:** No action-to-reasoning linkage (which `ConvergenceRecord` led to this action?).

**Action:** Add tracing:
```python
# In API route handler
record = state["last_convergence_record"]  # from Reason stage
result = tool.call(record.result)          # execute action
# Store: action_memory = Memory(
#     source="kalshi-order",
#     linked_to_record=record.id,
#     confidence=result.confidence,
#     content=result.output
# )
```

---

### Stage 5: Verify

**Definition:** Check if action produced expected result.

**Current Implementation:**
| Component | Status | Notes |
|-----------|--------|-------|
| Kalman NIS | ✓ Active | surprise monitor detects model drift |
| Collapse proximity | ✓ Active | anti-collapse operator triggers on drift |
| Test suite | ✓ Active | 100+ tests validate core theory |
| External validation | ⚠ Partial | Kalshi tight-band used for trading validation |

**Assessment:** ✓ Verify stage is strong in theory (Σ₀ framework) but sparse in practice.

**Gaps:**
- NIS spikes are detected but not stored as memories
- Test results don't flow back to update memory confidence
- Trading accuracy is logged but not fed to convergence records

**Action:** Store verification results:
```python
# After Kalshi trade resolves
record = ConvergenceRecord(
    hypothesis="Tight-band price will hit target",
    evidence=[kalshi_suggest_memory],
    result={"actual_price": 47.8, "target": 48.1, "hit": True},
    confidence=0.91,  # raised post-facto
    reasoner="kalshi-verifier"
)
# Update original suggest record: confidence 0.82 → 0.91
```

---

### Stage 6: Converge

**Definition:** Accumulate verified knowledge; detect and fix drift.

**Current Implementation:**
| Component | Status | Notes |
|-----------|--------|-------|
| Σ₀ collapse cert | ✓ Active | Detects when system drifts toward null manifold |
| Surprise spook | ✓ Active | NIS spike = model-reality mismatch detected |
| Anti-collapse op | ✓ Active | Σ₀⁻¹ re-excites along null modes |
| Learning | ✗ Missing | No mechanism to extract "pattern I should remember" |

**Gap:** Detect drift, but don't learn from it. Convergence records aren't prioritized or compiled into patterns.

**Action:** 
```python
# Periodically (daily):
high_confidence_records = memory.query(
    type=ConvergenceRecord,
    min_confidence=0.85,
    order_by="timestamp",
    limit=100
)
# Summarize: "In tight-band regime with compression < 2%, entry success is 87%"
# Store as a Pattern memory: a higher-level summary
```

---

## Migration Roadmap

### Phase 1: Structure (Week 1)
- [ ] Define `Memory`, `Task`, `Tool`, `ConvergenceRecord` classes
- [ ] Wrap existing JSONL append as `Memory.append()`
- [ ] Wrap existing routes as `Tool` objects

### Phase 2: Linkage (Week 2)
- [ ] Make all reasoners (dream-chat, router, kalshi-suggest, collapse-cert) output `ConvergenceRecord`
- [ ] Add `evidence: List[MemoryId]` to each record
- [ ] Implement basic `memory.query()` interface

### Phase 3: Feedback (Week 3)
- [ ] Store verification results as `ConvergenceRecord`
- [ ] Link actions back to hypotheses
- [ ] Update memory confidence post-verification

### Phase 4: Compilation (Week 4)
- [ ] Extract patterns from high-confidence records
- [ ] Store patterns as summary memories
- [ ] Use patterns in Reason stage (give reasoner access to patterns)

---

## Current Divergences (Architectural Debt)

| Component | Issue | Impact | Fix |
|-----------|-------|--------|-----|
| Dream mode | Separate reasoning strategy, not unified | No evidence linking | Rename → reasoning_params (exploration, verification_required) |
| Agent personas | 6 personas (lantern, blinkbug, keystone, etc.) | Each picks own reasoning | Unify under Convergence Core; persona = reasoning style parameter |
| Kalshi trading | Standalone tight-band algorithm | Not linked to broader reasoning | Treat as Tool; suggest becomes ConvergenceRecord |
| Discord bot | Separate message ingestion | Divergent input path | Route discord messages through same Observe → Memory pipeline |
| 3-Doors game | Standalone game with own state | Not part of loop | Move to Tool (game_step callable) |
| CSF format | Storage face of the 3¹² lattice (`src/csf/v07/`); same object as the Tesseract | No longer a leak — one Convergence-Core object | Keep; expose via Memory abstraction. See [`TESSERACT-CSF-SINGULARITY.md`](TESSERACT-CSF-SINGULARITY.md) |

---

## One-Sentence Alignment Test

**Can you explain this feature using only the six-stage loop and four core objects?**

- ✓ Kalshi trading: Observe (prices) → Remember (history) → Reason (suggest) → Act (place order) → Verify (resolve) → Converge (pattern extraction)
- ✓ Collapse detection: Observe (eigenvalues) → Remember (trajectory) → Reason (certificate) → Act (trigger anti-collapse) → Verify (proximity drops) → Converge (update stability bounds)
- ✗ Dream mode: "A separate reasoning strategy that... [cannot explain using only six stages and four objects]" → REFACTOR

---

**Status:** This document is the architecture specification. Use it to validate PR designs and guide refactoring.
