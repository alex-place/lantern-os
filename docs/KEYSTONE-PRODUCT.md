# Keystone Chat — sustainable LLM product plan

**Thesis:** model *performance is the product*. So performance must be **measured on
every change**, the **fast path must be the default**, and the model must stay
**interchangeable** (per the Convergence North Star — the Core never assumes a
specific LLM). This doc is the operating contract for that.

## Serving architecture (decided 2026-06-18)

Two modes behind one Ollama-compatible endpoint (`scripts/ouro_serve.py`, `:11434`):

| Mode | How | When | Cost |
|---|---|---|---|
| **Fast (default)** | Ouro stock `generate()` + `UniversalTransformerCache`, repetition penalty + no-repeat-ngram | every chat turn | ~cache-speed |
| **Deep (opt-in `OURO_NATIVE=1`)** | native Σ₀ adaptive Q-exit loop (`src/sigma0/loop_lm.py`), no-cache | hard reasoning only | ~1 s/token |

Rationale: the native Q-exit loop is a real research result (depth adapts to `q`:
2.58→4.0 /4) but is **no-cache and ~1 s/token** — unusable as a chat default. It is
kept as a *deep* mode, not deleted. The product ships the cached path.

**The #1 product blocker** = make the *deep* mode cache-aware by wiring Ouro's
`UniversalTransformerCache` into `loop_lm.generate` (today it re-runs the prefix
per token). Until then, deep mode is capped (`OURO_NATIVE_MAX`) and opt-in.

## Performance is measured, not asserted

`scripts/eval_keystone.py` is the standing benchmark. It grades **any** backend that
speaks the Ollama API against a golden set (`data/eval/sigma0-prompts.jsonl`) on
**accuracy + latency + tok/s** and appends to `data/eval/leaderboard.jsonl`. Run it
on every serving change; a change that drops accuracy or speed is a regression.

- Model-agnostic by design → satisfies "models are interchangeable."
- `scripts/blind_study.py` is the A/B arm (native vs stock, double-blind) for
  research questions ("does the adaptive loop earn its latency?").

## Quality (decode)

Small-model degeneration (`✅✅✅…`, template leak) is fixed at decode:
`OURO_REP_PENALTY` (1.3), `OURO_NO_REPEAT_NGRAM` (3), optional sampling
(`OURO_SAMPLE=1`). The Σ₀ LoRA's training template (`### Response:` markers) should
be cleaned in the dataset next pass so it stops leaking into replies.

## Measured baseline (2026-06-18, RTX 3070 8GB)

Leaderboard rows (cached path, Σ₀ adapter, 48-tok cap):

| label | accuracy | avg latency | notes |
|---|---|---|---|
| ouro-fast | **80%** (8/10) | 65.8 s | unmerged LoRA, eager attn |
| **ouro-fast-merged-sdpa** | **80%** (8/10) | **23.7 s** | `OURO_MERGE=1 OURO_ATTN=sdpa` — **~2.8× faster, recommended** |

Decode degeneration is **fixed** (coherent replies, no `✅✅✅`). The benchmark then
surfaced that the cached path was bottlenecked on **per-token compute** (model fully on
GPU, ~6 GB, no offload): Ouro's **4× weight-tied recurrence** × **unmerged LoRA** ×
eager attention. **Merging the LoRA + SDPA attention cut avg latency 65.8 s → 23.7 s at
equal accuracy** — so the recommended serve config is `OURO_MERGE=1 OURO_ATTN=sdpa`.
Persistent misses were #5 (multi-step arithmetic) and #6 (primary colors → answered
RGB) — small-model reasoning limits, addressed by the roadmap (bigger base / cleaner tune).

**Recommended serve command:**
```
OURO_MODEL=ByteDance/Ouro-1.4B OURO_ADAPTER=<adapter> OURO_MERGE=1 OURO_ATTN=sdpa \
  python scripts/ouro_serve.py
```

## Roadmap (highest-leverage first — speed is now the gating issue)

1. **Per-token speed (the product gate).** (a) **merge the LoRA** ✅ done, (b) **SDPA
   attention** ✅ done — together ~2.8× (65.8→23.7 s). Remaining: (c) **fewer
   `total_ut_steps`** (speed↔quality tradeoff), (d) a faster **runtime** (vLLM/TGI —
   note llama.cpp can't run the looped arch). 23.7 s/prompt is better but still not
   interactive; (c)/(d) are the next pass.
2. **Cache the deep loop** — `UniversalTransformerCache` in `loop_lm.generate` (today
   it re-runs the prefix per token); makes deep mode usable once (1) lands.
3. **Bigger base only when it pays** — bench Ouro-2.6B/-Thinking vs 1.4B before VRAM spend.
4. **Clean the Σ₀ training set** — strip `### Response:` template artifacts; retrain; re-bench.
5. **Grow the golden set** — project-grounded + reasoning prompts, not just trivia.
6. **Route by difficulty** — Keystone picks fast vs deep per query (Convergence Reason
   stage), logged to the leaderboard for continuous tuning.

## Guardrails

- Fast path stays the default; deep mode never silently becomes the default.
- No serving change merges without a fresh `eval_keystone` row.
- Weights/adapters stay off-repo (D:); only code + the leaderboard are versioned.
