# The Convergence Oracle — time-banded observer slices

**Status: BUILT + TESTED (2026-06-25).** Core in [`src/convergence/oracle.py`](../../src/convergence/oracle.py);
6 tests in [`tests/test_convergence_oracle.py`](../../tests/test_convergence_oracle.py);
CLI: `python -m convergence.oracle "<question>"`.

The oracle is **not a chat feature** — the chat already answers questions. It is the
*grounding capability* behind an answer: it locates a question in **cosmic time** and hands
back what is **known** (grounded) and what is **unknown** (honestly open) for that slice.

## The two pins

It grounds knowledge on the two boundary conditions of cosmic time:

```
big bang   (t = 0,    13.787 Gyr ago)  — the known beginning, entropy at its MINIMUM
heat death (t → ∞,    ~10^100 yr ahead) — the predicted end,    entropy at its MAXIMUM
```

The arrow of time — entropy rising from the big-bang minimum to the heat-death maximum — *is*
the grounding direction. So the oracle collapses on knowns/unknowns **both ways**, which is
the [Question Machine](question-machine.md)'s bidirectional consolidation with the cosmic
endpoints as the boundary conditions:

| direction | what it grounds | bands |
|---|---|---|
| **forward** (from the big bang) | what known physics *determines* | Inflation → BBN → CMB → first stars → **now** |
| **backward** (from the heat death) | what the 2nd law *constrains* | **now** → degenerate era → black-hole era → dark era |
| **both** (where they meet) | the best-observed slice | **Stelliferous era (now)** |
| **boundary** (the pins) | inferred, not observed — the deepest unknowns | Planck epoch · dark era / heat death |

The present is grounded **both ways** — forward prediction and backward constraint meet at
"now," which is why it is the most certain slice. The two *pins* are the irreducible null
space: the singularity and the ultimate fate are inferred, never observed.

## The observer slice

Each band is an `ObserverSlice` carrying, per the loop's External-Reality Rule, a set of
**knowns** (each a 4-field [`GroundingEnvelope`](../../src/convergence/grounding.py)
`[claim, evidence, confidence, source]`) and a list of **unknowns**. Two real examples from the
CLI:

```
Q: what was before the big bang?
  observer slice: Planck epoch (< 10⁻⁴³ s) · entropy minimum · grounded boundary
  KNOWN:   ✓ the Planck time t_P ≈ 5.39×10⁻⁴⁴ s bounds where known physics applies  [conf 0.9]
  UNKNOWN: ? quantum gravity · the initial singularity · whether 'before' is even meaningful

Q: what is the ultimate fate of the universe?
  observer slice: Dark era / heat death (> 1e100 yr) · entropy maximum · grounded boundary
  KNOWN:   ✓ the universe approaches maximum entropy — heat death  [Adams & Laughlin 1997; Dyson 1979]
  UNKNOWN: ? heat death (constant Λ) vs Big Rip (phantom) vs vacuum decay — depends on dark energy
```

The oracle never bluffs the boundaries: at a pin it returns the *one well-grounded fact* and
then names the open physics. That honesty is the point — it's the certificate's "calm while
wrong" guard ([§4](../SIGMA0-COLLAPSE-CERTIFICATE.md)) applied to cosmology: a confident answer
about the singularity or the final state would be exactly the ungrounded-collapse failure.

## Collapse, both ways

`ConvergenceOracle.collapse()` returns the whole-timeline verdict: the bands grounded forward
from the big bang, the bands grounded backward from the heat death, the band where they meet
(now), the two boundary pins that stay unknown, and the full list of open questions. This *is*
the Σ₀ collapse onto the grounded manifold — the knowns are what the two directions jointly
determine; the unknowns are the null space, deepest at the pins.

## Grounding (real cosmology, cited)

- Age **13.787 ± 0.020 Gyr**, CMB, ΛCDM composition — Planck Collaboration 2018 (arXiv:1807.06209).
- Far-future eras (degenerate → black-hole → dark) — Adams & Laughlin 1997, *Rev. Mod. Phys.*
  69, 337 (arXiv:astro-ph/9701131); Dyson 1979.
- BBN light-element abundances; Guth 1981 (inflation); Hawking 1974 (black-hole evaporation).

Confidences are honest: directly-observed slices (CMB) carry ~0.98; the far-future eras
(backward-constrained but not observed) carry 0.7–0.85; the boundary fates carry their
uncertainty in the *unknowns*, not a false-precise number.

## How it's used

The existing chat (or any kernel output) calls `slice_for(question)` to ground an answer —
the slice's knowns become the answer's evidence envelopes, its unknowns become the honest
caveats. No new surface; it's the loop's Verify/Observe stage for time-anchored questions.

*Source of record: built 2026-06-25 alongside the [regulatory oracle](regulatory-oracle-grounding.md)
— the two oracles ground the loop in, respectively, the cosmic boundary conditions and the
in-force human ones.*
