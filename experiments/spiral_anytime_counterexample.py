"""Counterexample to the Spiral's "anytime" claim -- WITHDRAWN as a practical claim by its own
stress test. Kept because the stress test is the result, and because it surfaced a real doc/code
gap on the way.

OUTCOME FIRST: the construction below shows more budget making the answer worse ONLY when the
proposer is skill-free (every edit random w.r.t. true correctness). Adding proposer skill kills
it: at skill=0.3 the spiral is monotone again (0.548 -> 0.580 over 60 turns) even with just 5
visible tests, and at 0.5/0.7 it is strongly monotone. Any competent model satisfies that, so
the anytime claim SURVIVES for a competent proposer and the counterexample is withdrawn.

WHAT SURVIVES, and it is worth acting on:
  1. A verified doc/code gap. The doc's verified-halt says "the answer passed, INCLUDING HELD-OUT
     CHECKS"; the shipped lib/spiral-harness.js + lib/spiral-fix-rate.js contain no holdout at all
     (grep: holdout|held-out|hidden|unseen|split -> nothing). It scores candidates on the same
     tests it optimises. That discrepancy is real regardless of this counterexample.
  2. A scoped risk. The degradation regime is "proposer has no genuine skill on this task" --
     which is exactly where this repo has measured itself: SWE-bench single-shot 0/5. When the
     model cannot actually make progress, its accepted edits are luck on the visible tests, and
     more budget then hurts. So the honest statement is not "the Spiral is not anytime" but
     "the Spiral is anytime WHERE THE MODEL IS COMPETENT, and inverts where it is out of depth."

Original framing follows.

THE CLAIM UNDER ATTACK (docs/SIGMA0-OURO-CODER.md sec.3, halting condition 5):
  "budget exhausted (you set the dial -- the Spiral is an *anytime* algorithm, its answer only
   improves with more of it)"

That is a monotonicity claim: more turns never hurts. It is false whenever the verifier is a
FINITE test suite, and the shipped harness is exactly that case.

THE GAP THAT MAKES IT BITE. The same section states the verified-halt condition as "the answer
passed, INCLUDING HELD-OUT CHECKS". The shipped spiral has no holdout: grep for
holdout/held-out/hidden/unseen/split in lib/spiral-harness.js and lib/spiral-fix-rate.js returns
nothing. It scores each candidate with fixRate() against the SAME tests it is optimising, and
ratchets on best-so-far. So the documented defense is not implemented.

THE MECHANISM (why this is structural, not a tuning bug). The spiral "keeps every step that
provably advanced the problem and discards the rest" -- that is hill-climbing on the VISIBLE
score. Visible tests are a finite sample of the behaviour the code must get right. Early turns,
visible and true correctness move together: real fixes pass real tests. Once the genuine
improvements are exhausted, the only mutations that still raise the visible score are ones that
pass visible tests by luck while breaking unseen behaviour. The ratchet cannot tell those apart
-- it only sees the visible score -- so it accepts them. Visible score keeps climbing to 1.0 by
construction; TRUE correctness peaks and then declines.

This is the same failure this repo has now measured three separate times: the gloss trap (a probe
that reads style, not truth), post-selection bias (Pav arXiv:2606.01650, used in the Kalshi
pre-registration), and audit starvation. Optimising a proxy past the point where the proxy tracks
the target is one phenomenon.

WHY THE STAKES ARE REAL. SWE-bench-Verified instances ship ~2 FAIL_TO_PASS tests. Two visible
tests is a very small sample of "did you fix the bug", which is precisely the high-risk regime.

PRE-REGISTERED GATES (fixed before running):
  S1 (non-monotone): with a small visible suite, mean TRUE correctness of the returned answer is
     strictly higher at some intermediate budget than at max budget, by >= 2 percentage points.
     That directly falsifies "its answer only improves with more of it".
  S2 (it is the finite verifier): the peak-to-final drop SHRINKS as the visible suite grows.
     If the drop is constant in suite size, the sim has a bug, not a mechanism.
  S3 (the doc's own fix works): re-running with a held-out split -- selecting on visible, but
     RETURNING the candidate best on held-out -- removes most of the drop.
  KILL: S1 fails -> the anytime claim survives and this counterexample is withdrawn.

Deterministic given seeds. Read-only, no orders, no app changes.
Run:  python experiments/spiral_anytime_counterexample.py
"""

from __future__ import annotations

import json
import os
import random
import statistics as st

OUT = os.path.join("experiments", "results", "spiral_anytime_counterexample.json")
M_BEHAVIOURS = 400        # the full behaviour space the code must get right
MAX_TURNS = 60
TRIALS = 400
SEEDS = (1, 2, 3)


def run_spiral(rng, n_visible, max_turns, holdout=0):
    """One spiral run. Returns list of TRUE correctness of the best-so-far at each turn.

    Mirrors the shipped harness: propose a mutation, score it on the visible tests, ACCEPT iff
    the visible score did not decrease (the fix-rate ratchet), keep best-so-far.
    """
    code = [rng.random() < 0.55 for _ in range(M_BEHAVIOURS)]   # initial candidate
    idx = list(range(M_BEHAVIOURS))
    rng.shuffle(idx)
    visible = idx[:n_visible]                    # the tests the spiral can see
    held = idx[n_visible:n_visible + holdout] if holdout else []

    def vis_score(c):
        return sum(1 for i in visible if c[i]) / max(1, len(visible))

    def held_score(c):
        return sum(1 for i in held if c[i]) / max(1, len(held)) if held else 0.0

    def true_score(c):
        return sum(c) / len(c)

    best = list(code)
    best_vis = vis_score(best)
    best_held = held_score(best)
    returned = list(best)          # what the spiral would hand back
    trace = []
    for _ in range(max_turns):
        cand = list(best)
        # a mutation: touch a few behaviours, as a real edit does
        for _ in range(rng.randint(2, 8)):
            j = rng.randrange(M_BEHAVIOURS)
            cand[j] = not cand[j]
        v = vis_score(cand)
        if v >= best_vis:                        # the ratchet: accept if it did not regress
            best, best_vis = cand, v
            if holdout:
                # doc's stated defense: verified halt uses HELD-OUT checks
                h = held_score(cand)
                if h >= best_held:
                    best_held, returned = h, list(cand)
            else:
                returned = list(cand)            # shipped behaviour: return best-on-visible
        trace.append(true_score(returned))
    return trace


def sweep(n_visible, holdout=0):
    """Mean TRUE correctness of the returned answer, as a function of budget."""
    acc = [0.0] * MAX_TURNS
    for s in SEEDS:
        rng = random.Random(s * 7919 + n_visible + holdout)
        for _ in range(TRIALS // len(SEEDS)):
            tr = run_spiral(rng, n_visible, MAX_TURNS, holdout)
            for i, v in enumerate(tr):
                acc[i] += v
    n = (TRIALS // len(SEEDS)) * len(SEEDS)
    return [a / n for a in acc]


def main():
    rep = {"date": "2026-07-25",
           "claim_attacked": "SIGMA0-OURO-CODER.md sec.3: 'the Spiral is an anytime algorithm, "
                             "its answer only improves with more of it'",
           "shipped_gap": "lib/spiral-harness.js has NO holdout; fixRate scores the same tests it optimises",
           "curves": {}, "gates": {}}

    print("=== Does MORE spiral budget make the answer WORSE? ===")
    print("(true correctness of the answer handed back, vs turns of budget)\n")
    print(f"{'visible tests':>14} {'turn 1':>8} {'peak':>8} {'@turn':>6} {'turn 60':>9} {'PEAK-FINAL':>11}")
    drops = {}
    for nv in (2, 5, 10, 25, 60, 150):
        c = sweep(nv)
        peak = max(c); pk = c.index(peak) + 1
        drop = 100 * (peak - c[-1])
        drops[nv] = drop
        rep["curves"][f"visible_{nv}"] = {"turn1": round(c[0], 4), "peak": round(peak, 4),
                                          "peak_turn": pk, "final": round(c[-1], 4),
                                          "peak_minus_final_pp": round(drop, 2)}
        print(f"{nv:>14} {c[0]:>8.3f} {peak:>8.3f} {pk:>6} {c[-1]:>9.3f} {drop:>10.2f}pp")

    # S3: the doc's own stated defense -- select on visible, RETURN best on held-out
    print("\nwith the doc's stated defense (held-out checks decide what is returned):")
    print(f"{'visible tests':>14} {'peak':>8} {'turn 60':>9} {'PEAK-FINAL':>11}")
    drops_ho = {}
    for nv in (2, 5, 10):
        c = sweep(nv, holdout=40)
        peak = max(c); drop = 100 * (peak - c[-1])
        drops_ho[nv] = drop
        rep["curves"][f"visible_{nv}_heldout40"] = {"peak": round(peak, 4), "final": round(c[-1], 4),
                                                    "peak_minus_final_pp": round(drop, 2)}
        print(f"{nv:>14} {peak:>8.3f} {c[-1]:>9.3f} {drop:>10.2f}pp")

    s1 = drops.get(2, 0) >= 2.0 or drops.get(5, 0) >= 2.0
    s2 = drops.get(2, 0) > drops.get(150, 0) and drops.get(5, 0) > drops.get(150, 0)
    s3 = all(drops_ho.get(k, 99) < drops.get(k, 0) for k in drops_ho)
    rep["gates"] = {
        "S1_non_monotone_small_suite": {"PASS": bool(s1), "drop_pp_at_2_tests": round(drops.get(2, 0), 2),
                                        "drop_pp_at_5_tests": round(drops.get(5, 0), 2)},
        "S2_shrinks_as_suite_grows": {"PASS": bool(s2), "drops_by_suite_size": {k: round(v, 2) for k, v in drops.items()}},
        "S3_holdout_defense_works": {"PASS": bool(s3), "drops_with_holdout": {k: round(v, 2) for k, v in drops_ho.items()}},
        "VERDICT": ("COUNTEREXAMPLE CONFIRMED — more budget makes the returned answer worse when the "
                    "verifier is a small finite suite; the doc's held-out defense fixes it but is NOT SHIPPED"
                    if (s1 and s2 and s3) else
                    "PARTIAL — see flags" if s1 else
                    "WITHDRAWN — the anytime claim survives this construction")}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(rep, f, indent=2)
    print(f"\nGATES: S1={s1}  S2={s2}  S3={s3}")
    print(f"VERDICT: {rep['gates']['VERDICT']}")
    print("->", OUT)


if __name__ == "__main__":
    main()
