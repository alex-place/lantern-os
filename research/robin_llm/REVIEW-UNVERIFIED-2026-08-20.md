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
