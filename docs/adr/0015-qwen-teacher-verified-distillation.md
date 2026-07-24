---
adr: 0015
title: Qwen-teacher verified distillation into Ouro — proposer, not imitation; execution is the teacher of record
status: Accepted
date: 2026-07-02
deciders: Alex Place
approved-by: Alex Place (2026-07-04)
supersedes: none
superseded-by: none
---

<!--
  APPROVAL GATE: leave status `Proposed` and approved-by `pending`. An ADR is not
  binding until Alex Place explicitly approves it; only then set status `Accepted`
  and approved-by `Alex Place (YYYY-MM-DD)`. Never self-approve.
-->


# ADR-0015: Qwen-teacher verified distillation into Ouro — proposer, not imitation; execution is the teacher of record

## Status

Proposed — awaiting approval from Alex Place. **This ADR does not start a training run.**
It records *how* a Qwen→Ouro teacher/student path is allowed to exist at all under Σ₀, and
authorizes only the offline, no-GPU **proposer + verify** front half
([`scripts/qwen_teacher_crystallize.py`](../../scripts/qwen_teacher_crystallize.py) scaffold).
The train/eval/promote back half stays gated on this ADR's approval and on
[ADR-0010](0010-verify-gated-continual-learning-last-resort.md).

## Context

The owner's directive: **use Qwen as the teacher and Ouro ("oura") as the student for the Σ₀
council — figure out how best to use Qwen to crystallize a model for Ouro, and make the unisona
model update.** Taken literally, that is *knowledge distillation*: copy a strong model's outputs
into a weaker one.

Two repo facts constrain the literal reading:

1. **Qwen was retired from the local coder lane** (2026-06-28,
   [`docs/SIGMA0-MODEL-ADAPTER.md`](../SIGMA0-MODEL-ADAPTER.md); the registry test asserts
   `!chain.includes("qwen2.5-coder")`). It is no longer registry-managed but still pulls via
   Ollama (`Qwen2.5-Coder-7B`, ~4.7 GB @ Q4_K_M — fits the 8 GB 3070). So Qwen is available as a
   *tool*, just not as a *lead*.
2. **[ADR-0010](0010-verify-gated-continual-learning-last-resort.md) forbids plain distillation.**
   The only sanctioned training signal is *externally-verified-correct experience* (code that
   passed tests; claims that are grounded). A soft-label teacher→student copy has no verification
   step, so it fails the **External Reality Rule** ("nothing accepted without evidence"). The
   existing flywheel ([`scripts/continual_ouro_pipeline.py`](../../scripts/continual_ouro_pipeline.py))
   is built exactly this way: *harvest → execution-verify → train → eval → promote*, and its
   `#1198` distillation branch only ingests cloud-teacher solutions that **already passed the repo
   tests at capture time**.

The tension resolves cleanly if we change *what Qwen contributes*. Qwen does not teach Ouro by
imitation. **Qwen teaches by *proposing*; a compile+exec+assert gate is the teacher of record.**
Qwen becomes a high-throughput candidate generator; only its solutions that actually run green
become Ouro training rows. This keeps the owner's teacher/student framing **and** obeys Σ₀ —
verification, not the teacher's authority, is what promotes a row.

Loop stages touched: **Reason** (a stronger proposer widens the candidate set the student learns
from) and **Converge** (adapter-only learning from verified experience, already sanctioned by
ADR-0010). Feature-gate check: this **extends** the existing continual-training flywheel and the
one CSF/memory substrate with a new *proposer* front-end — it is **not** a new dream engine, a
second memory system, or a parallel agent ecosystem. One Convergence Core; one flywheel; one more
interchangeable proposer that happens to be Qwen.

## Decision

We will allow a **Qwen-teacher → Ouro-student** path **only in its verification-gated form**, and
implement it as an extension of the existing flywheel — not as a new subsystem.

1. **Qwen is a proposer, never an oracle.** Qwen2.5-Coder generates candidate solutions +
   reasoning traces for decontaminated coding prompts. A Qwen output that is not
   execution-verified is **discarded**, not trained on. There is **no** soft-label / logit / KL
   distillation from Qwen — only its *verified behavior* survives.

2. **Execution verification is the teacher of record.** The same compile+exec+assert
   green-subprocess gate that already governs `continual_ouro_pipeline.py` decides which
   Qwen-proposed rows exist. Provenance is stamped on every row
   (`meta.proposer = "qwen2.5-coder"`, `meta.verification = "green-subprocess"`), so the corpus is
   auditable and a bad teacher is traceable and revocable.

3. **The student is Ouro-1.4B (runnable now).** The crystallized corpus trains an **Ouro-1.4B
   QLoRA adapter** (~45 s/step on the 8 GB 3070) — not the 7.6 B unisona.ai-Σ₀ PLT, which cannot
   train under 8 GB and waits on the ≥24 GB box ([#1829]). "Crystallize a model for oura" targets
   Ouro deliberately.

4. **Train/eval/promote is unchanged and eval-gated.** Training reuses
   `scripts/train-qlora-ouro.py`; promotion reuses the pure `decide_promotion` gate — a candidate
   promotes **iff** it beats the incumbent's held-out pass@1 by a margin, logged as a Convergence
   Record to `data/eval/ouro-promotion-log.jsonl`. The **unisona model update is that promotion**:
   the adapter swap + the `local-model-registry.js` entry flipping `verified:false → true` **only
   because an on-box eval log backs it** — never a vendor number.

5. **Council is the trigger + follow-up authority, not a training input.** The Σ₀ council frames
   one Convergence Record (hypothesis: "verified Qwen-proposed traces lift Ouro held-out pass@1
   above the incumbent by ≥ margin"; evidence: the baseline logs; follow-up: the Stage-D eval
   gate). Qwen and Ouro are the two seats — Qwen proposes, Ouro is the incumbent being challenged.
   The council decides *whether the hypothesis converged*; it does not hand-feed weights.

6. **Decontamination + secret-scrub are mandatory front-gates.** Prompts and rows pass the
   existing 13-gram decontamination vs HumanEval + MBPP
   ([`scripts/decontaminate_training.py`](../../scripts/decontaminate_training.py)) and the
   secret-scrub regexes from `pr_crystallize.py`, before CSF packing. Public benchmarks stay
   read-only targets (ADR-0010 rule).

7. **Offline, operator-gated, reversible.** Every guardrail from ADR-0010 applies unchanged:
   base frozen, adapter-only, collapse tripwire on promotion, content-addressed + CSF-archived,
   revertible, operator-initiated. The live request path never retrains.

**Scope authorized by this ADR on approval:** the *proposer + verify + CSF-pack* front half
(no GPU). The *train + eval + promote* back half remains additionally gated on the operator
running it on the GPU box under ADR-0010.

## Consequences

- **Positive:**
  - Reconciles the owner's teacher/student directive with the External Reality Rule without
    weakening either — a stronger proposer, a stricter gate.
  - Reuses the entire verified flywheel (verify gate, QLoRA trainer, `decide_promotion`,
    promotion log); the only new code is the Qwen proposer front-end. Extension, not addition.
  - Runnable on the existing 8 GB box today (Qwen inference + Ouro-1.4B QLoRA are both in-budget),
    so it is not blocked on the ≥24 GB handoff.
  - A stronger, licence-clean coder (Qwen2.5-Coder, Apache-2.0) widens Ouro's verified-corpus
    coverage beyond what merged PRs alone supply.
- **Negative / trade-offs:**
  - **Teacher bias leaks through the verifier's blind spots.** Execution-verify proves a solution
    *runs and passes its asserts*, not that it is idiomatic, safe, or non-degenerate. Mitigation:
    keep the asserts strong, cap per-prompt yield, and monitor the collapse tripwire on the
    trained adapter.
  - Adds a model-serving dependency (a local Qwen endpoint) to the offline pipeline; mitigated by
    keeping it opt-in and pointing at any OpenAI/Ollama-compatible endpoint via env.
  - Distillation — even verified — is still the ADR-0010 *last resort*. This ADR does not claim
    frozen-base levers are exhausted; it only makes the *shape* legitimate for when they are.
- **Follow-ups (each gated by on-box evidence — none auto-promotes a model):**
  - **Stage A — Council scoping.** One Convergence Record framing the hypothesis + baseline
    evidence + follow-up gate.
  - **Stage B — Proposer + verify (this ADR's authorized front half).**
    `scripts/qwen_teacher_crystallize.py` → decontaminated prompts → Qwen candidates →
    green-subprocess verify → secret-scrub → 13-gram decontaminate → CSF pack. No GPU. Scaffold
    landed with this ADR; wiring the live Qwen call + a sampled row review is the first PR after
    approval.
  - **Stage C — Train.** `train-qlora-ouro.py` on the verified corpus (8 GB box).
  - **Stage D — Eval-gated promote = the unisona update.** `eval_sigma0_adapter.py` /
    `eval_humaneval_ouro.py`; `decide_promotion`; registry `verified` flip + adapter swap; log the
    Convergence Record.

## Alternatives considered

- **Literal soft-label / KL distillation from Qwen into Ouro.** Rejected — no verification step,
  fails the External Reality Rule and ADR-0010's source gate. It would train Ouro to imitate
  Qwen's *mistakes* as readily as its correct answers.
- **Re-instate Qwen as the local coder lead instead of distilling it.** Rejected as a *different*
  decision — it re-opens the 2026-06-28 retirement and ADR-0011's sole-coder stance, and does
  nothing for owning/adapting the Ouro substrate. Out of scope here.
- **Keep only PR-crystallized data (`pr_crystallize.py`), no Qwen at all.** Legitimate and is the
  safe default if this ADR is rejected — merged PRs are already verified. Rejected as *sole*
  source because PR volume is finite and long-diff-skewed (only 530/1,178 unisona rows fit
  seq=1536, [[crystallization-grounding-corpus]]); a verified proposer cheaply widens coverage.
- **Distil into the 7.6 B unisona.ai-Σ₀ PLT instead of Ouro-1.4B.** Deferred — the 7.6 B student
  cannot train under 8 GB (#1829). The corpus this pipeline produces is model-agnostic and can
  feed the PLT student later on the ≥24 GB box.

## Evidence

| Claim | Evidence (file:line / commit / PR) | Confidence | Source |
|---|---|---|---|
| Qwen retired from the local coder lane (still Ollama-pullable, not registry-managed) | `docs/SIGMA0-MODEL-ADAPTER.md`; `test/local-model-registry.test.js` (`!chain.includes("qwen2.5-coder")`) | High | this repo |
| Qwen2.5-Coder-7B fits the 8 GB box (~4.7 GB @ Q4_K_M) | `local-model-registry.js` capability-first comments | Med | repo notes |
| ADR-0010 permits training only on externally-verified-correct experience | [ADR-0010](0010-verify-gated-continual-learning-last-resort.md) | High | repo ADR |
| A verified flywheel already exists: harvest → exec-verify → train → eval → promote | [`scripts/continual_ouro_pipeline.py:5-23`](../../scripts/continual_ouro_pipeline.py) | High | this repo |
| Execution-verify is the ground-truth gate (only a green subprocess counts) | [`continual_ouro_pipeline.py:86-153`](../../scripts/continual_ouro_pipeline.py) | High | this repo |
| Prior verified-distillation branch only ingests already-test-passed cloud solutions (#1198) | [`continual_ouro_pipeline.py:109-141`](../../scripts/continual_ouro_pipeline.py) | High | this repo |
| Promotion is a pure eval gate (beat incumbent pass@1 by margin) logged as a Convergence Record | [`continual_ouro_pipeline.py:202-283`](../../scripts/continual_ouro_pipeline.py) | High | this repo |
| Ouro-1.4B QLoRA trains on the 8 GB 3070 (~45 s/step); 7.6 B PLT cannot (needs ≥24 GB, #1829) | [[crystallization-grounding-corpus]]; [[unisona-local-model-plan]] | High | repo research |
| 13-gram decontamination vs HumanEval+MBPP exists and is auditable | [`scripts/decontaminate_training.py`](../../scripts/decontaminate_training.py) | High | this repo |
| Secret-scrub regexes exist for training-row extraction | `scripts/pr_crystallize.py:75-85` | High | this repo |
| The "unisona update" surface is the registry `verified` flip + adapter swap | [`local-model-registry.js`](../../lib/local-model-registry.js); ADR-0011 | High | this repo |
| Σ₀ council exists and runs on real decisions | #1598, [[dogfood-loop-reliable-and-council-wired]] | High | this repo |
