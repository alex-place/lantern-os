# ADR-0021: Serving substrate — retain the Ouro/Σ₀ custom transformers loop; reject an engine port; defer a base-model swap

- Status: Accepted
- Date: 2026-07-04
- Deciders: Alex Place (approval required per ADR-0001 gate)
- approved-by: Alex Place (2026-07-04)
- Loop stage: Act (model execution) — with Verify/Remember hooks the substrate must preserve

## Context

We serve our own transformer locally: `scripts/ouro_serve.py` runs `ByteDance/Ouro-1.4B`
(a weight-tied recurrent "LoopLM" with a trained early-exit "Q-exit") **in-process** via
HuggingFace `transformers`, emulating the Ollama wire protocol on `:11434`
([SERVING-ARCHITECTURE-2026.md](../SERVING-ARCHITECTURE-2026.md); FAST cached mode default,
DEEP native Q-exit opt-in ~1 s/token). The K1 spec already fixes the honest baseline:
Ouro-1.4B scores **pass@1 = 0.1 on HumanEval at ~284 s/problem** — a weak-but-interchangeable
kernel, not a strong model ([SIGMA0-K1-KERNEL-SPEC.md §0](../SIGMA0-K1-KERNEL-SPEC.md)).

The question forcing this ADR: as we invest further in serving, do we (a) port to a
production engine (vLLM/SGLang/llama.cpp/TGI), (b) swap the base model, or (c) keep the
custom loop? A web-grounded SOTA sweep (mid-2026, 4 lenses, adversarially verified — see
[research memo](../research/2026-07-04-serving-design-sota.md)) answers it. All claims below
are **VERIFIED** (an agent opened the cited source).

**Serving stacks.** No production engine serves adaptive-depth/looped models natively in
mid-2026. vLLM is the *only* stack with Ouro upstream (`ouro.py`, PR #27794) — but it runs a
**fixed** `for current_ut in range(total_ut_steps)` and instantiates an `early_exit_gate` it
**never calls**; the Ouro model card confirms vLLM "will always execute the full number of
total_ut_steps," and an open vLLM issue (#37668, Mar 2026) confirms adaptive exit is still
unimplemented. TGI is **archived** (Mar 2026). TensorRT-LLM **removed Windows** (v0.19.0).
llama.cpp/ExLlamaV3 have **zero** Ouro architecture support. Every adaptive-depth model in
the wild (Ouro, Huginn) is served by a custom `transformers` python loop.

**White-box hooks we require.** Mid-layer hidden states (for the ADR-0017 surprise/probe
monitor) are a first-class capability of raw `transformers` (`output_hidden_states` / forward
hooks) and at best a buggy afterthought in engines: vLLM has **no official** hidden-state API
(RFC #33118 closed Jan 2026); SGLang's `return_hidden_states` is last-layer-only with batching
bugs. Mid-2026 SOTA hallucination detection is a linear probe on a **mid-layer** hidden state
(AUROC 0.90–1.00, surviving 4-bit) — exactly the signal an engine won't expose.

**Model landscape.** Ouro-1.4B is no longer the strongest small base — Qwen3.5-4B (Mar 2026,
Apache-2.0, Intelligence Index 27) and Gemma 4 E4B (Apr 2026) both fit the 3070 and moved a
generation past it — but Ouro remains the **only** production-grade open model with trained
latent adaptive depth, and its ecosystem is frozen (no Ouro-2, zero community finetunes/GGUFs
8 months on; official repo 404).

## Decision

**Retain the custom in-process `transformers` serving loop as the Ouro/Σ₀ substrate.** Do
**not** port Ouro to a serving engine. The custom loop is not a stopgap — it is the
state-of-practice for this model class, and the only path that preserves the two things we
actually need (adaptive Q-exit depth **and** mid-layer hidden states) on a single-user box.

Effort goes **inside the loop**, not into a migration:
1. **Speed (Act)** — decode-time KV reuse (last-step/averaged; Ouro paper: ~4× KV cut,
   near-identical quality), warm-start from the prior token's final state (Huginn), cyclic
   KV budget, and self-speculative draft-shallow/verify-deep (all paper-verified, none in any
   engine). Each ships only with a no-regression check vs. a recorded baseline.
2. **Monitoring (Verify)** — a forward hook on a **mid** layer + a linear probe feeding
   `runCanaries()`/ADR-0017, extending the existing canary rather than adding a subsystem.

**Cache fix (landed + verified with this ADR):** `scripts/ouro_compat.py` +
`tests/test_ouro_compat.py` (9 pass). **Correction to this ADR's first draft:** the "pin
`transformers<4.56`" advice was *wrong* — reality contradicted it. Measured 2026-07-04:
Ouro's current remote code (rev `3aaa2224`) assigns to `key_cache`/`value_cache`, which are
**read-only properties on transformers ≥ 4.54**, so `generate()` raises `property has no
setter`. **No stock version fits** — `< 4.54` lacks Ouro's other imports (`TransformersKwargs`,
`check_model_inputs`, `GenericForQuestionAnswering`). The real fix is a runtime monkeypatch,
`patch_universal_transformer_cache()` (effect-equivalent to Antizana/ouro-cache-fix), applied
by `ouro_serve.py` after load, on transformers **4.55.0** (the model config's own version).
Verified end-to-end: Ouro-1.4B-Thinking loads (25.9 s warm, 2.87 GB VRAM on the RTX 3070) and
generates coherently — "The capital of France is" → " Paris." Environment recovery is scripted
in `scripts/rebuild-train-venv.ps1` (the GPU venv + HF cache had been wiped by a D:-drive
cleanup, which is why the model "used to load" and had stopped).

**Defer a base-model swap.** Add **Qwen3.5-4B** to `local-model-registry.js` as a future
*capability* node (served via llama.cpp/GGUF, whose logprobs cover FLARE-style surprise
gating), keeping the model-interchangeability rule intact. Ouro stays the latent-adaptive-depth
/ monitoring-research lane. This is deferred, not adopted — no code lands for it here.

## Consequences

**Accept:**
- DEEP mode's ~1 s/token **cannot** be fixed by a runtime swap — no optimized engine exists
  or is coming for Ouro. Speed gains must come from the in-loop tricks above, whose wall-clock
  payoff is **unmeasured** (the papers publish none) — a HEURISTIC 2–4× hope, to be measured.
- We own maintenance of the custom loop and the runtime cache patch (a transformers version
  pin does *not* work — see the cache-fix note above) indefinitely.
- We forgo batching/throughput — acceptable: the target is single-user local latency.

**Gain:**
- Adaptive Q-exit depth and mid-layer hidden states stay available — the substrate can host
  ADR-0017 and the STARS-style loop-Jacobian measurement (below) that engines structurally block.
- No WSL2 dependency on a fragile 12 GB-RAM Windows box (vLLM/SGLang are Linux-first).

**Verify follow-up (not claimed done here — GPU-gated):** the certificate's headline
ρ = 1.064 "loop is non-contracting" number is now annotated as unreliable (fragile
unregularized fit; 4 text-surface features, not model states — see
[SIGMA0-COLLAPSE-CERTIFICATE.md §6](../SIGMA0-COLLAPSE-CERTIFICATE.md) and
`experiments/rho_controls.py`). Serving our own transformer lets us fit the **real** latent
loop Jacobian via the existing `StateABIShim`, with the controls (ridge/residual/non-normality)
from the debunk — the measurement STARS (ICML 2026) says actually matters for looped LMs.

## Alternatives considered

- **Port Ouro to vLLM** — rejected: forfeits adaptive depth (fixed 4-loop, model-card-confirmed),
  no hidden-state API, WSL2 on a fragile box. Buys throughput we don't need.
- **Port `ouro.py` to SGLang** — rejected for now: SGLang has the best monitoring surface
  (`return_hidden_states`, mature S-LoRA) but no Ouro model (documented port is moderate effort),
  and still fixed-depth. Revisit only if multi-adapter serving becomes the bottleneck.
- **Swap base to Qwen3.5-4B / Gemma 4 E4B now** — rejected as the *primary* model: their
  test-time compute is token-space CoT (very token-hungry → long local wall-clock, the exact
  problem we have), and both lose latent adaptive depth. Retained as a **deferred** registry node.
- **Distillation / retraining Ouro for speed** — out of scope: North Star principle 5, and
  fenced by ADR-0010 (deferred last-resort, adapter-only, operator-gated).

## Evidence

Web-grounded sweep + adversarial verify (933k tokens, 180 tool calls, all serving-stack claims
double-fetched, 0 refuted): [research memo](../research/2026-07-04-serving-design-sota.md).
Primary sources: vLLM `ouro.py` (PR #27794), Ouro card (huggingface.co/ByteDance/Ouro-1.4B),
vLLM #37668 / RFC #33118, SGLang `return_hidden_states`, Qwen3.5 (artificialanalysis.ai),
arXiv 2606.02628 (mid-layer probe AUROC), Huginn (arXiv 2502.05171), STARS (arXiv 2605.26733).
Local anchors: `scripts/ouro_serve.py`, `SIGMA0-K1-KERNEL-SPEC.md §0/§1`.
