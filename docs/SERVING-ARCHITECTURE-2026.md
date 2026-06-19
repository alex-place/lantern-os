# Lantern OS Serving Architecture 2026: Fast Default + Deep Research Mode

**Decision Date:** 2026-06-18  
**Status:** Implementation Complete (Phase 1)  
**Owner:** Lantern Core Team  

## Problem Statement

Previous serving approach produced degraded replies: 70–85 second latencies that degenerated into token loops (`✅✅✅`), blocking a sustainable product.

Two blockers existed:
1. **No-cache speed**: Every reply required full inference without KV caching
2. **Decode degeneration**: Missing anti-repetition parameters allowed token loops

**THE DECISION:** Make fast cached inference the product default. Keep native Σ₀ Q-exit loop as an opt-in research mode.

---

## Architecture

### Default: FAST MODE (Fast Cached Inference)

**When:** All requests unless `OURO_NATIVE=1` is set.

**What:**
- Uses cached KV inference (Ollama/Ouro `UniversalTransformerCache`)
- Anti-repetition decode parameters enabled by default
- Target latency: <2 seconds for dream chat
- Suitable for interactive UX, real-time feedback, production use

**Decode Parameters (FAST mode):**
```python
{
    "temperature": 0.7,
    "top_p": 0.95,
    "frequency_penalty": 0.5,      # OpenAI/Deepseek/Groq
    "repetition_penalty": 1.1,     # Ollama
    "repeat_last_n": 64,           # Ollama context window
}
```

**Rationale:**
- Fast KV cache prevents the "decode degeneration" problem
- Aggressive repetition penalties (top_p=0.95, freq_penalty=0.5) kill the `✅✅✅` loop
- 64-token context for repetition detection balances freshness vs. tone consistency

---

### Opt-In: DEEP MODE (Native Σ₀ Q-exit Loop)

**When:** `OURO_NATIVE=1` environment variable is set.

**What:**
- Adaptive depth via native Σ₀ Q-exit loop (grounded reasoning)
- No KV cache — full adaptive inference per query
- Higher latency acceptable (70–85 seconds for complex reasoning)
- Suitable for: architecture decisions, research, grant writing, core system design

**Decode Parameters (DEEP mode):**
```python
{
    "temperature": 0.7,
    "top_p": 0.98,                 # Slightly less aggressive
    "frequency_penalty": 0.2,      # Allow more repetition for grounding
    "repetition_penalty": 1.05,    # Ollama: softer penalty
    "repeat_last_n": 128,          # Ollama: wider context
}
```

**Rationale:**
- Adaptive loop may reference prior states — softer antirepetition allows this
- Higher top_p (0.98 vs 0.95) gives reasoning more token diversity
- 128-token context captures cross-turn grounding patterns

---

## Configuration

### Environment Variables

```bash
# Product default: fast cached inference
(unset OURO_NATIVE) → FAST mode

# Opt-in to deep research mode
OURO_NATIVE=1 → DEEP mode
```

### Detection (Code)

```python
from serving_modes import get_serving_mode, get_decode_params

mode = get_serving_mode()  # Returns FAST_MODE or DEEP_MODE
decode_params = get_decode_params(mode)
```

---

## Performance Baseline

Running on golden set (10 diverse prompts):

| Provider | Model | Mode | Latency | Repetition | Tokens | Cost |
|----------|-------|------|---------|-----------|--------|------|
| ollama | qwen2.5-coder | FAST | 450ms | 0.92 | 85 | $0.00 |
| ollama | qwen2.5-coder | DEEP | 75s | 0.89 | 320 | $0.00 |
| groq | llama-3.1-70b | FAST | 280ms | 0.94 | 110 | ~$0.00 |
| openai | gpt-4o-mini | FAST | 820ms | 0.96 | 92 | $0.003 |

(See `data/benchmarks/leaderboard.jsonl` for full historical data.)

---

## Measurement & Iteration

### Standing Benchmark

```bash
# Run benchmark on a single provider:model pair
python src/serving_benchmark.py --run ollama:qwen2.5-coder

# Summarize all runs
python src/serving_benchmark.py --summarize
```

**Golden set:**
- 10 diverse prompts (reasoning, creative, code, domain)
- Metrics: latency, tokens, repetition_ratio, cost

**Leaderboard location:** `data/benchmarks/leaderboard.jsonl`

Every production deploy appends a new benchmark run. Over time, this becomes a measurable performance history.

---

## Migration Path

### Phase 1: ✅ COMPLETE (2026-06-18)
- [x] Add anti-repetition decode params to all providers
- [x] Implement FAST/DEEP mode system
- [x] Create standing benchmark
- [x] Default to FAST (product-ready)

### Phase 2: Validation (Weeks of 2026-06-25)
- [ ] Run benchmark on all providers daily
- [ ] Measure reply quality (human + automated)
- [ ] Validate no regression in reasoning tasks
- [ ] Document FAST mode expectations (limits, constraints)

### Phase 3: Optimization (Weeks of 2026-07-02)
- [ ] Tune decode params per provider
- [ ] Explore lighter KV cache configs for DEEP mode
- [ ] Cache DEEP mode results for common research questions
- [ ] Consider hybrid mode: FAST with DEEP fallback for hard problems

### Phase 4: Research (Ongoing)
- [ ] Compare DEEP mode to other high-reasoning approaches (Claude Opus, etc.)
- [ ] Measure Σ₀ Q-exit effectiveness (grounding quality vs. latency)
- [ ] Publish results as case study

---

## Code Integration

### Updated Files

**`src/unified_agent_connector.py`**
- Integrated serving modes
- All provider streamers now respect mode-appropriate decode params

**`src/serving_modes.py`** (NEW)
- Mode definitions (FAST, DEEP)
- `get_serving_mode()`, `get_decode_params()`

**`src/serving_benchmark.py`** (NEW)
- Golden set runner
- Leaderboard tracking
- CLI: `--run provider:model`, `--summarize`

**`apps/lantern-garage/lib/unified-agent.js`** (TODO in Phase 2)
- Add `OURO_NATIVE` detection for Node.js side
- Route requests to correct inference path

---

## Success Criteria

✅ **FAST mode (product default):**
- Latency < 2s for 90% of dream chat requests
- No token loops (`✅✅✅` degeneration)
- Repetition ratio > 0.85 (unique words)
- Cost stable or decreasing

✅ **DEEP mode (research opt-in):**
- Grounded reasoning (Σ₀ loop validates claims)
- Latency 70–85s acceptable for complex decisions
- Repetition ratio > 0.80 (grounding may repeat concepts)
- Used successfully for ≥3 real architecture decisions

✅ **Benchmark sustainability:**
- Daily runs on CI (appendable leaderboard)
- Golden set results tracked for all changes
- Alert on regression (latency +20%, repetition -0.05)

---

## Backward Compatibility

- Existing code paths unchanged (no breaking changes)
- Default behavior is now FAST; opt-in to DEEP
- `unified-agent` Python interface: drop-in compatible
- Node.js callers: no changes needed (will use FAST by default)

---

## References

- **Σ₀ Framework:** `docs/CONVERGANCE-SIGMA0-BRIEFING.md`
- **Model Architecture:** `docs/research-canon.md`
- **Benchmark:** `src/serving_benchmark.py`
- **Serving Modes Config:** `src/serving_modes.py`
