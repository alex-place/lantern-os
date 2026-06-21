# Σ₀-K1 — The first buildable convergence kernel (spec)

**Date:** 2026-06-19
**Scope chosen:** concrete buildable kernel, evidence-tagged (Σ₀ rigor, defensible to a skeptic).
**What this freezes:** the human design of the Convergence Core's first end-to-end instantiation. After this, improvement comes from the loop (retrieval, records, distillation) — not from re-drawing the architecture. Per North Star: *models are interchangeable; persistent learning, not weight modification.*

Evidence tags: **[measured]** = number in a repo artifact · **[tested]** = has a passing test · **[built]** = code exists & runs · **[coded]** = code exists, not exercised end-to-end · **[design]** = not implemented.

> **⏱ Real-time status (updated 2026-06-21).** Since this spec was frozen: **Gate A is done** (65-prompt golden set; 34% measured cold baseline — see §3); the Convergence loop's first slice closes end-to-end (Kalshi) and token-budgeted Memory shipped (#772). **The kernel's blocker is cleared:** component 6 (the state-ABI shim `StateABIShim`, φ/ψ) is built + tested ([`src/sigma0/state_abi.py`](../src/sigma0/state_abi.py), #844; `tests/test_state_abi_shim.py`), and the components it unblocks landed next — provider Dynamics nodes (component 5, [`provider_node.py`](../src/sigma0/provider_node.py), #846) and the CSF `{x,Σ,Trace}` state snapshot (component 7, [`kernel_snapshot.py`](../src/sigma0/kernel_snapshot.py), #847; Gate D survives save/load), with collapse-cert + NIS-canary e2e coverage (#852). New tests: `tests/test_sigma0_*.py`. Executive summary: [`docs/KEYSTONE-PROGRESS-REPORT-2026-06-19.md`](KEYSTONE-PROGRESS-REPORT-2026-06-19.md).

## 0. The honest headline (read first)

This kernel is **buildable now**, but it is **not** a strong model. The local model is a **1.4B** that scores **pass@1 = 0.1 on HumanEval at ~284 s/problem** ([`data/eval/leaderboard.jsonl`](../data/eval/leaderboard.jsonl), label `ouro-he10`) **[measured]**. The widely-cited "80% (8/10)" is on a **10-prompt trivia set** scored by keyword coverage ([`data/eval/sigma0-prompts.jsonl`](../data/eval/sigma0-prompts.jsonl)) **[measured, but not a capability metric]**.

**Therefore the design goal is NOT a perfect model.** It is: *make a cheap, weak, interchangeable kernel converge* by wrapping it in (a) a replayable state VM, (b) behaviour-preserving hot-swap to stronger/available provider nodes, (c) mandatory grounding, (d) a cloud leaderboard that carries hard tasks and distills the losses back. "Near-ideal LLM" is rejected by the evidence; "a kernel that converges despite a weak core" is supported by what we've built.

## 1. The kernel, component by component

| # | Component | Concrete choice | Status |
|---|---|---|---|
| 1 | **Kernel model** | `ByteDance/Ouro-1.4B` + Σ₀ QLoRA adapter, served by [`ouro_serve.py`](../scripts/ouro_serve.py) on `:11434` via an **Ollama-compatible** `/api/chat` (`ouro:latest`). The Ollama binary itself is **sunset** (#811/#823) — `ouro_serve.py` runs the Ouro LoopLM in-process and only emulates the Ollama wire protocol, so existing surfaces work unchanged. | [built] |
| 2 | **Reasoning loop** | Ouro adaptive-depth latent loop, Q-exit `CDF(t)≥q` ([`loop_lm.py`](../src/sigma0/loop_lm.py)); L1–L4 = recurrent steps | [coded] |
| 3 | **State VM** | `CIO_SDE(dim=d, ctrl_dim=m)`: x∈Rᵈ, Σ∈Rᵈˣᵈ; `forward_step` = PCSF control + Euler-Maruyama + Riccati ([`engine.py`](../src/cio_sde/engine.py)) | [tested] |
| 4 | **Hot-swap** | `rollout(…, swap_schedule={t: node})` swaps the active `Dynamics` node **at step t**, gated by `GraphController.hot_swap` drift-equivalence (`‖f_old−f_new‖/‖f_old‖ < 0.25`) | [tested] |
| 5 | **Provider/agent nodes** | each provider wrapped as a `Dynamics` whose `drift` advances one reasoning step on x ([`provider_node.py`](../src/sigma0/provider_node.py), #846); routed by Provider-Capacity PCSF `get_routable_chain()` + leaderboard `compositeScore` | routing [built]; node wrappers [built] (live text-provider wiring [coded], drift measured by #845) |
| 6 | **State ABI shim** | `StateABIShim`: φ = LayerNorm→Linear encode (Ouro exit-depth hidden Rᴴ → x∈Rᵈ, d∈[64,256]); ψ = learned Linear readout (x → decode-context Rᴴ) ([`state_abi.py`](../src/sigma0/state_abi.py), #844) | **[built/tested]** (`tests/test_state_abi_shim.py`) — the live "no decode-regression vs raw Ouro on Gate A" check is the GPU follow-up |
| 7 | **CSF snapshot** | serialize `{x, Σ, Trace, active_id, base_seed, dt, step}` as a **CSF-Pack** archive (JSON manifest + blob + sha256 footer) → migrate/resume/replay ([`kernel_snapshot.py`](../src/sigma0/kernel_snapshot.py), #847) | CSF-Pack [built]; x/Σ/Trace snapshot [tested] — Gate D survives save/load |
| 8 | **Convergence guarantees** | replayable `Trace` (noise seeded by `base_seed+t`) [tested]; Σ₀ collapse certificate (Lyapunov `eig(A)`) [coded]; surprise NIS χ² canary [coded] | mixed |
| 9 | **Grounding / Verify** | External Reality Rule — outputs carry `[claim, evidence, confidence, source]`; grounding-precision metric | [design]; closure **not live** |

**One-sentence definition (frozen):** *Σ₀-K1 is Ouro-1.4B running an adaptive-depth loop over a CSF-snapshotted state vector x, whose per-step execution node is hot-swappable to a routable, drift-equivalent provider/agent under constraint-dominant PCSF control, where nothing is accepted without evidence and every trajectory is replayable and convergence-certified.*

## 2. What hot-swap can and cannot do (the boundary, restated as a build constraint)

- The swap gate is **behaviour-preserving** (tol=0.25): it routes around an unavailable/expensive node with an **equivalent** one. It is **swap-for-availability/cost**, not swap-for-behavioral-diversity. **[tested]**
- All nodes must share the **d-dim state ABI** (component 6). Ouro's raw weight-tied hidden tensors are *not* a shared ABI across providers — which is exactly why component 6 (the projection shim) is the blocker, and why CSF (a format) is what makes the state portable.
- **Open question to settle before building #5:** do *any two* real providers produce drift within tol=0.25 on x? If none do, hot-swap degrades to "swap your own cheaper/cached implementation," and cross-provider *diversity* must live in the text-boundary re-prompt lane ([`loop-reasoner.js`](../apps/lantern-garage/lib/loop-reasoner.js)), not the VM.

## 3. Acceptance gates (how we'll know it converged — all via `eval_keystone.py`)

| Gate | Metric | Bar | Today |
|---|---|---|---|
| **A. Golden set is real** | replace 10 trivia prompts with a graded, repo-grounded set | ≥50 prompts, rubric-scored | **DONE [built]** — 65 prompts (55 repo-grounded across 11 categories, 5 smoke, 5 reasoning), each traceable to a `source`; scorer extended with `\|`-alternatives; locked by [`tests/test_eval_keystone_score.py`](../tests/test_eval_keystone_score.py). **Not yet run against a live kernel** (needs `ouro_serve.py` up). |
| **B. Continuation acc.** | `eval_keystone.py` accuracy on A | beat kernel-alone baseline | **baseline set [measured]: 34% (22/65) cold, no grounding injected** — on the now-deprecated Qwen `lantern-sigma0-coder-v2` (Ollama sunset #811/#823); gradient 100/50/29/13% (smoke/easy/med/hard). Grounded serving on `ouro:latest` must beat 34%. |
| **C. Kernel floor** | HumanEval pass@1 (when cloud carries) | track, not gate | **0.1 [measured]** |
| **D. Replay determinism** | same `base_seed` → identical `Trace` | exact | `test_rollout_is_replayable` **[tested]** |
| **E. Hot-swap safety** | no accepted swap with `drift_delta ≥ tol`; strangers rejected | invariant | `test_hot_swap_*` **[tested]** |
| **F. Bytes-per-correct** | served cost per *correct* continuation | down vs baseline | **logged [built]** — `eval_keystone.py` emits `served_bytes` + `bytes_per_correct` per run (#851); needs a live grounded run to populate vs baseline |

## 4. Build order (the actual work — nothing here is "design a perfect model")

1. **Fix the golden set** (Gate A). You cannot certify a kernel on "What is 2+2?". This is cheap and unblocks every other measurement.
2. **Build the state-ABI shim** (component 6) — the single blocker that connects Ouro's loop to the hot-swap VM. Verify φ/ψ round-trip preserves decode quality on Gate A.
3. **Wrap 2–3 providers as `Dynamics` nodes** (component 5); empirically answer §2's open question (are any drift-equivalent?).
4. **CSF snapshot schema** for `{x, Σ, Trace}` (component 7) on top of CSF-Pack v0.8.
5. **Wire the loop closure** into the live serving path (the gap named in [agent-spine doc](research/2026-06-19-convergence-core-agent-spine.md)).
6. **Gate every change through `eval_keystone.py` → `leaderboard.jsonl`.** No serving change ships without a row.

## 5. Honest scope
- The VM, hot-swap, replay, and certificate are real and tested. **As of 2026-06-21 the state-ABI shim (φ/ψ, #844), provider-node wrappers (#846), and the CSF `{x,Σ,Trace}` state-snapshot (#847) are built + tested** (`tests/test_sigma0_*.py`). What remains: **live calibration** (fit φ/ψ on real Ouro hiddens + Gate-A no-regression, needs the GPU kernel), the **live text-provider drift measurement** (#845), and the **live loop closure** into serving (component 9, #848).
- All performance numbers are from the cited artifacts; the kernel is a weak local model by current measurement.
- "Σ₀-K1" is a **design spec**, not yet a fully running system. Freezing it means: build *this*, measure against §3, and improve only through the loop thereafter.
