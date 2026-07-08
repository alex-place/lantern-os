# CPU-only serving for the local model — grounded status + the two real routes

**Status:** Living · **Updated:** 2026-07-08 · Backs [ADR-0026](../adr/0026-ternary-serving-artifact-distillation-target.md)

Answers "did we get the model to run CPU-only yet?" with evidence, and pulls the
primary research (already ~30 ternary/CPU papers in the arXiv corpus + the PDFs
extracted here) into one actionable picture. Every claim is [claim · evidence · class].

## 1. Do we run CPU-only today? **No — and the current quant can't.** (MEASURED)

- The served quant is bitsandbytes `nf4` 4-bit (`scripts/ouro_serve.py:127` hard-sets `torch_dtype=float16, device_map="auto"`). **bnb 4-bit kernels require CUDA** → the thing we serve has no working CPU path. *(MEASURED — code + this session's runs were all CUDA/L4.)*
- `models/keystone-sigma0-plt/serve_keystone_plt.py:57` has a `… else "cpu"` fallback, but it's dead in practice: CPU can't use bnb-4bit, so it would load fp16 (~2.8 GB for the 1.4B) — and there is **no CPU run in any eval/convergence log.** *(MEASURED.)*

## 2. Two genuine software routes to CPU-only (the rest is hardware)

### Route A — GGUF + llama.cpp (**runnable NOW**, near-term answer)
Convert Ouro-1.4B to GGUF, run on CPU via llama.cpp. No training. *(MEASURED, arXiv:2601.14277 "Which Quantization Should I Use?" — 13 GGUF configs on Llama-3.1-8B, CPU prefill+decode throughput + perplexity.)*
- **Pick:** `Q4_K_M` ≈4.5 bpw (PPL 7.56 on their suite) is the size/quality knee; `Q6_K` ≈6.5 bpw is "high-quality, near-FP16" when accuracy matters; K-quants beat legacy `Q4_0/Q5_0` at equal size. *(MEASURED.)*
- For a **1.4B** student this is trivially CPU-servable (~0.8–1 GB at Q4_K_M) — fits this box's RAM even under pressure. This is the fastest path to a real yes.

### Route B — Ternary (1.58-bit) + bitnet.cpp (**ADR-0026's target**, needs a train step)
Distill an FP model to ternary {−1,0,1}, serve via `bitnet.cpp`. *(MEASURED, arXiv:2510.13998 "BitNet Distillation".)*
- **BitDistill** fine-tunes an off-the-shelf FP model (Qwen) to 1.58-bit: **up to 10× memory savings, 2.65× faster CPU inference, FP-comparable accuracy across sizes.** Pipeline = SubLN + MiniLM-style MHA distillation + a continual-pretrain warm-up (fixes the naive-QAT instability). Code: `github.com/microsoft/BitNet`. *(MEASURED.)*
- **Runnable reference TODAY:** BitNet b1.58 2B4T (arXiv:2504.12285) — **openly released ternary weights + GGUF + `bitnet.cpp` CPU runtime** (demo `aka.ms/bitnet-demo`), on par with FP open models of similar size at lower memory/energy/latency. We can run a real ternary LLM CPU-only *now* to validate the runtime, independent of our own distill. *(MEASURED — added to corpus this session.)*
- **Strategic payoff (why ADR-0026 chose this):** ternary is ~1.6 bpw vs Q4's ~4, so the same 8 GB box holds **2–2.5× more parameters** — it's how a 14B that won't fit at Q4 could fit. Ternary is *not* CPU-only anymore either: BitNet ships a W1.58A8 **CUDA** kernel too.

### Not a route: T-SAR (arXiv:2511.13676)
CPU-only ternary inference via **in-SIMD lookup tables** — but it's a **hardware co-design** (DATE 2026: SIMD-ALU modifications, +3.2% power/+1.4% area), **not runnable software.** Impressive (5.6–24.5× GEMM), irrelevant to shipping a CPU binary. Don't chase it. *(MEASURED.)*

## 3. Corpus coverage (Remember)

The daily arXiv harvest already holds the ternary/CPU frontier — 9/10 ADR-0026 cites plus uncited-but-relevant: **T-SAR (2511.13676)**, llama.cpp-quant-eval (2601.14277), Production LLM on Apple Silicon (2511.05502), Vec-LUT edge inference (2512.06443), TeLLMe v2 (2510.15926), Tequila (2509.23809), Signed-Zero Ternary (2508.05905). The one gap — **BitNet b1.58 2B4T (2504.12285)**, predating the 2025-07 backfill — was fetched and added (PDF + index) this session. Full-text extracts of the three decision papers: `data/research/ternary/extracts/`.

## 4. Reverse us in — concrete next actions

1. **Near-term yes (Route A):** GGUF-convert Ouro-1.4B → `Q4_K_M`, run under llama.cpp CPU-only, log tokens/sec on this box → the first real CPU-only serve. Small, no training, unblocks the "runs on any laptop" claim.
2. **Validate Route B runtime cheaply:** pull BitNet b1.58 2B4T + `bitnet.cpp`, run CPU-only → confirms our ternary serving substrate works before we spend a training run.
3. **Then ADR-0026's target:** BitDistill a bigger frontier base (or Ouro) to 1.58-bit, gated by the Σ_θ accept gate, served via bitnet.cpp — the 2–2.5×-params-per-GB win.

Bottom line: **not yet running CPU-only; the current 4-bit can't; GGUF is the fast real path and ternary/bitnet.cpp is the strategic one — both now grounded in downloaded primary sources.**

---

## 5. Reverse-engineered implementation ladder (full reports + on-box measurements, 2026-07-08 update)

§4 was written before validation. This section supersedes it where they conflict, working
**backwards from the papers' achieved results** (full texts in `data/research/ternary/extracts/`)
to what our stack concretely needs. Two §4 corrections first, both MEASURED/verified:

- **§4.1 "GGUF-convert Ouro → Q4_K_M" is REFUTED as written.** llama.cpp master (checked
  2026-07-08) has no `OuroForCausalLM`/`keystone_plt` arch; its `IQuestCoderForCausalLM` entry maps
  to the **plain LLAMA graph** (`conversion/__init__.py` L109) — no CPU runtime implements
  recurrent depth. Measured consequences (#2270): qwen-7B GGUF under ollama `num_gpu:0` = **2.09
  tok/s** (CPU fallback exists today); crystallized Ouro+grounding-v2 via transformers-CPU =
  correct code but **0.09 tok/s** (pure-Python looped forward). The loop, not quantization, is the
  CPU blocker.
- **However, the loop is unroll-clean** (`modeling_ouro.py:592-616`): steps are purely sequential,
  KV is per-(layer×step) (`max_cache_size = layers × ut_steps`, L546) with no cross-step attention
  and no embedding re-injection — i.e. Ouro-1.4B×R ≡ a 24R-layer transformer with weights repeating
  every 24 layers, plus sandwich norms (4/layer) and an inter-block final-norm. Exact llama.cpp
  support = a modest new arch (shared-tensor loop + extra norm), not a research problem. Fixed
  depth-3 matches how we already serve it.

### The ladder, cheapest-first

| Rung | What | Cost | Expected result (from the reports) |
|---|---|---|---|
| **0** | Run **BitNet-b1.58-2B-4T-gguf** (MIT, exists on HF) under **mainline llama.cpp/ollama** — `BitnetForCausalLM` arch + `TQ1_0/TQ2_0` quants are already in master — or `bitnet.cpp` for full speed | download ~1.2 GB; zero training | 2B4T tech report: **29 ms/token CPU (~34 tok/s), 0.4 GB non-embedding** — ~16× our measured qwen-CPU rate; accuracy ≈ Qwen2.5-1.5B class (avg 54.19 vs 55.23) |
| **1** | Gate rung 0 on **our** evals (6-task smoke, de-glossed honesty holdout) and register in `local-model-registry` as the **offline/CPU fallback brain** (`verified:false` until it wins) | one eval session | honest fit: 1.5B-class capability, not a coder-lead |
| **2** | **Crystallize onto a ternary base** — open question: `bitnet.cpp` is **inference-only** (repo verified); BitDistill training code availability must be confirmed; TII's **Falcon-E** family (1B–3B ternary, bitnet.cpp-supported) ships a fine-tuning story worth testing first | small experiment | if LoRA/QAT-SFT on ternary works → our verified-trace corpus rides on a CPU-fast base |
| **3** | **ADR-0026 proper**: BitDistill our llama-family student → 1.58-bit. Full recipe from the paper: Stage-1 SubLN insert (cheap) → **Stage-2 continue-pretrain on 10B FALCON tokens** (the cost gate: ≈weeks on one L4 → needs a multi-GPU cloud burst, ~8×H100-day class) → Stage-3 logits+MiniLM-attention distill FT (seq 512, cheap). Validated at 0.6B/1.7B/4B on Qwen3; skipping Stage-2 (BitNet-SFT) degrades with scale — don't skip | the real training run | FP-comparable accuracy, **10× memory, 2.65× CPU** vs FP16 |
| **L** *(parallel)* | **llama.cpp `ouro` arch** (unrolled shared-tensor graph): makes the looped Σ₀ line + every crystallized adapter first-class in ollama, CPU **and** GPU | days of C++, upstreamable | est. 2–4 tok/s CPU at Q4 (5.6B-effective; qwen-7B measured 2.09) — ~25–40× over transformers-CPU |

### Bottom line (updated)

A CPU-only *artifact* now exists off-the-shelf (rung 0) — the fastest honest path to "runs
CPU-only" is **adopt + gate**, not train. Our *own* models reach CPU either via the ouro-arch
unroll (rung L, exact) or by making the next distill student llama-family ternary (rung 3, the
ADR-0026 target whose real cost gate is Stage-2's 10B tokens). GPU serving via the ADR's
ternary-kernel swap is unaffected; transformers-CPU remains proof-of-existence only (0.09 tok/s).
