# Convergence Hooks: Σ₀ Loop Across All Steps

**Goal:** Make the six-stage loop (`Observe → Remember → Reason → Act → Verify → Converge`) the default path for *every* action in the system.

**Status:** ✅ Hooks framework in place. ✅ Git integration wired. ⏳ Full instrumentation in progress.

---

## Overview

Every significant action — commits, pushes, tests, API calls, tool execution — now passes through the Convergence loop, producing a ConvergenceRecord that captures:
- What triggered the action (Observe)
- What context was available (Remember)
- What decision was made (Reason)
- What was executed (Act)
- Whether it worked (Verify)
- What pattern to learn (Converge)

The loop is *non-intrusive*: hooks run after actions, never blocking them (exit code 0 always).

---

## Architecture

### Core: `src/convergence/hooks.py`

**HookContext** — State machine for a single loop cycle:
```python
context = HookContext(trigger="git-push", inputs={...})
context = manager.execute_stage(context, "observe")  # Capture
context = manager.execute_stage(context, "remember")  # Retrieve
context = manager.execute_stage(context, "reason")   # Analyze
context = manager.execute_stage(context, "act")      # Execute
context = manager.execute_stage(context, "verify")   # Validate
context = manager.execute_stage(context, "converge") # Record
record = context.to_convergence_record()
```

**ConvergenceHookManager** — Registry + executor:
- `register(stage, hook_fn)` — Wire a handler for a stage
- `execute_stage(context, stage)` — Run all handlers for a stage
- `run_loop(trigger, inputs, action_fn)` — Full loop in one call
- `metrics()` — Report loop health (grounding %, avg confidence)

**Built-in hooks** for all six stages:
```python
install_default_hooks(manager)
```

### Integration Points

#### 1. **Git Hooks** (`.git/hooks/`)

**convergence-loop-hook** — Python script that:
- Observes git event (commit hash, message, diff)
- Remembers related issues (#123)
- Reasons about what changed
- Verifies against safety gates (message length, slop words)
- Converges into a ConvergenceRecord
- Logs to `data/convergence-git-hooks.jsonl`

**post-commit-convergence** — Shell wrapper that invokes the Python hook.

**Called after:**
- Commits (analyzes change)
- Pushes (validates deployment)
- Merges (checks for conflicts)

#### 2. **Kernel Integration** (planned)

```python
kernel = Kernel()
kernel.hook_manager = ConvergenceHookManager(kernel)
kernel.hook_manager.register("observe", observe_kernel_input)
kernel.hook_manager.register("remember", kernel.query_memory)
kernel.hook_manager.register("reason", form_hypothesis)
kernel.hook_manager.register("act", kernel.run_tool)
kernel.hook_manager.register("verify", verify_tool_result)
kernel.hook_manager.register("converge", append_convergence_record)
```

Every Tool call → full loop cycle → ConvergenceRecord.

#### 3. **Test Harness Integration** (planned)

```python
@hook_manager.observe_hook()
def test_my_feature():
    # Automatically captures inputs, outputs, grounding
    return do_something()
```

Every test → ConvergenceRecord with grounding (test pass/fail).

#### 4. **API Route Integration** (planned)

```python
@hook_manager.track_stage("act", "API call to /api/dream/stream")
def api_route_handler(request):
    # Hook captures inputs, outputs, latency, errors
    return llm_response()
```

Every API call → ConvergenceRecord with response metadata.

---

## Six Stages in Detail

### 1. Observe
**Input:** What triggered this? (git event, test run, API call)

**Captures:**
- Trigger type (e.g., "git-commit", "test-run", "api-request")
- Input arguments / request body
- Input hash (for deduplication)

**Hook signature:**
```python
def my_observe_hook(context: HookContext) -> None:
    context.trigger = "my-action"
    context.inputs = {"key": "value"}
```

### 2. Remember
**Query:** What do we already know? (related memories, patterns)

**Retrieves:**
- Related past records (same trigger type, similar inputs)
- Relevant context (codebase state, user feedback)
- Known patterns (successful/failed prior runs)

**Hook signature:**
```python
def my_remember_hook(context: HookContext) -> None:
    context.retrieved_memories = ["mem-123", "mem-456"]
    context.relevant_context = {...}
```

### 3. Reason
**Decision:** What should we do? (hypothesis formation)

**Forms:**
- Hypothesis (what we expect to happen)
- Reasoning trace (decision steps)
- Plan (which actions to take)

**Hook signature:**
```python
def my_reason_hook(context: HookContext) -> None:
    context.hypothesis = "If we X, then Y should happen"
    context.reasoning_trace.append("Step 1: ...")
```

### 4. Act
**Execution:** Perform the action

**Executes:**
- Chosen action (e.g., tool call, test, deployment)
- Captures result in `actual_output`

**Hook signature:**
```python
def my_act_hook(context: HookContext) -> None:
    context.action = "deploy"
    context.action_args = {"env": "prod"}
```

### 5. Verify
**Validation:** Did we get what we expected?

**Checks:**
- Expected vs actual output
- Safety gates (no errors, no warnings)
- Grounding signals (test passed? market improved?)

**Hook signature:**
```python
def my_verify_hook(context: HookContext) -> None:
    context.expected_output = {...}
    context.verification_passed = (context.actual_output == context.expected_output)
    context.confidence = 0.8 if context.verification_passed else 0.2
```

### 6. Converge
**Learning:** Record the pattern + grounding

**Records:**
- Full ConvergenceRecord with evidence + confidence
- Grounding signals (which external sources confirmed this?)
- Confidence score (how sure are we?)

**Hook signature:**
```python
def my_converge_hook(context: HookContext) -> None:
    context.grounding_signals = ["test-pass", "deploy-ok"]
    context.source = "my-system"
    context.confidence = 0.9
```

---

## Usage

### Install Git Hooks

The hooks are already wired into `.git/hooks/`. After each commit:

```bash
$ git commit -m "my change"
[master abc1234] my change
[Convergence] 23 records, 87% grounded
```

The hook runs silently, logging to `data/convergence-git-hooks.jsonl`:

```json
{
  "id": "hook-abc12345",
  "hypothesis": "Commit changes code (src/main.py ...)",
  "evidence_ids": ["#123", "#456"],
  "result": {
    "action": "record-commit",
    "verified": true
  },
  "confidence": 0.8,
  "applied_evidence": ["git-verified"],
  "timestamp": "2026-06-25T00:51:00"
}
```

### Use in Custom Code

```python
from convergence.hooks import ConvergenceHookManager, install_default_hooks

# Initialize
manager = ConvergenceHookManager()
install_default_hooks(manager)

# Register custom hooks for your domain
def my_observe_hook(ctx):
    ctx.trigger = "my-action"

manager.register("observe", my_observe_hook)

# Run the loop
record = manager.run_loop(
    trigger="my-event",
    inputs={"data": "..."},
    action_fn=my_action
)

# Report
metrics = manager.metrics()
print(f"Grounded: {metrics['grounded_fraction']:.1%}")
```

### Decorator Pattern

Auto-instrument any function:

```python
manager = ConvergenceHookManager()

@manager.observe_hook()
def my_function(x, y):
    return x + y

result = my_function(1, 2)  # Automatically captures + records
```

---

## Grounding & Collapse Prevention

From **SIGMA0-COLLAPSE-CERTIFICATE.md**:

> A system that optimizes against its own outputs without external anchor collapses onto a frozen "42-state" or diverges.

**Convergence hooks prevent this by:**

1. **External grounding** — Every record cites sources (test pass, market data, user feedback)
2. **Confidence capping** — High-confidence claims must have strong grounding signals
3. **Trace retention** — Full reasoning trace for audit + learning

**Example: Unsafe Record (No Grounding)**
```json
{
  "hypothesis": "Algorithm is better",
  "confidence": 0.95,
  "grounding_signals": [],  # ← PROBLEM: No external evidence!
  "applied_evidence": [],
}
```

**Safe Record (Grounded)**
```json
{
  "hypothesis": "Algorithm is better",
  "confidence": 0.95,
  "grounding_signals": ["test-pass:98%", "benchmark:+15%"],  # ← External anchors
  "applied_evidence": ["test_suite_123", "benchmark_456"],
  "source": "evaluation-harness"
}
```

---

## Metrics & Observability

### Hook Manager Metrics

```python
manager.metrics()
# Returns:
{
    "total_records": 42,
    "average_confidence": 0.78,
    "grounded_fraction": 0.88,  # % of records with grounding signals
    "grounded_count": 37,
    "ungrounded_count": 5
}
```

### Log Files

- **`data/convergence-git-hooks.jsonl`** — All git hook records (append-only)
- **`data/convergence-test-hooks.jsonl`** — All test records (when test hooks wired)
- **`data/convergence-api-hooks.jsonl`** — All API records (when API hooks wired)

Query with:
```bash
# Count grounded records
grep "grounding_signals" data/convergence-git-hooks.jsonl | wc -l

# Average confidence
jq '.confidence' data/convergence-git-hooks.jsonl | python -m statistics
```

### Dashboard (Planned)

Live monitoring at `/api/convergence/hooks/metrics`:
```json
{
  "total_records": 1247,
  "average_confidence": 0.82,
  "grounded_fraction": 0.91,
  "recent_ungrounded": [
    {
      "id": "hook-xyz",
      "trigger": "deploy-prod",
      "reason": "No test coverage"
    }
  ]
}
```

---

## Troubleshooting

### Hook doesn't run after commit

**Check:**
1. `.git/hooks/post-commit-convergence` exists and is executable:
   ```bash
   ls -l .git/hooks/post-commit-convergence
   ```

2. Python 3 is installed:
   ```bash
   python3 --version
   ```

3. `src/convergence/hooks.py` exists:
   ```bash
   ls -l src/convergence/hooks.py
   ```

**Debug:**
```bash
# Run hook manually
python3 .git/hooks/convergence-loop-hook post-commit HEAD

# Check logs
tail -50 data/convergence-git-hooks.jsonl
```

### Records not appearing in log

**Check:**
1. `data/` directory exists:
   ```bash
   mkdir -p data
   ```

2. Permissions allow writing:
   ```bash
   touch data/convergence-git-hooks.jsonl
   ```

3. No Python errors in `.git/hooks/convergence-loop-hook` output

### Ungrounded records appearing

**Why:** Commit message is too short, or doesn't cite related issues.

**Fix:** Include issue references in commit messages:
```bash
git commit -m "Fix bug #123: implement feature #456"
```

The hook will parse `#123`, `#456` as grounding signals (related context).

---

## Next Steps

1. ✅ Hook framework (`src/convergence/hooks.py`)
2. ✅ Git integration (`.git/hooks/convergence-loop-hook`)
3. ⏳ Kernel integration (wire hook manager into Kernel)
4. ⏳ Test harness integration (@hook_manager decorators)
5. ⏳ API route integration (track all HTTP endpoints)
6. ⏳ Dashboard (live metrics + ungrounded record alerts)
7. ⏳ Collapse detection (monitor Σ₀ conditions via hooks)
8. ⏳ Anti-collapse gates (Σ₀⁻¹ re-excitation on high proximity)

---

## References

- **[CONVERGANCE-SIGMA0-BRIEFING.md](CONVERGANCE-SIGMA0-BRIEFING.md)** — Architecture, Convergence 12 components
- **[SIGMA0-COLLAPSE-CERTIFICATE.md](SIGMA0-COLLAPSE-CERTIFICATE.md)** — Mathematical foundation, safety mechanism
- **[src/convergence/hooks.py](../src/convergence/hooks.py)** — Implementation
- **`.git/hooks/convergence-loop-hook`** — Git hook

**Status:** Foundation solid. Framework ready. Next: broad instrumentation.
