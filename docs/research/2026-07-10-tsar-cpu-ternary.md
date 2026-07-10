# CPU-only ternary serving: runs, but slow — T-SAR needs hardware we don't have (honest NO-GO for speed)

**Date:** 2026-07-10 · **Evidence class:** MEASURED · **Loop stage:** Act (local-first serving)
**Artifacts:** `experiments/tsar_cpu_ternary.py`, `data/sigma0/tsar_cpu_report.json`
**Issue:** #2207 · **Re:** T-SAR, arXiv:2511.13676

## The key scope fact

T-SAR is a **hardware co-design** (accepted to **DATE 2026**, a hardware-design conference): it
reorganizes CPU **SIMD ALUs** to build in-register ternary lookup tables ("3.2% power / 1.4% area
overhead in SIMD units"). It is **not a software library and cannot run on a stock CPU** — its
1.1–86× speedups require the modified silicon. So we cannot reproduce T-SAR here. What we *can* answer
honestly is the issue's actual acceptance: on a **stock** CPU, is CPU-only ternary serving viable, and
how fast?

## Results (this box's CPU vs the RTX 4080)

**End-to-end tokens/s (Qwen2.5-Coder-1.5B, greedy, 48 new tokens):**

| path | tokens/s | note |
|---|---|---|
| CPU (fp32) | **2.95** | 48 toks in 16.3 s — runs, but slow |
| GPU (fp16) | 16.21 | ~**6× faster** |

**Software ternary GEMV vs fp32 BLAS (numpy, stock CPU):**

| matvec size | fp32 BLAS | multiplication-free ternary | speedup |
|---|---|---|---|
| 2048×2048 | 0.111 ms | 0.268 ms | **0.42×** (slower) |
| 4096×4096 | 0.272 ms | 2.612 ms | **0.10×** (slower) |

## Verdict — NO-GO for ternary-*accelerated* CPU serving on commodity hardware

- **It runs, but it's slow.** CPU-only 1.5B inference is **2.95 tok/s** (~6× slower than GPU) — below a
  usable interactive bar. A smaller model would be faster, but the coder we care about is 7B+, which on
  CPU would be well under 1 tok/s.
- **Software ternary does NOT beat fp BLAS on a stock CPU** (0.10–0.42×). Optimized fp32 BLAS wins; a
  multiplication-free ternary matvec in software does *more* memory traffic and misses the vectorized
  multiply-accumulate BLAS uses. **This is exactly T-SAR's premise** — you need custom SIMD hardware to
  make ternary faster than fp on a CPU. Without it, ternary on a stock CPU buys **memory** (a big model
  fits with no GPU), **not speed**.
- **Go/no-go: NO-GO** for shipping CPU-only ternary *for throughput*. It's viable only as a
  memory-fallback (runs where no GPU exists, at low tok/s), not as a fast local-first path.

## The realistic software route (if we still want CPU serving)

The honest next step is **not** T-SAR (hardware) but a **packed-ternary CPU kernel that already exists in
software**: `bitnet.cpp` / `llama.cpp`'s `TQ1_0`/`TQ2_0` ternary types, which hand-vectorize the
ternary matmul with AVX2/AVX-512/NEON intrinsics. That's the achievable way to test "does ternary help
on a real CPU," and it composes with the #2206 PTQTP quality result (which showed ~3.4-bit dual-ternary
holds LM quality but costs ~15 pts coding pass@1). Gate any CPU-serving push on a `bitnet.cpp` tok/s
measurement, not on T-SAR.

## Honest scope

fp weights on CPU via transformers (not a packed-ternary kernel); numpy microbench (the "mulfree" split
does 2× the BLAS work, so it's a loose upper bound on software ternary — a hand-tuned kernel would do
better but still lose to fp BLAS without SIMD ternary support, which is the whole point). MEASURED.
Reproduce: `.venv-train/Scripts/python.exe experiments/tsar_cpu_ternary.py --model <hf-id>`.
