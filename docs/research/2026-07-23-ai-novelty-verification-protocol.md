# AI Novelty Verification — Protocol and Literature Grounding (2026-07-23)

**Status:** protocol adopted; worked example completed the same day.
**Doctrine:** *effectively known until proven novel* — the mirror of the loop's
effectively-false-until-true. An AI novelty verdict is a first-pass filter, never a certificate.

## 1. Why — the traps, each grounded

AI novelty verification fails in known, measured ways. Each trap below is tied to external
literature (all IDs verified against arxiv.org and/or `F:/arxiv-corpus` on 2026-07-23) and to the
live failure we caught in-repo the same day.

| Trap | External grounding | Our live instance |
|---|---|---|
| **False novelty** — repackaged concepts graded original | No single metric satisfies the novelty axioms; the best individual metric hits 71.5% vs 90.1% for a per-axiom ensemble of architecturally diverse metrics (arXiv:2604.15145, Liu & Zhai 2026) | First clearance graded "incremental"; the ensemble of audits demoted it further (§4) |
| **Surface metrics miss structural echoes** — same design under different vocabulary | Semantic (not reconstruction/lexical) error is the reliable novelty criterion (arXiv:2108.10851); novelty is *relative neighbor density*, not raw embedding distance (arXiv:2503.01508 — RND, AUROC 0.820 CS / 0.765 biomed, domain-invariant where LLM judges degrade) | The killing prior art (Korf 1985, Luby 1993, Zilberstein) lives under classical vocabulary — "iterative deepening / anytime / contract algorithms" — invisible to modern-LLM-corpus search |
| **Coverage gaps** — papers-only search | Patent novelty needs claim↔prior-art *correspondence* checking, which generative models can do but classifiers can't (arXiv:2502.06316, Ikoma & Mitamura 2025) | First clearance searched zero patent databases; patent sweep added as a standing audit |
| **Fabricated citations** — the trap *behind* the traps | arXiv now bans authors 1 year for hallucinated references (policy announced 2026-05-14, Dietterich; hallucinated refs in ~1/277 submissions, 20% of sampled ICLR-2026 papers had ≥1); multi-agent detection frameworks exist (arXiv:2605.08583) | 11 load-bearing IDs audited: all real, but one name ("LSRL") did not exist and one characterization (RLTT "verifier at training time") was wrong — real papers, drifted claims |
| **No human validation** | Expert examiners remain the decision layer in the patent study (arXiv:2502.06316); human+LLM *collaborative* pipelines outperform either alone (arXiv:2507.11330, Wu et al., JASIST 2025) | Operator ratification is the final gate (ADR approval discipline); verdict vocabulary capped below "novel" until then |

## 2. The protocol

1. **Decompose** the idea into functional atoms (claim-style), per the patent-examiner workflow
   (arXiv:2502.06316). A verdict on the undecomposed idea is not admissible.
2. **Per-atom prior-art table** — each atom gets its own citations with an explicit overlap
   statement. Every atom published ⇒ the only possible novelty is the *composition*.
3. **Structural search beyond the home literature** — deliberately query *other vocabularies*:
   classical algorithms (iterative deepening, anytime/contract algorithms, restart schedules,
   cascades/reject rules), adjacent fields, and patents. This is the RND lesson
   (arXiv:2503.01508): compute the density of the *whole* neighborhood, not the distance to the
   nearest modern paper.
4. **Citation authenticity audit** — verify every load-bearing ID resolves (local corpus, then
   arxiv.org) *and* that the paper says what the clearance claims it says. Title-match is not
   claim-match (our RLTT case). This is the arXiv-ban standard applied to ourselves.
5. **Adversarial refutation** — an independent pass whose brief is to *kill* the novelty claim
   and the supporting math. Diversity of lens, not repetition, is what raises ensemble accuracy
   (arXiv:2604.15145).
6. **Verdict vocabulary (capped):** `breakthrough` — forbidden from AI passes entirely;
   `novel-synthesis` / `incremental` / `known-repackaged` — AI-assignable; plus
   **`empirical-instantiation`**: the algorithm is known but the *measurement* on our substrate
   is absent — a legitimate, publishable residue that must never be dressed as an algorithmic
   contribution.
7. **Human ratification** — the operator ratifies the final grade; docs may not carry a novelty
   claim above `candidate-novel (seam_open)` before that, and never above the ratified grade
   after.

## 3. Grounding table

| Protocol step | Literature support (verified) |
|---|---|
| Decomposition | arXiv:2502.06316 |
| Diverse-ensemble verdicts | arXiv:2604.15145 (90.1% ensemble vs 71.5% single) |
| Structural-not-lexical search | arXiv:2108.10851; arXiv:2503.01508 |
| Citation authenticity | arXiv policy 2026-05-14; arXiv:2605.08583 |
| Human+AI collaboration | arXiv:2507.11330; arXiv:2502.06316 |

All six items resolved on 2026-07-23; none of the pasted search-snippet claims had to be taken on
faith. (The "Relative Neighbor Density" and "Automated Novelty Evaluation" items arrived without
IDs and were resolved to 2503.01508 and 2507.11330 by search.)

## 4. Worked example — the depth-escalation clearance (same day)

**Idea assessed:** use an external correctness verifier as the inference-time deferral rule that
buys more recurrence depth (R4→R8→R16) on one shared weight-tied looped model — a cascade whose
tiers are depths, not models.

- **Pass 1 (modern-LLM clearance, 14-entry prior-art table):** graded `incremental`; sliver = "no
  single paper reports this exact inference-time wiring." Correctly resisted the self-speculative
  decoding surface match (their "verify" is lossless distributional equality for speed, not
  external correctness).
- **Pass 2 (adversarial refutation):** upheld `incremental`; separately collapsed the *economic*
  headline (mediant non-dominance; regime sandwich; measured depth plateau at ~2 loops).
- **Pass 3 (trap audits):** citations — all real, two claim-drift nits. Classical-CS structural
  audit — **sliver killed**: the composition is Korf 1985 depth-first iterative deepening (same
  procedure, deeper cutoff, external goal test, geometric amortization), Luby–Sinclair–Zuckerman
  1993 (provably *optimal* escalating-budget schedules for generate-then-externally-verify),
  Hansen–Zilberstein monitored anytime stopping (the deferral rule, DP-optimal), and in the LLM
  era Reflexion/Self-Debugging and AlphaCode/CodeT (same weights, exec-verifier buys more
  compute). Patent sweep (manual, free surfaces): **corroborates the kill** — Intel
  US11869232B2 (2024) claims "an exit determination as to whether an output of the first subset
  of layers satisfies one or more exit criteria," selectively bypassing (equivalently:
  continuing) deeper layers, with speculative deep execution while pending; with US12217172B2
  (adaptive off-ramps) and US20220358358 (dynamic early exits), criterion-gated depth
  continuation is anticipated at patent-claim generality. *Coverage limits:* free-surface
  search only (Google Patents snippets/USPTO); no examiner-grade claim charts, no EPO OPS
  family search — sufficient here only because the classical-CS audit had already killed the
  sliver independently.
- **Final grade:** `known-repackaged` (algorithm) + `empirical-instantiation` (the depth-rescue
  profile of a looped LM under an external verifier is unmeasured — a measurement claim only).
- **What survived untouched:** the *deployment* argument — depth escalation is the only ΔRAM=0
  local escalation axis on an 8GB box — which never depended on novelty, and which now imports
  30 years of optimality theory (Luby schedules, Hansen–Zilberstein monitoring) instead of
  deriving its own.

The example is the protocol's own justification: a disciplined single AI pass *still* overstated
by exactly one trap (structural echo under foreign vocabulary), and the ensemble caught it.

## 5. Limits

- **Novelty is falsifiable, never provable.** Every verdict is "no anticipation found within the
  searched coverage"; coverage is always partial (non-English literature, unindexed industry
  systems, unpublished internal work).
- **Patent coverage is shallow** without professional search tooling; free surfaces (Google
  Patents, EPO OPS) miss claim-family breadth. A `seam_open` grade must state what was *not*
  searched.
- **The verifier can drift even on real citations** — title-match ≠ claim-match; step 4 exists
  because our own pass attached a wrong mechanism to a real paper.
- **Ensemble ≠ oracle.** 90.1% (arXiv:2604.15145) is the *measured ceiling* of the best current
  ensemble on their benchmark — one in ten verdicts is still wrong. Hence the human gate.
