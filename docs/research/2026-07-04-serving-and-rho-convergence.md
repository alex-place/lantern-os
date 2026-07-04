# Convergence record — serving substrate + certificate ρ control-check (2026-07-04)

Two convergence records from grounding the "serve our own transformer" design against mid-2026
SOTA and against our own measurement. Format: [hypothesis → evidence → result → confidence →
source]. Backs [ADR-0021](../adr/0021-serving-substrate-retain-ouro-custom-loop.md).

## Record 1 — serving substrate

- **Hypothesis:** moving Ouro to a production serving engine (vLLM/SGLang/llama.cpp) is the way
  to fix DEEP mode's ~1 s/token and harden serving.
- **Evidence:** web sweep, 4 lenses, adversarial re-fetch of 10 load-bearing claims, 0 refuted
  ([memo](2026-07-04-serving-design-sota.md)). vLLM's `ouro.py` runs a **fixed** 4-loop and never
  calls its `early_exit_gate` (source-verified twice); Ouro card confirms vLLM always runs all
  steps; vLLM #37668 (open, Mar 2026) confirms adaptive exit unimplemented; TGI archived;
  TensorRT-LLM dropped Windows; llama.cpp/ExLlamaV3 have no Ouro arch; no engine exposes mid-layer
  hidden states (vLLM RFC #33118 closed). Every adaptive-depth model in the wild runs a custom
  `transformers` loop (Ouro, Huginn).
- **Result:** hypothesis **refuted**. An engine forfeits the two capabilities we require (adaptive
  Q-exit depth + mid-layer hidden states) to buy throughput a single-user box doesn't need. Retain
  the custom loop; spend effort in-loop (Huginn KV tricks) + on a mid-layer probe; defer Qwen3.5-4B
  as a capability node. Guardrail landed: `ouro_compat.py` transformers-pin check (7 tests pass).
- **Confidence:** 0.85. Serving-stack facts VERIFIED + double-fetched; the model-landscape /
  monitoring lenses VERIFIED-once (one tier lower). Residual risk: a future engine could add
  adaptive-depth serving.
- **Source:** vLLM PR #27794 / issue #37668 / RFC #33118; huggingface.co/ByteDance/Ouro-1.4B;
  arXiv 2510.25741 (Ouro), 2502.05171 (Huginn), 2606.02628 (mid-layer probe), 2605.26733 (STARS);
  scripts/ouro_serve.py; SIGMA0-K1-KERNEL-SPEC.md §0.

## Record 2 — certificate ρ = 1.064 is an unreliable estimate

- **Hypothesis (certificate §6):** the encoder's mean Jacobian spectral radius ρ = 1.064 (over a
  2678-turn log) is evidence the reasoning loop sits near its stability boundary.
- **Evidence:** `experiments/rho_controls.py` re-ran the same encoder + `fit_jacobian` with
  controls. Unregularized `lstsq` is tail-dominated (synthetic window-8 mean 1.124 > median 0.992;
  real 830-turn log: mean ≈ 25, max ρ ≈ 16,872 from a near-singular design matrix); mild ridge
  collapses ρ>1 (synthetic 1e-2 → mean 0.65, f>1 0.47→0.06); median contracts as window grows;
  relative residual 0.44–0.80 (poor linear fit); strongly non-normal (~1.2), so ρ is the wrong
  single summary. The 2678-turn corpus (`apps/data/conversations`) is a dead path here; the real
  830-turn log is untracked runtime data — neither is repo-reproducible, so the script falls back
  to a seeded synthetic corpus.
- **Result:** the ρ=1.064 *number* does **not** survive controls — a fitting artifact, not a
  dynamics property. Deeper: the state is 4 text-surface features, not model hidden states, so this
  ρ is not the certificate's α regardless. Number annotated in place (kept, not deleted). The real
  measurement — loop Jacobian on Ouro hidden states via `StateABIShim`, with these controls — is
  staged behind serving our own model (Record 1).
- **Confidence:** 0.9 that the mean is unreliable (measured, reproducible pattern); 0.6 on the
  interpretive question of whether the *real* latent loop is genuinely near-boundary (unmeasured —
  requires the hidden-state fit).
- **Source:** experiments/rho_controls.py + experiments/router_sigma0_encoder.py; this session's run
  logs; SIGMA0-COLLAPSE-CERTIFICATE.md §6 (annotated); STARS arXiv 2605.26733.
