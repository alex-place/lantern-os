---
author: Alex Place
created: 2026-07-22
status: Proposed   # needs operator approval (ADR gate) before any training program starts
---

# AGI v1.10 — the White-Box Verified-Honesty frontier design

> **One line.** The frontier we can actually own is **not a bigger model** — it is a model whose
> **honesty is verified inside the box** (in the activations), trained on data we **minted against
> reality** instead of scraped. Capability is rented and commodity; the *verifier* and the *verified
> corpus* are the moat. This is the honesty-axis twin of the coding-axis
> **[Spiral](SIGMA0-OURO-CODER.md)**: same thesis — *the verifier, not scale, is the source of
> generalization* — applied to truthfulness instead of code.

**Status:** Proposed. This is a design + freedom-to-operate note, grounded in fresh (2026) external
literature and patents. It does **not** authorize a training run; ADR-0024's kill-gated program and
the operator ADR-approval gate still apply. It answers the founder's standing objection ("everything
committed is copy-paste; prove a training program would work before I approve it") by (a) naming the
one component renters structurally cannot have, and (b) making the proof a cheap dose-response gate.

---

## 1. Why honesty is the only frontier axis worth owning

Capability is a commodity: every frontier model is a transformer + MoE trained on the same scraped
web, and open Qwen-scale coders already sit near Claude 3.5 on SWE-bench (see
[Spiral §2](SIGMA0-OURO-CODER.md)). We cannot out-parameter the frontier and gain nothing by trying.

The unsolved, *unowned* axis is **honest calibration** — knowing and saying what you don't know. Two
independent literatures converge on it as a first-class training objective, not a post-hoc patch:

- **Abstention-aware objectives.** *Reinforced Hesitation* ([2511.11500](https://arxiv.org/abs/2511.11500))
  replaces binary RLVR rewards with a **ternary reward `+1 correct / 0 abstain / −λ error`**; varying
  λ traces a Pareto frontier of risk regimes. *I-CALM* ([2604.03904](https://arxiv.org/pdf/2604.03904))
  and *TIAR* ([2605.25850](https://arxiv.org/pdf/2605.25850)) incentivize confidence-aware abstention.
  Surveys ([2407.18418](https://arxiv.org/html/2407.18418v1)) note the effect of refusal-aware data in
  **pretraining** is essentially unstudied — an unoccupied slot.
- **Honesty as a measurable property.** The E1 result on our own stack (confab 10%→55% once the
  status-gloss was stripped) proved that output-level honesty tunes learn a **surface shortcut**. The
  fix is to check honesty where the shortcut can't reach: inside the network.

## 2. The differentiator — verify honesty in the activations (white-box)

A rented API model is a black box: you see tokens, nothing else. Output-graded honesty is exactly
what E1 gamed. **Open weights expose the hidden states**, and the 2026 literature shows a truth signal
lives there and is cheaply readable:

| Finding | Source | Number |
|---|---|---|
| Mid-layer **linear** probe decodes truthfulness; MLP probes add <0.01 AUROC | [2606.02628](https://arxiv.org/abs/2606.02628) | **0.904–1.000 AUROC** held-out (TruthfulQA/HaluEval/FEVER) |
| …on **4-bit NF4 quantized** 7–8B models, consistent probing-layer band across Llama/Mistral/Qwen | [2606.02628](https://arxiv.org/abs/2606.02628) | probes blocks 13–18/32, 19–25/28 |
| Sampling/consistency detectors, same protocol | [2606.02628](https://arxiv.org/abs/2606.02628) | **≤0.541 AUROC** (near chance) |
| Preemptive detection *before* the token is emitted; trajectory probing without per-language FT | [2410.02899](https://arxiv.org/pdf/2410.02899) · [2605.24919](https://arxiv.org/pdf/2605.24919) · [2507.16488](https://arxiv.org/pdf/2507.16488) | — |

**The load-bearing caveat (designed around, not ignored).**
[2510.09033](https://arxiv.org/pdf/2510.09033) shows internal states mainly encode **knowledge recall,
not truthfulness**: they cleanly flag *unassociated* confabulation (no parametric grounding) but
**not** *associated* errors (learned spurious correlations look identical to fact internally). Our own
toy confirms the failure mode direction: `probe_seeinthebox.py` on Qwen2.5-0.5B scored **de-glossed
AUROC 0.53–0.65 vs glossed 1.000** — at 0.5B the arithmetic-truth representation isn't linearly
present, so the probe would read the gloss, not honesty.

**Design consequence → a dual verifier.** The probe is a *partial* honesty oracle. Pair it with the
**output-side** verifier the Spiral already owns (execution / proof / citation). Each covers the
other's blind spot: the probe catches confident-but-ungrounded (unassociated) confabulation the output
check can't see pre-emptively; the exec/citation check catches associated errors the probe can't
distinguish. Honesty is accepted only when **both** pass.

## 3. Architecture pillars (each rented + grounded, per the blueprint)

| Pillar | Choice | Fresh grounding | Owned or rented |
|---|---|---|---|
| Reasoning base | Ouro **LoopLM** recurrent-depth (weight-tied, Q-exit) | [2510.25741](https://arxiv.org/abs/2510.25741) | rented (open weights) |
| Loop stability | **STARS** Jacobian-spectral-radius reg. (depth-collapse fix) | [2605.26733](https://arxiv.org/abs/2605.26733) | rented method |
| Loop caveat | readout blind spot under dense supervision — governs where we read the probe | [2606.24898](https://arxiv.org/pdf/2606.24898) | caveat |
| Serving artifact | **ternary W1.58A8** via BitDistill 3-stage QAT | [2510.13998](https://arxiv.org/pdf/2510.13998) · [2502.11895](https://arxiv.org/abs/2502.11895) | rented method (ADR-0026) |
| Objective | honesty-native: **ternary abstention reward** + SFT→DPO | [2511.11500](https://arxiv.org/abs/2511.11500) · [2604.03904](https://arxiv.org/pdf/2604.03904) | **owned framing** |
| **Honesty verifier** | mid-layer probe as **held-out, rotating, off-gradient** audit | [2606.02628](https://arxiv.org/abs/2606.02628) + caveat [2510.09033](https://arxiv.org/pdf/2510.09033) | **OWNED** (the moat) |
| Training signal | verified-experience only; RLVR incentivizes correct reasoning, generalizes | [2506.14245](https://arxiv.org/abs/2506.14245) · [2512.20760](https://arxiv.org/pdf/2512.20760) | **owned corpus** |
| Data | convergence records + PR/session mining + arXiv/patent grounding | v1.10 issues #2841–#2848 | **OWNED** |

**Ternary-survival is an honest open gap.** [2606.02628](https://arxiv.org/abs/2606.02628) confirms the
probe survives **4-bit**; it does **not** confirm **1.58-bit ternary**. Re-validating the probe on the
ternary serving artifact is a named acceptance test, not an assumption.

## 4. Freedom to operate — read as an inventor

Fresh patent inspection (2026):

- **US 12,468,899 B2** (Adobe, priority 2023-05-08) — a "hallucination gatekeeper" that checks facts
  by **string-match + edit-distance on the OUTPUT text**, regenerating on miss. Explicitly *not*
  hidden-state / white-box. Claim language: *"…checks the natural language insight to ensure that each
  fact… is located in the natural language insight."*
- **CN 121119086 B** — three-level `confident / uncertain / uncorrelated` scoring with corrective
  retrieval flow. Also **output-level** only.

**Inventor read.** The public patents cover *output-level* fact-grounding; **white-box truthfulness
probing is unclaimed by them.** The probe *technique* itself is academic prior art
([2606.02628](https://arxiv.org/abs/2606.02628) et al.), so it is not novel in isolation. Any
defensible novelty is the **system combination** — a rotating, off-gradient internal-honesty probe
used as a *held-out verifier* gating a distillation loop trained on *self-minted, dual-verified*
convergence data — which mirrors the Spiral's stance that *the moat is the system, not the model*.
(Worldwide FTO needs the EPO OPS key noted in the patent-sources memo; this is a first pass, not a
legal opinion.)

## 5. The two traps this design must not repeat

1. **Goodhart on the probe.** The instant the probe becomes a *training loss*, the student learns to
   fool it (the trained-gamer risk in `docs/SIGMA0-MODEL-DESIGN.md` §7.2). The probe stays **off the
   gradient path** — a held-out audit, ideally **re-trained fresh** after each student version so the
   student can't pre-empt a detector that didn't exist when it trained.
2. **Convergence ≠ truth.** A council can converge, confidently, on garbage. Only records whose
   converged answer passed a *real* verifier (execution / proof / citation) become training targets —
   never agreement alone. Gekhman ([2405.05904], cited in the Spiral) shows SFT on unverified data
   raises hallucination.

## 6. The phase map (operator-approved 2026-07-22; replaces the old proof-gate list)

**Rulings recorded** (see [survey §5](research/2026-07-22-frontier-build-test-survey.md) and the
ADR-0024 amendment): **G1 compromise approved** — exec-verification is the non-negotiable *gate* on
every training target; on-policy logit distillation is permitted as the *transport* for the
student/serving tier only. **ADR-0024 Phase-3 (from-scratch frontier) retired** to research-option.
The program is now a **post-training program on open weights**, shaped like the 2026 standard stack
(survey §1/§1b), with our dual verifier bolted on where the labs put their reward oracle.

### Phase V0 — Foundations (no training; the hard preconditions)
*Everything here is cheap, parallel, and blocks everything below.*
- **Eval power** (survey G5): build the honesty eval to **≥140 held-out de-glossed negatives**
  (±5pp resolution; ~203 for ±3pp per SIGMA0-MODEL-DESIGN), pre-registered protocol, 13-gram
  decontamination extended to honesty sets. Add the **gates-off arm** (G11) to the harness.
- **Corpus** (issues [#2842](https://github.com/alex-place/lantern-os/issues/2842)/[#2843](https://github.com/alex-place/lantern-os/issues/2843),
  survey G3/G4): mine all 243 sessions + full PR history (incl. reverts) into both-class records;
  de-gloss lint; MinHash dedup + perplexity filter; **anchor mix ≥60% general data in every future
  train**; LOSO splits.
- **Probe re-validation** (issue [#2845](https://github.com/alex-place/lantern-os/issues/2845)):
  scale ladder 1.4B → 7B, de-glossed, *including* an associated-hallucination set per
  [2510.09033](https://arxiv.org/pdf/2510.09033).
- **Kill-gate V0:** if the de-glossed probe never clears **AUROC ≥ 0.75** at any affordable open
  scale, the white-box audit is demoted from verifier to telemetry and §2 is redesigned.

  **RESULT (2026-07-22, MEASURED — GATE PASSED).** `probe_ladder.py` over the frozen de-glossed
  set (`data/eval/v1_10/probe-sets-v1.jsonl`, 294 rows), 5-fold CV AUROC, best over
  layer×{mean,last}:

  | family | 0.5B | 1.5B | 7B (4-bit NF4) |
  |---|---|---|---|
  | **factual** (recall-truth) | 0.837 | 0.980 | **1.000** |
  | **assoc** (associated misconception — [2510.09033] hard case) | 0.703 | 0.774 | **0.924** |
  | arith (control) | 0.747 | 0.869 | 0.901 |

  Findings: (1) **reproduces [2606.02628] on our hardware** — factual truth linearly decodable at
  1.000 on a 4-bit 7B, peak in the mid-to-late band (L17–23), last-token pooling ≥ mean. (2) **The
  associated-hallucination pessimism is scale-dependent, not fundamental:** the split [2510.09033]
  said was internally invisible climbs 0.70→0.77→**0.92** — at 7B the probe reads associated-claim
  truth strongly. **The white-box audit is a viable verifier at the 7B teacher scale.** (3) Dual
  verifier still stands: at ≤1.5B `assoc` is weak, so the output-side check remains load-bearing
  for the small serving tier. **Open acceptance test unchanged:** confirmed at **4-bit**, not yet
  at **1.58-bit ternary** (V3).

### Phase V1 — Honest teacher (first spend; open weights, 7B-class)
- De-glossed SFT (anchored mix) → **DPO on honesty preferences** (assert/abstain pairs from the
  both-class corpus). muP-style lr transfer (G6) — no hand-tuned lr.
- **Kill-gate V1:** beats base on confabulation at equal golden accuracy on the powered eval, CI
  excluding zero, gates-off arm reported. Fail → stop; the thesis is refuted cheaply.

### Phase V2 — Verifier-rewarded RL (the owned stage; the dose-response proof)
- GRPO/RLVR where the **reward oracle is the dual verifier**: exec/citation output check +
  abstention-aware ternary reward (+1 correct / 0 abstain / −λ error,
  [2511.11500](https://arxiv.org/abs/2511.11500)). The **probe stays off-gradient** — audit only,
  re-trained per candidate (anti-Goodhart).
- Run the **Arm A (imitation) vs Arm B (verified) dose-response** here
  (issue [#2847](https://github.com/alex-place/lantern-os/issues/2847)).
- **Kill-gate V2:** Arm B beats Arm A with a lead that *grows* with verified-data dose. Flat or
  shrinking → the verified-data moat thesis is dead; say so and stop.

### Phase V3 — Consolidate & distill to the serving tier (G1 compromise applied)
- **On-policy distillation** (the approved transport; DeepSeek-V4/Qwen3 shape) from the V2 teacher
  into the student (1.4B–4B class), anchored mix, every training target still exec/citation-gated.
- Student passes the **probe audit** (internal honesty) and converts to the **ternary artifact**
  (ADR-0026); named acceptance test: the probe must survive ternary quantization
  ([2606.02628](https://arxiv.org/abs/2606.02628) only proves 4-bit).
- Ships with a **model card** (G7): powered-eval results, gates-off results, known regressions
  stated plainly.

### Phase V4 — research option, unfunded (the retired from-scratch tier)
- Reopened only on evidence from V1–V3 that a pretraining-level intervention is *necessary* (e.g.
  the honesty property provably cannot be instilled post-hoc), per the ADR-0024 amendment.

**Sequencing:** V0 now; V1 after V0's gates; V2 after V1; V3 after V2's curve is positive. Each
phase emits ConvergenceRecords either way — honest nulls included.

Toy harness: `experiments/v1_10_toy/` (PR #2849). Full design tracked as epic
[#2841](https://github.com/alex-place/lantern-os/issues/2841).

## 6b. Citation grounding (full-text verified)
All external claims in this doc were verified against full source text on 2026-07-22 — see the
**[grounding ledger + patent landscape](research/2026-07-22-grounding-ledger-and-patent-landscape.md)**
(33/40 citations held exactly, 7 overstatements corrected, 0 fabricated). The two load-bearing ones
held: **2606.02628** (probe 0.904–1.000 on 4-bit 7–8B) and **2510.09033** (associated-hallucination
detection near-random) — with the scope note that their "AH" (Wikidata associations) differs from our
probe-ladder `assoc` set (misconceptions), so the two are complementary, not contradictory.

## 7. Related
- **[SIGMA0-OURO-CODER.md](SIGMA0-OURO-CODER.md)** — the coding-axis twin (the Spiral; verifier-gated
  cascade + VTD). This doc is its honesty-axis counterpart; both share the "verifier > scale" moat.
- [ADR-0024](adr/0024-sigma0-frontier-training-program.md) (frontier training program) ·
  [ADR-0026](adr/0026-ternary-serving-artifact-distillation-target.md) (ternary serving) ·
  [ADR-0021](adr/0021-serving-substrate-retain-ouro-custom-loop.md) (Ouro loop).
- [docs/SIGMA0-MODEL-DESIGN.md](SIGMA0-MODEL-DESIGN.md) (the honesty corpus / E1 de-gloss) ·
  [docs/AGI-CONVERGENCE-BLUEPRINT.md](AGI-CONVERGENCE-BLUEPRINT.md) (rent-capability / own-grounding).
- Epic [#2841](https://github.com/alex-place/lantern-os/issues/2841) + children #2842–#2848.
