---
author: Alex Place
created: 2026-06-18
updated: 2026-06-20
---

# Ouro / LoopLM — looped latent reasoning in Keystone OS

**Source:** *Scaling Latent Reasoning via Looped Language Models* (Ouro,
[arXiv:2510.25741](https://arxiv.org/abs/2510.25741)). PDF in repo:
[`docs/research-papers/ouro-looped-llm-2510.25741.pdf`](research-papers/ouro-looped-llm-2510.25741.pdf).

> **Grounding status (2026-06-19):** this doc is markdown, indexed by
> [`scripts/build_knowledge_index.py`](../scripts/build_knowledge_index.py) into
> `data/knowledge/index.jsonl` (it contributes 7 of the indexed sections), so the
> Knowledge Center can ground / near-route on it. A doc becomes grounded by being
> linked from `knowledgecenter.html` (the indexer scrapes `/repo/*.md` hrefs).
> **Re-run the indexer after editing** so the snapshot matches the live text.

## The idea (paper)
LoopLM builds reasoning into computation by **reusing weight-tied layers R times**
in latent space (a "third scaling axis": loop depth). Key mechanisms we borrow:
- **Adaptive depth + learned early-exit (Q-exit):** a gate emits per-step exit
  probabilities; exit at the first step where the cumulative `CDF(t) ≥ q`. `q`
  trades compute for accuracy.
- **Entropy-regularized depth** (uniform prior) prevents collapse to always-shallow/deep.
- **Deeper-is-better, with diminishing returns** — most inputs converge by mid-depth.

## How it's implemented here

### 1. Native latent loop on real Ouro weights (the real thing)
[`src/sigma0/loop_lm.py`](../src/sigma0/loop_lm.py) — `Sigma0LoopLM` is our
implementation of the paper's **Q-exit adaptive-depth policy**
(λ→survival→CDF→first-step-≥q), run on **Ouro's pretrained weight-tied block + exit
gate** (we do **not** pretrain a LoopLM — that needs 7.7T tokens). This activates the
adaptive inference the **stock Ouro checkpoint leaves off**: its `generate()` threads
no per-call exit threshold, so it runs **fixed full depth**. Our module reads the
per-step gates, applies Q-exit, and **reports the realized per-token loop depth**
(`mean_depth`); `generate()` returns `exit_reason: "adaptive_qexit"`. Defaults:
`q=0.5`, `max_new_tokens=200`, repetition penalty `1.3`.

- **Probe it:** `python -m sigma0.loop_lm` prints the realized mean depth — adaptive
  and **below** the 4 recurrent steps (`total_ut_steps`), i.e. not fixed-4. (This probe
  output is **not yet persisted** to an eval artifact, so treat the number as a live
  observation, not a benchmark.)
- **Trained on our data:** QLoRA fine-tune of Ouro-1.4B on the Σ₀ Claude-session set
  ([`scripts/train-qlora-ouro.py`](../scripts/train-qlora-ouro.py); 3 epochs; 4-bit
  nf4, LoRA r=16/α=32 over `all-linear`, lr 2e-4, seq 1024). The Ouro run's loss curve
  isn't written to a metrics file yet (the script logs to console only). Adapter loads
  via `Sigma0LoopLM.load(base, adapter=…)`.
- **Served without Ollama:** [`scripts/ouro_serve.py`](../scripts/ouro_serve.py) hosts
  it on the **Ollama HTTP API** (`/api/chat`, `/api/tags`, `/api/generate`) on port
  11434 as a drop-in (model `ouro:latest`), so the existing chat path works with **no
  Ollama binary**. `OURO_MODEL` defaults to `ByteDance/Ouro-1.4B-Thinking`; set
  `OURO_ADAPTER` for the Σ₀ tune.
- **Two serving modes:** the **default** path uses **fast cached generation** (Ouro's
  `UniversalTransformerCache`). The **native Σ₀ adaptive Q-exit loop** is an **opt-in
  "deep" mode** — `OURO_NATIVE=1` — and is intentionally **no-cache (~1 s/token)**, with
  tunables `OURO_Q` (0.5) and `OURO_NATIVE_MAX` (80). Decode-quality guards apply on both
  paths: `OURO_REP_PENALTY=1.3`, `OURO_NO_REPEAT_NGRAM=3`, greedy by default
  (`OURO_SAMPLE=1` to sample), and `OURO_UT_STEPS` overrides the recurrent-step count.
- Needs **transformers 4.57** (required by Ouro's custom modeling code; pinned only in
  the train script — there is no `transformers` entry in `requirements.txt`).

### 2. API-level re-prompt loop (legacy, provider-agnostic)
For the Ollama/Qwen path, we also approximate the loop by re-prompting:

- **[`lib/loop-reasoner.js`](../apps/lantern-garage/lib/loop-reasoner.js)** —
  `loopedReason()` runs the model up to `MAX_LOOPS` (4, = Ouro R4), feeding each prior
  answer back as a Coconut-style context prefix, and **exits via `cdfExit()`**:
  - `threshold_met` — confidence `≥ CDF_THRESHOLD` (0.85)
  - `converged` — `|Δconfidence| < CONVERGENCE_EPS` (0.04), the entropy-plateau analog
    (requires ≥ 2 loops)
  - `max_loops` — compute budget hit

  Confidence is **heuristic** — `extractConfidence()` parses a `Confidence:` field or
  estimates from structure. The module also exports a one-shot `singleReason()`
  (`exit_reason: "single_pass"`) and the three constants; callers may override
  `maxLoops`/`cdfThreshold` per call.
- **Wired into [`lib/stream-chat.js`](../apps/lantern-garage/lib/stream-chat.js)** — for
  `reasoning`/`coding` intents (and only when **not** Keystone-debug, **not** roleplay,
  and no explicit provider was picked), a looped pass runs on the **local Ollama model**
  and the `done` event carries **`loop_n` / `confidence` / `exit_reason`**. The
  **"Loop Depth (Σ₀)"** panel in
  [`dream-chat.html`](../apps/lantern-garage/public/dream-chat.html) renders them as
  `⟳ N loop(s) · X% conf · <exit_reason>`; the provider dropdown's **"Local Σ₀ Loop
  (Ouro)"** option is the user-facing entry. On error the pass falls through to normal
  streaming (non-fatal).

### Enable / tune
Both loops are **off by default** (extra latency vs quality).
```
LOOP_REASONER=1   # API re-prompt loop for reasoning/coding intents (lib/loop-reasoner.js)
OURO_NATIVE=1     # native Ouro adaptive Q-exit loop in ouro_serve.py (deep mode, ~1 s/tok)
```
Tune `lib/loop-reasoner.js`: `MAX_LOOPS`, `CDF_THRESHOLD`, `CONVERGENCE_EPS`. Tune the
native loop: `OURO_Q`, `OURO_NATIVE_MAX`, `OURO_UT_STEPS`. The `q` threshold is the same
compute/accuracy knob as the paper's Q-exit.

## Where it maps in the codebase
| Paper concept | Lantern |
|---|---|
| Recurrent steps R | Ouro `total_ut_steps` (native) · `MAX_LOOPS` (re-prompt) |
| Q-exit `CDF(t) ≥ q` | `qexit_step()` in `loop_lm.py` (native) · `cdfExit()` (re-prompt) |
| Realized adaptive depth | `mean_depth` (native) · "Loop Depth (Σ₀)" panel (`loop_n`/`confidence`/`exit_reason`) |
| Deeper-is-better, diminishing | early-exit at the first step with `CDF ≥ q` |
| Knowledge manipulation > capacity | small local model + KB grounding ([CSF spec §2.9](CSF-FORMAT-SPECIFICATION.md)) |

## Honest scope
- **Native loop (§1)** is real adaptive depth on Ouro's weight-tied checkpoint — but
  **inference-time only** (we don't pretrain), and the no-cache Q-exit path is slow
  (~1 s/token), so it's opt-in deep mode; the **default** served path is the fast cached one.
- **Re-prompt loop (§2)** is an **API-level approximation** — it refines by re-prompting
  a standard model, not shared-weight latent loops. Confidence and exit are heuristic on
  a small model.
- The Ouro run's **realized-depth and training-loss figures are not yet persisted** to
  eval/log artifacts — treat them as live `python -m sigma0.loop_lm` / console
  observations, not benchmarked results.

## Related
- [CSF-FORMAT-SPECIFICATION.md](CSF-FORMAT-SPECIFICATION.md) — §2.9 KB grounding index + near routing
- [LANTERN-SIGMA0-CODER.md](LANTERN-SIGMA0-CODER.md) — the Qwen-based local coder (distinct from the Ouro loop)
