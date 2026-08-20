# Human review packet — the two `UNVERIFIED` ideas

**Date:** 2026-08-20. The audit left two of sixteen milled ideas as `UNVERIFIED` — meaning it
could not place them, which by design is not a novelty claim. This is the search prep for the
human call, done by hand with live web search because the machine could not close either one.

**Finding: neither is novel. Both were placed in about two queries each.**

---

## A7 — Modular Verification Head Addition

> Attach a lightweight verification head to a frozen small model to explicitly score reasoning
> step correctness, enabling iterative refinement without full retraining.
> *cost: low · BTL 0.0067 (2/8 wins, ranked 7th of 8) · audit: UNVERIFIED, 40 hits searched*

**Prior art.** [UHeads — "Reasoning with Confidence: Efficient Verification of LLM Reasoning Steps
via Uncertainty Heads"](https://openreview.net/forum?id=svQuvBYaCA) (ICLR 2026 submission) trains
transformer uncertainty heads on the internal states of a **frozen** LLM to estimate the
uncertainty of its reasoning steps during generation, with target labels generated either by a
larger LLM or self-supervised by the model itself. That is A7's mechanism, A7's frozen-base
setup, and A7's label source. Adjacent: [CLUE](https://arxiv.org/pdf/2510.01591) (non-parametric
verification via hidden-state clustering), [one-token
verification](https://arxiv.org/html/2603.01025), [VerifiAgent](https://arxiv.org/pdf/2504.00406).

**Suggested verdict: `PORT`.** Not a discovery.

**But it may still be worth running, for a different reason.** It is the cheapest item on either
list, and we already have an answer-level verified cascade (ADR-0030, live, 0% escalation on a
strong cheap tier). The real question A7 asks — once you strip the novelty framing — is whether a
**step-level** head beats our **answer-level** cascade on our own stack. That is a comparison
against something we own, not a claim on the literature, and it is the kind of thing our harness
can actually settle.

---

## A6 — Sparse Expert Routing via Frontier API Feedback

> Use a frontier API to identify reasoning subtask clusters, then train a small model with sparse
> expert modules specialised per cluster, routing inputs accordingly.
> *cost: high · BTL 0.0147 (3/8 wins, ranked 6th of 8) · audit: UNVERIFIED, 63 hits searched*

**Prior art.** "Cluster the data into skills, train a per-cluster expert adapter, route at
inference" is a populated field:

- [ELREA](https://arxiv.org/pdf/2502.00089) clusters domain data by gradient direction, trains an
  expert adapter per cluster, and combines them at inference by gradient-aligned routing
- [GradientSpace](https://arxiv.org/pdf/2512.06678) trains a lightweight router that assigns each
  input to the right per-cluster LoRA adapter
- [MoIN](https://arxiv.org/pdf/2410.09687) clusters the training set by embedding and routes a
  query by nearest-neighbour search over topic embeddings
- [Scaling Expert LMs with Unsupervised Domain Discovery](https://arxiv.org/pdf/2303.14177),
  HC-SMoE (hierarchical clustering of experts post-training)

The only thing A6 varies is **who does the clustering** — a frontier API rather than gradients or
embeddings. That is a data-preparation choice, not a mechanism, and nothing in the proposal says
why API-derived clusters would route better than gradient- or embedding-derived ones.

**Suggested verdict: `PORT` at best.** Highest cost on the list, weakest ranking, no mechanism of
its own. **Recommend dropping it.**

---

## What this means for the batch

Sixteen ideas were milled across two goals. After the audit and this review: **zero are novel.**
Fourteen were placed by the machine (`ANSWERED-HERE`, `RESTATES`, `PORT`, `INCREMENTAL`), and the
two it could not place were placed by hand in four queries total.

That is the strongest evidence yet for the thing the audit was built to say: `UNVERIFIED` means
*the machine could not place it*, and on this batch **every single one of those turned out to be
encumbered**. Two for two, on top of the two for two in the original red team. Nothing has yet
come out of this mill that a search could not place.

The mill's value, then, is not invention. It is **coverage** — it surfaces the shape of the
design space and attaches the prior art, which is a real service for choosing what to run. Calling
it an idea generator would be the same category error as reading silence as novelty.

## Recorded so the machine inherits it

This file is indexed by `priorwork.js`, so the next audit that sees a verification-head or
cluster-routing idea will find these findings as prior work rather than rediscovering them. That
is the loop the red team asked for: a finding that lives only in a chat transcript gets found
again; one in the notebook does not.

---

## Second review (same day): the gap mill's survivors

`gapmill.js` re-ran goal B with retrieved work and our own notebook as EXCLUSION lists, the field
mapped into design axes first, and the audit in the loop rejecting its own proposals. Two of seven
survived. Both were hand-checked with live search, same as above.

**1. Null-World Activation Divergence for Per-Token Hallucination** — *audit said INCREMENTAL vs
our own `auditor.py`.*
**Prior art is stronger than the audit found.** [Entropy Distribution as a Fingerprint for
Hallucinations](https://arxiv.org/html/2605.28264) builds a reference CDF from non-hallucinated
calibration data and tests whether a new generation is statistically consistent with it — that is
the null-model control, already done. Adjacent: [internal attention divergence
signals](https://arxiv.org/html/2605.05025), [activation-based detection
asymmetry](https://arxiv.org/pdf/2604.13068), calibrated hidden-state probes for real-time
intervention. **Suggested verdict: `PORT`.**

**2. Live Prediction Market Disagreement as Internal Activation Signal** — *audit said UNVERIFIED,
63 hits searched.*
Every component exists separately. [KalshiBench](https://arxiv.org/html/2512.16030) uses
prediction markets to evaluate epistemic calibration; the [Beta-Bernoulli
Calibrator](https://arxiv.org/pdf/2605.27668) uses human forecasts as distributional supervision;
[HINDCAST](https://arxiv.org/pdf/2607.14051) scores against market-implied probabilities;
PolySwarm uses model disagreement as an uncertainty filter. What I could not find in two queries
is the specific combination: **market-implied disagreement as the training label for a hidden-state
probe.** Everything above calibrates or evaluates *outputs*.

**This is the first idea in 23 milled that two searches could not place.** By the rules this
project runs on that is still not a novelty claim — two queries is not a prior-art search, and the
"markets as ground truth for LLM epistemics" space is visibly active. But it is a different
category from the previous survivors, and it is worth noticing *why*: it is the only one that
requires an asset the field does not have — our own settled market outcomes. That is exactly what
the assets exclusion list was built to produce.

**Suggested verdict: worth one bounded day**, framed as "does market-implied uncertainty supervise
a hidden-state probe better than the labels we already use", not as a discovery.

---

## Third review (same day): the four-leg mill with the technical gate

`gapmill.js` now requires every idea to state a technical problem, specific means, and a
MEASURABLE effect (a number with a unit), and the audit's live search includes a patent leg.
Run on goal B: 8 proposed, 5 placed during milling, 3 survived. Hand review with live search:

**1. Ledger-conditioned sparse activation sampling** — audit said `INCREMENTAL` vs our own
`sigma0_hneurons_probe.py`, and that is right: it is a compute optimisation of our probe
(read ~20% of neurons, chosen by ledger priors) with a stated effect (−75% read FLOPs at ≤2pt
AUROC). Legitimate engineering ticket on our own stack. Not novel, plausibly worth a day.

**2. Ledger-guided online calibration via trading-outcome feedback** — audit `UNVERIFIED` after
155 hits. Hand search places the NEIGHBOURHOOD firmly: online recalibration is a known framework
([1607.03594](https://arxiv.org/pdf/1607.03594)), verbalized-confidence calibration is settled
([2305.14975](https://arxiv.org/abs/2305.14975)), and there is a **granted US patent on
post-calibration of LLM confidence scoring**
([US12032919](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12032919)) — found
BY the hand search, which is exactly what the patent leg exists to surface. The unplaced residue
is the same one as the second review: **live settled market/trading outcomes as the continuous
ground-truth stream calibrating INTERNAL signals**. This family has now survived two independent
mill runs and two hand reviews. Still not a novelty claim — but it is the only idea in 30+ milled
that keeps surviving, and it survives because it needs our asset.

**3. Cross-modal activation alignment** — audit `UNVERIFIED` after 134 hits; hand search places
it in one query: [DHCP](https://arxiv.org/pdf/2411.18659) detects hallucinations from cross-modal
attention patterns token-level; CLAP probes cross-layer activations; a full survey exists
([2507.19024](https://arxiv.org/html/2507.19024v2)). **`PORT` at best.** Also the weakest fit for
us: we serve no multimodal model in production.

**Running tally: 30+ ideas milled, zero clear novelty claims.** One family (market-outcome
supervision of internal signals) unplaced twice. The technical gate did its job visibly — every
survivor states a falsifiable, unit-bearing effect, which is what turns even the non-novel ones
into runnable engineering tickets rather than prose.
