# Serving design vs. mid-2026 SOTA — web-grounded research memo

**Date:** 2026-07-04
**Method:** 4 parallel web-research lenses (Fable-max agents) + an adversarial verify pass
that re-fetched every load-bearing serving-stack claim. 14 agents, 180 tool calls, ~933k
tokens. Every claim below carries a source URL an agent actually opened. Evidence class:
**VERIFIED** = source opened and quote-checked; **REPORTED** = search snippet only.
**Verify pass:** the 10 load-bearing serving-stack claims were independently re-fetched — **0
refuted**. (The other three lenses are researcher-VERIFIED but not double-checked; treated as
one confidence tier lower.)

**Backs:** [ADR-0021](../adr/0021-serving-substrate-retain-ouro-custom-loop.md).

**The two questions this answers:**
1. Keep Ouro-1.4B as the base, or swap? → **Both, in different lanes** (retain Ouro as the
   adaptive-depth lane; add Qwen3.5-4B as a deferred capability node).
2. What's the real bottleneck the design must solve? → **Not an engine port** — in-loop speed
   tricks + mid-layer monitoring hooks.

---

## Lens 1 — Serving stacks (can anything serve Ouro's custom looped arch?)

The field collapses fast for a custom weight-tied recurrent transformer with a learned
early-exit head, on one 8 GB card, single user:

| Stack | Ouro arch? | Adaptive depth? | Logprobs | Hidden states | Notes |
|---|---|---|---|---|---|
| **vLLM** | ✅ `ouro.py` (PR #27794) | ❌ fixed 4-loop, gate never called | ✅ full, incl. full-vocab prompt | ⚠️ file-drop only, 2 open bugs | Linux/WSL-only |
| **SGLang** | ❌ (port from vLLM, moderate) | ❌ | ✅ rich | ✅ inline `return_hidden_states` (last-layer, buggy) | best monitoring surface; mature S-LoRA |
| **llama.cpp** | ❌ zero Ouro code | ❌ | ✅ `n_probs` | ❌ final-layer embed only | best LoRA hot-swap; no arch |
| **ExLlamaV3** | ❌ whitelist-only | ❌ | — | ❌ | V2 archived |
| **TensorRT-LLM** | — | — | — | — | **removed Windows** (v0.19.0) |
| **TGI** | — | — | — | — | **archived** Mar 2026 |
| **ollama** | ❌ (llama.cpp) | ❌ | ✅ (v0.12.11) | ❌ | static LoRA only |

Key VERIFIED facts:
- vLLM `ouro.py` runs `for current_ut in range(self.total_ut_steps)` (default 4) and
  instantiates `early_exit_gate` that is **never called** in `forward()`. Class is
  `OuroForCausalLM(nn.Module, SupportsLoRA)`. — `raw.githubusercontent.com/vllm-project/vllm/main/vllm/model_executor/models/ouro.py` (re-fetched, confirmed)
- vLLM #37668 "Early Stopping for Ouro models" (2026-03-20, **open**) — a user asking how to
  add early exit, with a hand-rolled patch. Adaptive exit still unimplemented. — `github.com/vllm-project/vllm/issues/37668`
- TGI archived (last push 2026-03-21, final release v3.3.7). — `github.com/huggingface/text-generation-inference`
- TensorRT-LLM removed Windows at v0.19.0 (2025-05-09). — `github.com/NVIDIA/TensorRT-LLM/issues/11360`
- vLLM is Linux-only ("does not support Windows natively — use WSL"). RTX 3070 = CC 8.6, qualifies. — `docs.vllm.ai/.../installation/gpu.html`

**Speed reference points** (VERIFIED, extrapolation labeled): Llama-3.2-1B Q4 = **184 t/s** on
an RTX 3060 (localscore.ai/accelerator/43); a 3070 should exceed it; Ouro's 4× weight-reuse
loop → **~50–70 t/s fixed-depth** in a compiled stack ≈ ~50× the current ~1 s/token HF DEEP
mode. **But no compiled stack preserves Q-exit adaptive compute** — that exists only in the HF
`transformers` path.

## Lens 2 — Looped-model serving (does anyone serve adaptive depth?)

**No.** Every adaptive-depth path in the wild is a custom HF-transformers python loop.

- Ouro authors ship **only** custom `transformers` modeling code, pin `transformers<4.56`
  (rec ==4.54.1); community `Antizana/ouro-cache-fix` restores the KV cache on newer. Knobs:
  `total_ut_steps`=4, `early_exit_threshold`=1.0. — `huggingface.co/ByteDance/Ouro-1.4B`
- Ouro card states verbatim: served via vLLM, "the model will always execute the full number
  of `total_ut_steps`." Adaptive exit is HF-only.
- Ouro paper reports **zero** tokens/sec or latency numbers; its efficiency claims are
  parameter-efficiency. States vLLM/SGLang "provide fast rollouts via a fixed execution path,
  which breaks under LoopLM's variable-depth computation." KV: decode-time last-step/averaged
  reuse ≈ identical quality, **4× KV cut**. — `arxiv.org/html/2510.25741v2`
- Huginn (recurrent-depth) also runs a custom loop + bespoke `HuginnDynamicCache`; its official
  vLLM plugin README: "Everything token-level adaptive is unimplemented." — `huggingface.co/tomg-group-umd/huginn-0125`, `github.com/seal-rg/recurrent-pretraining/tree/main/vllm`
- Huginn paper (the reusable blueprint): zero-shot per-token exit on successive-step KL < 5e-4;
  **cyclic KV-cache sharing** (budget 4 ≈ lossless on MTBench); **native self-speculative
  decoding** ("states computed during drafting are reused when verifying"); warm-start saves
  1–2 iterations. — `arxiv.org/html/2502.05171`
- CALM (token-level early exit) has crossed into **zero** production engines 4 years on
  (REPORTED). LayerSkip is the only early-exit in a mainstream lib (HF `assistant_early_exit`,
  1.30–2.06× — but needs LayerSkip-trained checkpoints). — `huggingface.co/blog/layerskip`

**Implication:** the current dual-mode `transformers` script **is** state-of-practice for this
model class. An engine buys throughput a single-user box doesn't need, at the cost of the
adaptive depth and hidden states we do need.

## Lens 3 — Model landscape (is Ouro-1.4B still the right base?)

Ouro is no longer the strongest small base, but remains the **only** production-grade open
model with native latent adaptive depth; its ecosystem is frozen.

- **Qwen3.5** small dense (9B/4B/2B/0.8B), Mar 2 2026, Apache-2.0, 262K ctx. Intelligence
  Index: 9B=32, **4B=27**, 2B=16. 4-bit VRAM: 9B ~6 GB, **4B ~3 GB**. But test-time compute is
  token-space CoT (230–390M output tokens on the Index → long wall-clock). QLoRA "not
  recommended"; bf16 LoRA 4B = 10 GB (cloud-L4). Hybrid Gated-DeltaNet arch needs transformers
  v5. — `artificialanalysis.ai/articles/qwen3-5-small-models`, `unsloth.ai/docs/models/qwen3.5/fine-tune`
- **Gemma 4 E4B**, Apr 2026, Apache-2.0, 4.5B-eff/8B-total (PLE), ~4–5 GB Q4, configurable
  thinking + tool calling. No adaptive latent depth (PLE is a memory trick). LoRA ~17 GB. — `blog.google/.../gemma-4/`, `labellerr.com/blog/gemma-4-open-weight-ai-model-overview/`
- **Ouro frozen:** HF search (2026-07-04) — only ByteDance/Ouro-1.4B (+Thinking, 2.6B-Thinking),
  **no Ouro-2, zero community finetunes/adapters/GGUFs**; last modified 2026-01-18; no vLLM/GGUF
  tags → transformers-only permanently (so DEEP's ~1 s/token can't be runtime-swapped away, but
  transformers natively exposes logits + hidden states). — `huggingface.co/api/models?search=Ouro`
- **STARS** (arXiv 2605.26733, ICML 2026): looped-LM test-time depth scaling "peaks then
  collapses"; stabilizes with **Jacobian spectral-radius regularization** + random loop
  sampling. No weights released. — directly relevant to our collapse-certificate work.
- 8 GB tested ranking (May 2026): Qwen3-8B Q4 ~50 t/s > Gemma 4 4B > Phi-4-mini; **3070 beats
  4060 Ti at this size** on bandwidth. — `quantized.fyi/.../best-llm-models-for-8gb-vram-in-2026`

**Top-3 bases:** (1) Qwen3.5-4B capability lead (gives up latent depth; cloud-only LoRA); (2)
Gemma 4 E4B fallback; (3) keep Ouro-1.4B for latent-TTC + free hidden-state exposure.

## Lens 4 — White-box monitoring (surprise/probe hallucination gating)

- **SOTA AUROC from internal signals:** mid-layer linear probes dominate. **0.904–1.000** from
  a single mid-layer probe on 4-bit 7–8B models (arXiv 2606.02628; best layers 13–18/32, signal
  ~linear, survives NF4); up to 0.9855 multi-layer (MultiHaluDet, arXiv 2605.24919). Most
  deployment-realistic: **AUC 0.90 token-level probe vs 0.71 semantic entropy** on long-form
  (Nanda group, arXiv 2509.03531). Rule of thumb: **logit/surprise/semantic-entropy plateau
  ~0.70–0.80** (matches our own measured 0.76–0.81); **hidden-state probes reach 0.85–0.95+**,
  peaking at **mid** layers.
- **Detect-then-revise IS published:** FLARE (logprob-gated retrieve+regenerate, arXiv
  2305.06983), Lookback Lens (probe-guided decoding, −9.6% halluc on XSum, 7B→13B transfer,
  arXiv 2407.07071), causal steering along a probe direction (arXiv 2507.23221). **Not yet
  standard:** a packaged probe-gated grounded-revision loop in any serving stack. → **ADR-0017
  is ahead of tooling, not behind literature.**
- **Minimum stack requirements:** (1) per-token logprobs — vLLM/llama.cpp/TGI all satisfy →
  surprise gating is stack-agnostic; (2) **mid-layer hidden states** — only HF `transformers`
  (`output_hidden_states`/hooks) out of the box; vLLM none (RFC #33118 closed), llama.cpp
  final-layer only; (3) sentence-boundary regenerate — any streaming stack. Cost: monitoring ≈
  one matmul/token (µs); latency paid only when intervention fires.
- **Caveat:** probe weights are per-model (retrain a logistic head per swap — cheap); partial
  cross-model transfer shown (Lookback Lens, observer-probe).

---

## Honest corrections this research forced

1. **"Detect-then-revise" is not our least-derivative idea.** FLARE (2023) is exactly
   logprob-triggered retrieve-and-regenerate. ADR-0017's daylight is narrower: *probe-gated*
   grounded revision **shipped in a local serving loop**.
2. **STARS partially rehabilitates the collapse-certificate direction** — it uses Jacobian
   spectral-radius regularization on the *real* looped LM. Our ρ=1.064 debunk stands (that fit
   was text-features + numerics); serving our own transformer lets us measure the true loop
   Jacobian via `StateABIShim`.
3. **Ops:** HF hub fetches from this machine 401 (stale local credential) — fix before any pull.

## Net design shape

Keep the dual-mode custom `transformers` loop as the Ouro substrate. Spend effort on
Huginn-style in-loop KV tricks + a mid-layer probe, **not** an engine port. Add Qwen3.5-4B via
llama.cpp/GGUF as the registry's deferred capability node.
