# The Convergence Certificate, in plain English

*What we built, what it actually proves, and what it doesn't. This is the human-readable front
door to [SIGMA0-COLLAPSE-CERTIFICATE.md](SIGMA0-COLLAPSE-CERTIFICATE.md), which is the full
technical record and is not written to be read top-to-bottom.*

---

## The problem we were trying to solve

We want a reasoning system that improves itself — it thinks, acts, checks its work, and learns
from the result, over and over. The risk with any self-improving loop is obvious once you say it
out loud: **a system that learns from its own output can talk itself into anything.** It can
grow more confident without growing more correct. Left alone, it either collapses onto a single
confident wrong answer, or it drifts off into noise.

We wanted a way to *measure* whether that is happening, from the inside, before it is obvious
from the outside. That measurement is what we call the certificate.

## What the certificate is

It is a number you can compute from the system's own internal state while it runs, and a rule
for what to do when the number goes bad.

The idea comes from control engineering. Any loop that feeds its output back into its input has
a quantity that says whether small errors shrink or grow on each pass. If errors shrink, the loop
settles. If they grow, it runs away. We compute that quantity for the model's hidden state on
every pass, and we call it the **collapse certificate**.

- If the number says errors are shrinking **toward a single point**, the system is converging —
  but it may be converging on something wrong. That is the dangerous case, because it *looks*
  like confidence.
- If the number says errors are growing, the system is diverging.
- Either way, the certificate fires, and the rule is the same: **stop trusting yourself and go
  check against something outside the loop.**

That last line is the whole result. We proved (in a specific, limited mathematical setting,
spelled out below) that **the only reliable escape from collapse is contact with something
external** — running the test, checking the source, placing the bet and seeing it settle. No
amount of internal self-checking substitutes for it. We checked this by simulation and the
simulation agreed: an internal signal helps you notice *gross* degradation, and it cannot
replace fresh external data at all when you are deciding what to keep.

## What is actually proven versus what is a guess

This is the part that matters most and the part the long document buries. There are eleven
named results. Here is their honest status in one table:

| | Result | Status | What that means |
|---|---|---|---|
| 1 | The collapse guarantee | **Proven** (checked by code, in its stated setting) | If the number says "contracting," the state really does settle. |
| 2 | Canary thresholds for non-normal systems | Conjecture, built on an imported theorem | We think we know how to set alarm thresholds when the system has transient growth. Not proven. |
| 3 | "No free confidence" | Conjecture | You cannot gain real confidence from reasoning alone; it has to come from evidence. Plausible, unproven. |
| 4 | Re-grounding cadence | Conjecture, imported formula | A rule for how often to check reality, borrowed from inventory theory. |
| 5 | Indistinguishability | **Refuted** as stated, survives as a weaker lemma | An earlier claim was wrong; the corrected version stands. |
| 6 | Grounding allocation | Conjecture, imported formula | How to spread limited checking across many questions. |
| 7 | The "lasing" threshold | Conjecture | When self-reinforcement runs away. Named by analogy, not proven. |
| 8 | Anytime-valid stopping | Imported | A standard statistical tool. We did not invent it. |
| 9 | Basin determinism | Conjecture, low confidence | Whether the same start always ends in the same place. |
| 10 | The oracle objective | Definition | Not a result; a statement of what we are optimising. |
| 11 | The fix-rate ratchet | Measured, live | The one thing measured on the running system. |

**One proven result. Six conjectures. One refuted. Three things that are not results at all.**
That is the actual state of the mathematics. The long document does say this — but it says it
across 28,000 words with a bold phrase every 40 of them, and a reader cannot see the shape.

## The second half: gating weight updates

The first half watches the model's state during a single run. The second half asks a different
question: when the model's *weights* change — when it learns — how do we know the new version is
not worse than the old one?

The answer here is not a theorem. It is a **gate**: before accepting a weight update, the new
model must beat the old one on fresh, externally-verified data it has never seen. Not data it
generated, not data it was trained on. Fresh. The document is explicit that this is borrowed
practice (it names the standard sources), and that the gate has never yet controlled a real
training run. It is tested logic, not a proven guarantee.

The load-bearing problem, which the document names correctly and does not solve: **if the
held-out data is reused, the gate quietly stops working,** because the model starts fitting the
gate instead of the world. The document calls this "holdout theater." It is a real problem and
it is open.

## What this has to do with "the machine"

The honest answer is: this is the **safety floor** for the machine, not the machine.

The project's goal is a local model that reasons in a loop — proposes, verifies, escalates,
keeps what survives. The certificate is the part that says *when to stop trusting the loop and go
outside it.* That is necessary. It is not sufficient, and it does not by itself make the model
better at anything. It makes the model **stop** at the right moment. The capability — being good
at judging, being calibrated, knowing when it is out of its depth — is separate work, and the
document's own measurements say most of that is still rented from outside models.

So the one-sentence version: **we built and partly proved a stop signal for a self-improving
loop; the signal works in the setting we proved it in, the only escape it offers is checking
reality, and the loop it protects is not yet the machine.**

## What was found wrong, and when

The document keeps a record of its own failures, which is to its credit. The ones that matter:

- **Fabricated citations (2026-06-17).** An early draft, written while search was down, carried
  four made-up arXiv IDs. They were caught and replaced. The document keeps this on the record
  as evidence for its own central claim: self-generated content is untrustworthy until checked.
- **A retracted headline (2026-07-06).** The claimed honesty-training result was substantially
  an artifact of writing style, not truth. Retracted.
- **A refuted lemma (result 5 above).** Stated too strongly, corrected.
- **A measurement the document assumed and we just refuted (2026-07-27).** Section 9 composes
  the two halves and conditions it on the learning rate being "small enough." It never said how
  small. We found out: the safe learning rate is set by a quantity **neither half of the
  certificate measures** — the fast loop's gain — and the two certificates can both pass while
  the combined system diverges by a factor of a thousand. Details below.

## The newest finding (2026-07-27): the two halves do not compose the way §9 says

§9 says: if the fast half is certified, and the slow half is gated, and the learning rate is
small enough, the whole system is safe. It marks this as a target, not a theorem, and offers no
bound on "small enough."

We built the simplest possible version — a linear fast loop feeding a single slow weight — and
solved for the exact largest safe learning rate. Then we held **both certificates fixed** (the
fast half's spectral radius pinned at 0.9, the slow half's reduced coefficient pinned at −1) and
varied only the fast loop's gain.

| fast-loop gain | what §9 would allow | actual safe limit | overestimate |
|---|---|---|---|
| 1 | 2.0 | 0.97 | 2× |
| 10 | 2.0 | 0.17 | 12× |
| 100 | 2.0 | 0.019 | 106× |
| 1000 | 2.0 | 0.0019 | **1054×** |

Both certificates returned the same verdict on every row. The true limit fell by three orders of
magnitude. **The composition is not a function of the two verdicts.** The mechanism is
cancellation: the slow half's coefficient can look tame because a direct term cancels a large
gain, and the slow gate only sees the sum.

We also tested the obvious wrong explanation first — that transient growth (the thing §1.2 warns
about) was the cause. It is not; the effect is identical on a perfectly well-behaved system.
That refutation is recorded as a gate in the experiment so it cannot be quietly dropped.

Scope: linear, one slow variable. This is a counterexample to sufficiency, not a general theorem.
But a bound that fails in the linear case cannot hold in the general one, so §9 as written is
not a target anyone should aim at without adding the gain.

Artifact: [`experiments/sigma0_composition_epsilon_threshold.py`](../experiments/sigma0_composition_epsilon_threshold.py)
— exact, deterministic, no sampling.

## If you read one thing from the long document

Read §1 (the proven result) and §8.4 (the open problem). Everything else is either imported,
conjectured, or commentary on those two.

## Where this goes next

The certificate is the stop signal. What it protects — and the part that actually finds questions
rather than only answers — is the twin machine: one system, two faces built to fail differently,
where one holds the only veto and the veto answers to reality alone.
[TWIN-MACHINE-DESIGN.md](TWIN-MACHINE-DESIGN.md).
