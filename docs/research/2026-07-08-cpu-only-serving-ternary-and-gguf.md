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
