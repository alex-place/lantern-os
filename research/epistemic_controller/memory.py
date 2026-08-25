"""Scientific memory that survives -- validated relations as re-testable hypotheses, never as
columns assumed still live.

WHY THIS SHAPE. The naive version (carry the expanded model class across episodes) was killed
by run_discovery_benchmark.py: -47% discoveries per experiment, 20x false discoveries. A carried
column is a belief held without a test; when the slot's meaning changes under it (z1 is the
truth in episode 1, a noise decoy in episode 2) the machine trusts the stale column over fresh
evidence. Memory of a NAME is not memory of a REGULARITY.

WHAT A REGULARITY IS, for this memory:
    relation = (observable_name, coefficient_sign, explained_R2_when_validated, episodes_seen)
It is stored only when VALIDATED (expansion passed the structure test and MSE hit the floor) --
the same definition the benchmark uses, so memory and metric cannot disagree.

HOW IT IS USED -- as a PRIOR on the design step, never as model state:
  1. The machine starts every episode on the base class {x}. Nothing is assumed live.
  2. When it reaches DESIGN, memory RE-RANKS the candidates: an observable with a validated
     history is probed FIRST and gets a small utility bonus proportional to how often it has
     validated -- but it still has to EXPLAIN THE CURRENT RESIDUAL to be chosen. The probe is
     the re-test. If the remembered observable explains nothing this episode, the bonus is
     irrelevant and it is not chosen. That is the difference from a carried column: the
     hypothesis pays for itself or it is not used.
  3. When a remembered relation FAILS its re-test (probed, explained ~nothing), its record is
     weakened. A relation that validates again is strengthened. Memory is a calibration over
     outcomes, not a cache of conclusions -- the Oracle's Move 4, pointed at its own beliefs.

WHAT THIS BUYS, if it works: fewer probes on episodes where the rule repeats (the remembered
observable is tried first and validates fast), and NO penalty on episodes where it does not
(the re-test fails cheaply and the search proceeds as if from scratch). The benchmark's D1 will
say whether that is real: discoveries per experiment must beat one-shot, and D2's false rate
must not rise.

Pure; no I/O. The controller calls `rank()` at DESIGN and `record()` at validation.
"""

from __future__ import annotations


class RelationMemory:
    def __init__(self, bonus=0.15):
        self.bonus = bonus          # max utility bonus for a perfectly-reliable remembered relation
        self.rel = {}               # name -> {"validated": k, "tested": n, "sign": +1/-1, "r2": float}

    def reliability(self, name):
        r = self.rel.get(name)
        if not r or r["tested"] == 0:
            return 0.0
        return r["validated"] / r["tested"]

    def rank(self, scored):
        """Re-rank DESIGN candidates. `scored` is the controller's list of
        {name, cost, explained, utility}. Remembered observables get a bonus scaled by their
        reliability -- but ONLY multiplied into the utility they EARNED this episode, so an
        observable that explains nothing now gets nothing. Returns a new sorted list."""
        out = []
        for s in scored:
            rel = self.reliability(s["name"])
            boosted = dict(s)
            boosted["utility"] = s["utility"] * (1.0 + self.bonus * rel)
            boosted["memory_reliability"] = rel
            out.append(boosted)
        out.sort(key=lambda s: -s["utility"])
        return out

    def probe_order(self, names):
        """Which candidates to probe first: remembered-reliable ones. Probing is the re-test."""
        return sorted(names, key=lambda n: -self.reliability(n))

    def record(self, name, validated, r2=None, sign=None):
        r = self.rel.setdefault(name, {"validated": 0, "tested": 0, "sign": sign, "r2": r2})
        r["tested"] += 1
        if validated:
            r["validated"] += 1
            if r2 is not None: r["r2"] = r2
            if sign is not None: r["sign"] = sign

    def snapshot(self):
        return {k: dict(v) for k, v in self.rel.items()}
