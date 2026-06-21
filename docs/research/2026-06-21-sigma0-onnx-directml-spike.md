---
title: Σ₀ ONNX Runtime + DirectML Embedded Export — Spike Scope
created: 2026-06-21
status: spike scope / GO-NO-GO plan
owner: Σ₀ workstream
relates_to:
  - docs/SIGMA0-AGENT-PORTFOLIO-UPDATE.md
  - docs/research/2026-06-21-sigma0-serving-validation.md
---

# Σ₀ ONNX/DirectML Embedded Export — Spike Scope

**One-line goal:** in a time-boxed spike, produce a **GO/NO-GO with measured numbers** on whether Ouro-1.4B's *looped, adaptive-depth* architecture can be exported to **ONNX Runtime + DirectML** and run **in-process on Windows, across GPU vendors, at interactive speed**. This is the gate for the "embedded-first" target in the portfolio decision; NO-GO falls back to the hybrid cloud-transformers floor (never a loop-dropping dense GGUF).

## Why this is the bet (verified background)
- ONNX `Loop` supports a **data-dependent trip count / termination condition** → Ouro's entropy **Q-exit is *expressible* in the graph** (validation conf 0.97). No other fast runtime can keep adaptive depth: **vLLM serves the loop but pins fixed R4** (conf 0.97).
- **DirectML runs on any DX12 GPU** — NVIDIA / AMD / Intel + CPU (Phi-3-on-Windows precedent) → the only path that is Windows-native, all-vendor, **and** fully local.
- **Risk that justifies a spike:** there is **zero public precedent** for exporting a LoopLM to ONNX. The crux unknown is the adaptive-exit loop, not the basics.

## Architecture facts to design against (`config.json`, verified)
`total_ut_steps=4` (R4) · `num_hidden_layers=24` · hidden 2048 · 16 heads · vocab 49152 · RoPE + SwiGLU + sandwich-norm · `early_exit_gate` (RowParallelLinear) · `early_exit_threshold=1.0`. The recurrence is the **same 24-block stack re-applied up to 4×**, with **per-UT-step KV** (`unique_layer_idx = ut_step*total_layers + base_idx`); the Q-exit gate decides early termination per token.

## Plan

### Phase A — Fixed-depth export first (de-risk the mechanics)
1. Load `ByteDance/Ouro-1.4B-Thinking` (transformers); export **one decoder pass** to ONNX (`torch.onnx.export` dynamo path; opset ≥ 18).
2. Represent the R4 recurrence as a **fixed trip-count `Loop`** (or an unrolled 4× graph) over the shared block stack; wire the per-UT KV indexing.
3. Run under ONNX Runtime **CPU EP**, then **DirectML EP**. Confirm DirectML executes on NVIDIA + (if a 2nd GPU is available) AMD/Intel.
4. **Parity check:** logits match transformers fixed-cached within tolerance on a 10-prompt golden set.
5. **Measure** tokens/sec (fixed R4) on the 8 GB dev GPU and CPU, at fp16 and int4 (`ort-quantize` / matmul-nbits).

### Phase B — Adaptive depth (the actual bet)
6. Replace the fixed trip count with a **data-dependent `Loop`**: compute the Q-exit entropy/threshold inside the loop body and emit the `cond` output so simple tokens exit < 4 steps.
7. **Correctness:** the per-token exit step reproduces the native `OURO_NATIVE` (Q-exit) engine within ±1 step on ≥90% of tokens over the golden set.
8. **Measure** tokens/sec **and average exit depth** on representative coding prompts.

### Cross-cutting
- **Generation loop / KV:** ONNX Runtime GenAI assumes a standard stack; the loop will likely need a **custom decode loop** (or a `genai` model-config extension) to carry per-UT KV. Decide in Phase A.
- **Packaging:** target in-process load from the Windows client (`onnxruntime-node` or a small native host) behind the same `SIGMA0_BASE_URL` contract, so it's a config swap, not a code fork.

## GO / NO-GO gate (GO only if ALL hold)
- ✅ Fixed-R4 logit parity with transformers (within tol).
- ✅ Adaptive exit reproduces `OURO_NATIVE` decisions (±1 step, ≥90% tokens).
- ✅ DirectML runs on ≥2 GPU vendors (or NVIDIA + CPU at minimum).
- ✅ **Interactive speed:** beat the native ~1 s/token path by ≥3× on 8 GB (target ≥5 tok/s at int4) — i.e., usable for chat.

**NO-GO →** stay on the hybrid **cloud-transformers** floor; revisit when ORT/DirectML LoopLM support matures. Do **not** fall back to a dense GGUF (violates the Σ₀=Ouro consolidation).

## Effort & sequencing
**1–2 weeks specialist time, off the critical path** (the cloud floor ships independently in Phases 0–2). Phase A is the cheap kill-switch — if fixed-R4 export or DirectML execution fails, stop before Phase B.

## Deliverable
A spike report appended to the portfolio decision: the measured table (parity, exit-fidelity, per-vendor execution, tok/s, avg depth) + the GO/NO-GO call. That single measurement decides embedded-Windows vs hybrid-cloud as the Σ₀ end state.
