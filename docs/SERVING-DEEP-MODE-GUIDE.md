# When to use FAST vs DEEP mode

> Status: **partial / decision-guide only.** This guide is grounded in the code and
> the architecture doc. The empirical case study #731 asks for — a ≥5-question
> grounding study and a head-to-head vs Claude Opus — is **not yet run**; those
> numbers are marked `TODO` below because they require the native Q-exit loop on a
> GPU plus provider API keys and multi-day benchmark ops. Nothing here is invented.

Related: [#731], [#729], [#730], [PR #723]. Source of truth for behavior:
[`src/serving_modes.py`](../src/serving_modes.py),
[`docs/SERVING-ARCHITECTURE-2026.md`](SERVING-ARCHITECTURE-2026.md).

## The two modes

| | FAST (default) | DEEP (opt-in) |
|---|---|---|
| Trigger | default — no env var | `OURO_NATIVE=1` |
| Reasoning | shallow, cached KV | adaptive — native Σ₀ Q-exit loop |
| Latency target | `< 2000 ms` (`FAST_MODE.max_latency_ms`) | `≤ 120000 ms`, ~70–85s typical (`DEEP_MODE.max_latency_ms`) |
| Decode params | `top_p 0.95, frequency_penalty 0.5, repetition_penalty 1.1, repeat_last_n 64` | `top_p 0.98, frequency_penalty 0.2, repetition_penalty 1.05, repeat_last_n 128` |

(Values above are read directly from `get_decode_params()` in `src/serving_modes.py`
and are locked by `tests/test_serving_modes.py`.)

## How to choose

**Use FAST (the default) for:**
- Interactive dream-chat / Keystone Desk replies — anything a human is waiting on.
- UX feedback loops, real-time systems, high-volume requests.
- Tasks where a sub-2s response matters more than maximal reasoning depth.

**Opt into DEEP (`OURO_NATIVE=1`, restart the server) for:**
- Architecture decisions, grant writing, core system design.
- Questions where grounded, multi-step reasoning is worth ~70–85s of latency.
- Offline / batch research where latency is not user-facing.

Mode is **immutable per server session** — switching requires a restart
(`get_serving_mode()` reads `OURO_NATIVE` once at request time, but the serving
stack is configured at boot).

## Honest implementation status (important)

There are **two** DEEP paths, and they are not the same depth of "deep":

1. **Connector DEEP path** (`src/unified_agent_connector.py`): setting `OURO_NATIVE=1`
   currently only swaps the **decode parameters** (the DEEP column above) for the
   API providers (ollama/openai/deepseek/groq). It does **not** run a native
   reasoning loop — `DEEP_MODE.reasoning_depth = "adaptive"` is metadata the
   connector does not yet consume.
2. **Native Σ₀ Q-exit loop** (`src/sigma0/loop_lm.py`): the genuine adaptive-depth
   loop loads `ByteDance/Ouro-1.4B` with `device_map="auto"` — i.e. it needs a GPU.
   This is the source of the 70–85s latency and the real "deep reasoning" claim.

So today, on the API connector path, DEEP ≈ FAST-with-gentler-decode. The native
loop is the part that delivers the architecture doc's reasoning claims.

## What is NOT yet measured (#731 acceptance — TODO)

These require the native loop on a GPU + provider keys + multi-day runs, so they
are deliberately left open rather than guessed:

- [ ] Grounding quality: fraction of claims grounded in code/docs, FAST vs DEEP. **TODO**
- [ ] ≥5 research questions benchmarked on both modes. **TODO**
- [ ] Latency-vs-quality trade-off curve (is 70–85s worth it?). **TODO**
- [ ] Head-to-head vs Claude Opus reasoning. **TODO (needs API access)**
- [ ] Populate `data/benchmarks/leaderboard.jsonl` via the daily cron (#730). **pending runs**

The illustrative numbers in `docs/SERVING-ARCHITECTURE-2026.md` (e.g. ollama
qwen2.5-coder DEEP ≈ 75s) are targets/examples from that doc, **not** results of a
controlled study; treat them as expectations until the leaderboard has real runs.

## How to benchmark (when a GPU/keys are available)

```bash
# FAST (default)
python src/serving_benchmark.py --run ollama:qwen2.5-coder

# DEEP (opt-in)
OURO_NATIVE=1 python src/serving_benchmark.py --run ollama:qwen2.5-coder

# Summarize the growing leaderboard
python src/serving_benchmark.py --summarize
```

The daily CI cron (`.github/workflows/serving-benchmark.yml`, #730) runs the
benchmark when a provider key secret is configured and always publishes the
leaderboard as an artifact.
