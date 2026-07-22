# Cross-domain incremental backlog — organized by the USER problem it solves

**Date:** 2026-07-22 · **Source:** the cross-domain patent landscape + fresh sources we already
pulled ([grounding ledger](2026-07-22-grounding-ledger-and-patent-landscape.md)). **Rule for this
list:** every item must make the assistant **more trustworthy, cheaper, or better at the user's
task** — if it doesn't map to a user outcome, it's not here.

## The product in one line
A personal AI assistant that runs on your own machine, is honest about what it knows, checks its
own work against reality, and improves at your problems — without cloud cost or data leaving your box.

---

## Problem 1 — "It bluffs or gives up on hard tasks" (make it actually solve, cheaply)

| Update | User payoff | Cross-domain source | Effort |
|---|---|---|---|
| **Stop-on-stall** — halt when N turns make no real progress (+ a cheap state-hash to spot a loop) instead of a fixed guess-limit | doesn't waste your time/compute grinding a dead end; doesn't loop forever | ECC decoders US6518892B2 / US8301987B2 | S |
| **Pass-terminates-immediately** — run the cheapest check on every candidate; a pass ends it, only a fail escalates | fastest/cheapest path to a verified answer | Medical hierarchical assay US6013436A | S |
| **De-escalate when it gets easy** — drop back to the cheap local model when the hard part is over | keeps the cloud bill down over a long session | Intervoice call-routing US7254641B2 | S |
| **Each escalation must actually help or stop** — every "phone a friend" must measurably improve the answer, else halt | no runaway spend on steps that aren't converging | Iterative Learning Control (laser/disk servos) | M |

## Problem 2 — "I can't trust it — it's confident even when wrong" (honesty)

| Update | User payoff | Source | Effort |
|---|---|---|---|
| **Calibrated "I don't know"** — a real abstain boundary + the +1/0/−λ training reward | it tells you when it's unsure instead of bluffing (frontier models basically never do this) | Applied Materials US9715723B2 + Reinforced Hesitation 2511.11500 | M (V1/V2) |
| **Judge from the whole answer, not where it stopped** — aggregate the model's steps into one honest confidence score | the trust signal it shows you is actually calibrated | HP US20120243734A1 | S |
| **Look inside to catch a bluff** — the white-box honesty probe | catches confident-but-ungrounded answers a cloud API physically cannot | our probe work (verified 0.92 AUROC @ 7B) | M (V0 done) |

## Problem 3 — "It repeats mistakes / doesn't learn from me"

| Update | User payoff | Source | Effort |
|---|---|---|---|
| **Remember your recurring failures** — cache failure modes by task-signature and avoid them *before* proposing | stops making the same mistake twice on your kind of work | Marvell disk-drive repeatable-error servo US8094405B1 | M |
| **Learn only from verified wins** — keep the exec-verified solutions as training fuel | it gets better at *your* problems, not generic benchmarks | our VTD flywheel | M |
| **Check a fix actually worked before moving on** — measure the metric recovered, then refine its playbook | it doesn't declare victory on a fix that didn't land | Bowe Bell+Howell remediation US20100094676A1 | M |

## Problem 4 — "It doesn't know when its info is stale" (indefinite low-cost operation)

| Update | User payoff | Source | Effort |
|---|---|---|---|
| **Re-check each fact on its own clock** — frequent for market data, rare for stable facts (the EOQ interval) | stays current where it matters without re-verifying everything (the cost lever) | ops-research replenishment / M2 | M |
| **Leash the cheap self-check to ground truth** — trust the fast check only while it's periodically re-fit against real verification | the cheap path stays honest over a long run | evolutionary-computation surrogate US8131656B2 | S–M |
| **Anytime-valid stop certificate** — a statistical stop-test that stays valid even when it runs indefinitely | it can work on your behalf for long stretches without drifting into nonsense | SEA arXiv:2607.00871 (this week) | M |

## Principles the checks confirmed (keep these, don't drift)
- **Verify against ground truth, never a learned copy of a human's judgment.** IBM US12135927B2 patents the copy-a-human gate; we deliberately do the opposite — a real test decides. That's the novelty *and* the freedom-to-operate safety.
- **The moat is the combination, not any one trick.** Every mechanism above is fielded prior art in some other industry; nobody has wired them onto an LLM that checks itself against reality. That's what we own.

## Recommended first cut (highest user-value per effort)
**P1 → P2 quick wins:** stop-on-stall, pass-terminates, de-escalate, judge-from-whole-answer. These
make the *existing* assistant cheaper and more honest this week. **Then** the EOQ fact-clocks (the
thing that makes "runs indefinitely at low cost" real).
