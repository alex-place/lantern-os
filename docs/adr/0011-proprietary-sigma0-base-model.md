---
adr: 0011
title: Own a proprietary Σ₀ base model — fork the PLT architecture, adapter-only weights, council + CSF native
status: Proposed
date: 2026-06-29
deciders: Alex Place
approved-by: pending   # only Alex Place flips this; agents leave it `pending`
supersedes: none
superseded-by: none
---

<!--
  APPROVAL GATE: leave status `Proposed` and approved-by `pending`. An ADR is not
  binding until Alex Place explicitly approves it; only then set status `Accepted`
  and approved-by `Alex Place (YYYY-MM-DD)`. Never self-approve.
-->


# ADR-0011: Own a proprietary Σ₀ base model — fork the PLT architecture, adapter-only weights, council + CSF native

## Status

Proposed — awaiting approval from Alex Place.

### Progress since proposal (2026-06-30)

The owned modeling code now exists and **partially clears Stage 0** — this is the
evidence the founder gate ([#1666](https://github.com/alex-place/lantern-os/issues/1666))
was waiting on. The decision is *more* informed than at proposal time, but the
**blocking** parity check is still open, so status stays Proposed.

- **Own modeling code authored + merged.** [`models/keystone-sigma0-plt/`](../../models/keystone-sigma0-plt/README.md)
  — pure-torch `modeling_keystone_plt.py` (ported from the vendor vLLM fork) +
  `download_and_patch.py` + `check_parity.py` (the Stage-0 gate) + `train_lora.py`
  (adapter-only QLoRA) merged to master (PR #1645; run-fixes #1668; tokenizer-load
  fix `530940d5`). The Adaptive Loop Gate design (`ADAPTIVE-LOOP-GATE.md`,
  default-off so it can't perturb parity) and a Colab parity notebook also landed.
- **Stage-0 4-bit smoke: PASS on the 8 GB 3070** (2026-06-30,
  [`data/convergence/keystone-plt-parity-log.jsonl`](../../data/convergence/keystone-plt-parity-log.jsonl)):
  the Apache-2.0 weights bootstrap and load through *our* forward with **missing=0 /
  unexpected=0** (the weight port is faithful at the key level) and **2/3 coherent**
  generations, no OOM. This proves the module tree maps 1:1 — it does **not** yet
  prove the forward math is correct.
- **Faithful parity is STILL PENDING (the blocking gate).** The log shows
  `parity: null` — the definitive `top1_agree ≥ 0.99` vs a vLLM-fork reference needs
  a ≥24 GB box. The Colab harness (`colab_parity.ipynb`, PRs #1757/#1760: bf16 parity
  + HumanEval, LFS-skipped clone) is the path to run it. **Until that passes, the
  model stays `verified:false`, no training, and this ADR stays Proposed.**

This note adds evidence; it does not flip status. Only Alex Place sets `Accepted`.

## Context

The owner's directive: **a proprietary Σ₀ model — weights we adjust in future design, that serves
the Σ₀ council and uses CSF.** Today the local kernel tier leans on third-party checkpoints
(Ouro, Qwen) plugged into [`local-model-registry.js`](../../apps/lantern-garage/lib/local-model-registry.js).
That satisfies "models are interchangeable" ([ADR-0005](0005-interchangeable-model-providers.md))
but leaves us **unable to own the reasoning substrate**: we cannot change a model's forward pass,
and per [ADR-0010](0010-verify-gated-continual-learning-last-resort.md) we may only adjust *adapter*
weights — which presupposes a base whose modeling code we control.

A concrete starting point exists. **LoopCoder-V2** (`Multilingual-Multimodal-NLP/LoopCoder-V2`,
Apache-2.0) is a **Parallel Loop Transformer (PLT)**: `num_hidden_layers=14` physical layers
executed `plt_num_loops=2` times with shared weights, cross-loop processing, and per-head-gated
mixed attention (global full + local sliding-window `[64,0]`). That *looped-depth* design is the
same family as our self-converging kernel thesis (Ouro Q-exit, [[sigma0-coder-spiral-consolidation]]):
**recurrent compute is the Σ₀ Reason lever**. But the public release is **not usable as-is**: the HF
repo ships weights + config + tokenizer **but no `modeling_*.py`**, and `config.json`'s `auto_map`
wires only `AutoConfig` — so stock transformers cannot instantiate `IQuestPLTCoderForCausalLM`. The
vendor's only serving path is a **custom vLLM fork** (`yxing-bj/vllm`, bf16, no quantization), which
needs ≥24 GB VRAM and is a black box we cannot evolve. The 2026-06-29 on-box probe
(`experiments/loopcoder_v2_4bit_probe.py`) correctly refused it (`DONT_BUILD`,
[[loopcoder-v2-probe-failed]]).

The decision this forces: do we stay renters of third-party kernels forever, or do we **own a Σ₀
base model** — its architecture *and* its weights — as the local kernel tier?

Loop stages touched: **Reason** (a self-converging local kernel we control) and **Converge**
(adapter-only learning from verified experience, already sanctioned by [ADR-0010](0010-verify-gated-continual-learning-last-resort.md)).
Feature-gate check: this **extends** the existing local-model adapter + serving path and the existing
CSF/memory substrate — it is **not** a new ecosystem, dream engine, or parallel memory system. One
Convergence Core; one more interchangeable backend that happens to be ours.

## Decision

We will **build and own a proprietary Σ₀ base model — "Keystone-Σ₀" — by owning its modeling code,
not by depending on any vendor's serving path.**

1. **Own the architecture.** We author our own `modeling_keystone_plt.py` implementing the PLT
   forward (shared-layer loops + cross-loop processing + gated mixed attention) from the published
   config + paper (arXiv 2510.24824). Owning the forward pass is the **prerequisite** for everything
   else — adjustable weights, 4-bit fit, council hooks. The vendor vLLM fork is explicitly **not**
   adopted as the inference path (un-evolvable, ≥24 GB).

2. **Bootstrap weights legally, then make them ours.** Initialize from LoopCoder-V2's Apache-2.0
   checkpoint loaded through *our* modeling code. From that point the weights are a Keystone artifact
   we may adjust.

3. **Weights are adjusted only via the [ADR-0010](0010-verify-gated-continual-learning-last-resort.md)
   path** — adapter-only, base frozen, verified-experience source-gate, collapse tripwire, reversible,
   operator-gated. "Weights adjusted in future design" means **adapters over a frozen Keystone base**,
   never raw base-weight retraining. This ADR does not start training; it makes the base *we* own the
   thing those future adapters attach to.

4. **Council-native.** The model serves the existing Σ₀ council (wired into autowork, #1598 /
   [[dogfood-loop-reliable-and-council-wired]]) as a first-class member — its looped depth is the
   council's local Reason backend, behind the same verify gate as every other member.

5. **CSF-native.** Memory/experience it reasons over is the **one** append-only JSONL + CSF archive
   ([ADR-0004](0004-append-only-memory.md), [ADR-0003](0003-one-canonical-csf-module.md)). Base and
   adapter checkpoints are content-addressed and **archived in CSF** — no new store.

6. **Interchangeable, not hardcoded.** Keystone-Σ₀ registers in
   [`local-model-registry.js`](../../apps/lantern-garage/lib/local-model-registry.js) as one more
   VRAM-gated, evidence-gated entry ([ADR-0005](0005-interchangeable-model-providers.md)). It LEADS
   only when a reproduced on-box eval beats the incumbent (Qwen2.5-Coder / the frontier coder). Until
   then it stays `verified:false` and cannot displace a known-good lead (External Reality Rule, #1597).

## Consequences

- **Positive:**
  - We own the reasoning substrate end-to-end — the precondition for the ADR-0010 flywheel and for any
    Σ₀-specific architecture change (e.g. a *trained* Q-exit gate, [[ouro-adaptive-compute-gate]]).
  - Owning `modeling.py` lets us 4-bit the model into the 8 GB box (the vendor path cannot), keeping
    the kernel **local** (North Star principle 6).
  - Looped-depth kernel that's *ours* — aligns Reason with the Σ₀ self-converging thesis without a new
    subsystem.
- **Negative / trade-offs:**
  - **Real reverse-engineering risk.** A hand-written PLT forward must match the trained weights' exact
    tensor layout and the gated-attention / cross-loop math, or outputs are garbage. This is unverified
    until it reproduces the vLLM reference (Stage 0 below). Honest confidence today: **medium-low** on
    first-pass parity.
  - We take on model-maintenance debt (a modeling file, decode params, eval upkeep) we previously
    rented. Mitigated by adapter-only + frozen base + CSF-archived, content-addressed checkpoints.
  - Bootstrapping from a third-party checkpoint inherits its license (Apache-2.0 — compatible) and its
    biases until we adapt it.
- **Follow-ups (staged, each gated by on-box evidence — none auto-promotes the model):**
  - **Stage 0 — Parity.** ✅ *Authored + smoke-passed* (2026-06-30) — `modeling_keystone_plt.py`
    loaded the forked weights at 4-bit with 0 missing/unexpected keys + 2/3 coherent generations.
    ⛔ *Still open (the blocking sub-step):* reproduce the vLLM-fork reference logits on a fixed
    prompt set to `top1_agree ≥ 0.99` (run `colab_parity.ipynb` on a ≥24 GB box). *Gate: token/logit
    parity within tolerance.* Until the faithful check passes we own the weight **layout** but not
    the forward **math** — it remains the first and blocking step.
  - **Stage 1 — Fit.** 4-bit (bnb nf4) under the 8 GB budget; measure VRAM + tok/s
    (reuse `loopcoder_v2_4bit_probe.py` harness → `data/convergence/`).
  - **Stage 2 — Serve.** Ollama/OpenAI-compatible endpoint (the `ouro_serve.py` pattern); point the
    registry entry's `endpoint` at it.
  - **Stage 3 — Eval.** `eval_humaneval_chat.py` head-to-head vs Qwen2.5-Coder on-box; only a **win**
    flips `verified:true` with the measured `capabilityScore`.
  - **Stage 4 — Council + CSF.** Register as a council member; archive base/adapter checkpoints in CSF.
  - **Stage 5 — Adapters.** Only under the full ADR-0010 guardrail set, last.

## Alternatives considered

- **Stay on third-party kernels (do nothing).** Rejected by the directive — it forecloses owning the
  reasoning substrate and the ADR-0010 flywheel. Legitimately the safe default; if this ADR is
  rejected, this is what we keep, and Qwen2.5-Coder remains the local lead.
- **Adopt the vendor vLLM fork as our serving path.** Rejected — un-evolvable black box, bf16-only,
  ≥24 GB (won't fit the 8 GB box), and gives us no ability to adjust the forward or quantize. Fails the
  "weights adjusted in future design" requirement.
- **Train a Σ₀ model from scratch.** Rejected for now — orders of magnitude more compute than we have;
  bootstrapping from an Apache-2.0 looped-coder checkpoint gets a capable base for the cost of a
  modeling file + parity work.
- **Build on Ouro instead of PLT.** Not mutually exclusive — Ouro stays the registered recurrent-depth
  research front. PLT is chosen as the *bootstrap* because a strong, permissively-licensed coder
  checkpoint already exists; a future ADR may converge the two looped families.

## Evidence

| Claim | Evidence (file:line / commit / PR) | Confidence | Source |
|---|---|---|---|
| HF repo ships weights + config + tokenizer but **no `modeling_*.py`**; `auto_map` wires only `AutoConfig` | HF API siblings list (3 safetensors shards + index, no modeling.py); local `config.json` `auto_map` | High | huggingface.co API + `D:/hf-cache/.../config.json` |
| PLT = 14 shared layers × `plt_num_loops=2`, cross-loop processing + gated mixed attention | `configuration_iquestpltcoder.py:20-95` (docstring) | High | model repo |
| Arch params: hidden 5120, GQA 40/8, head_dim 128, SwiGLU/SiLU, RMSNorm, RoPE θ=500000, vocab 76800, ctx 131072, bf16 (~9B) | `config.json` | High | model repo |
| Vendor's only serving path is a custom vLLM fork (`yxing-bj/vllm`), bf16, no quant | README.md serve command | High | model card |
| On-box transformers load fails (`Unrecognized configuration class … for AutoModelForCausalLM`) → `DONT_BUILD` | `experiments/loopcoder_v2_4bit_probe.py`; `data/convergence/loopcoder-probe-log.jsonl` | High | this repo, 2026-06-29 |
| Adapter-only weight updates are the sanctioned future-weights path | [ADR-0010](0010-verify-gated-continual-learning-last-resort.md) | High | repo ADR |
| Model plugs in as one interchangeable, evidence-gated registry entry | [`local-model-registry.js:130-148`](../../apps/lantern-garage/lib/local-model-registry.js), #1597 | High | repo |
| Σ₀ council exists and runs on real decisions | #1598, [[dogfood-loop-reliable-and-council-wired]] | High | repo |
| LoopCoder-V2 is Apache-2.0 (legal to fork weights) | `local-model-registry.js:147` note; model card license | Med | model card |
| Looped/recurrent depth is the Σ₀ Reason lever | [[sigma0-coder-spiral-consolidation]], [[ouro-adaptive-compute-gate]] | Med | repo research |
| Own modeling code authored + merged (`models/keystone-sigma0-plt/`) | PR #1645 (`4fb5d04`); run-fixes #1668; tokenizer fix `530940d5` | High | this repo |
| Stage-0 4-bit smoke **PASS** on the 3070: 0 missing/unexpected keys, 2/3 coherent, no OOM | `data/convergence/keystone-plt-parity-log.jsonl` (2026-06-30) | High | this repo, on-box |
| Faithful logit parity (`top1_agree ≥ 0.99` vs vLLM ref) **NOT yet run** (`parity: null`) | same log; `colab_parity.ipynb` (#1757 / #1760) is the path | High | this repo |
