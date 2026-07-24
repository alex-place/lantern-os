"""The halting problem under the Oracle discipline — you don't solve it, you refuse to bluff.

Turing (1936): no total procedure decides halting for all programs. This is not an engineering
gap the design can close; it is a proof. A design that returned a confident HALTS/LOOPS on every
input WOULD BE a halting oracle, which cannot exist — so claiming to "solve" it is exactly the
confident-but-unanchored collapse (the "42" machine) that this whole project polices.

What the design DOES do is run the four Oracle moves on a SPECIFIC instance and return one of
THREE verdicts — HALTS / LOOPS / UNKNOWN — where UNKNOWN is the honest pin (abstention), never
a bluff. The moves map exactly onto the session's architecture:

  ACT (run it, bounded)      -> execute up to a step budget; if it stops, HALTS (proof: the trace).
  VERIFY (sound structure)   -> if a full machine STATE repeats, LOOPS (proof: the cycle). Sound
                                static rules may add more definite verdicts, never remove the pin.
  PLACE/PIN (abstain)        -> everything else -> UNKNOWN. This class is NON-EMPTY BY TURING'S
                                THEOREM; a design that emptied it would be lying.
  LEARN (calibrate)          -> UNKNOWN is honest, not useless: it says precisely where knowledge
                                ends, and it tracks the frontier of MATHEMATICS (see Collatz).

SOUNDNESS GUARANTEE (the whole point): the analyzer is SOUND — every definite verdict (HALTS or
LOOPS) is accompanied by a checkable proof (a halting trace, or a repeated-state cycle). It is
INCOMPLETE — the UNKNOWN class is irreducible. Sound + incomplete + abstaining is the only
honest shape, and it is the audit-starvation lesson applied to the deepest possible verifier:
better to say UNKNOWN than to collapse to a confident wrong answer.

Run:  python experiments/halting_oracle_discipline.py
"""

from __future__ import annotations

import json
import os

OUT = os.path.join("experiments", "results", "halting_oracle_discipline.json")
BUDGET = 100_000  # step budget for the ACT move


def analyze(step, state0, halted, budget=BUDGET):
    """Sound, incomplete, three-verdict halting analyzer on a deterministic state machine.

    step(state)->state', halted(state)->bool. Returns (verdict, proof-dict). Never bluffs:
    HALTS and LOOPS carry a checkable witness; otherwise UNKNOWN.
    """
    seen = {}
    s = state0
    for t in range(budget):
        if halted(s):
            return "HALTS", {"steps": t, "witness": "reached a halting state (trace is the proof)"}
        key = s  # full machine state; must be hashable
        if key in seen:
            return "LOOPS", {"cycle_start": seen[key], "cycle_len": t - seen[key],
                             "witness": "a full state repeated -> deterministic machine cycles forever"}
        seen[key] = t
        s = step(s)
    return "UNKNOWN", {"reason": f"no halt and no repeated state within {budget} steps",
                       "honest_note": "the pin: sound analyzers must abstain here (Turing) — NOT a bluff"}


# ---- the battery: provable-halt, provable-loop, and the irreducible UNKNOWN class ----
# each builder returns (step, state0, halted); state is a raw hashable value.
def countdown(n):    # provably HALTS: strictly decreasing to a floor
    return (lambda s: s - 1, n, lambda s: s <= 0)

def constant_stuck():  # provably LOOPS: state never changes, halting target never met
    return (lambda s: s, 0, lambda s: s == 999)

def two_cycle():     # provably LOOPS: 0->1->0->... a detectable cycle
    return (lambda s: 1 - s, 0, lambda s: False)

def collatz(n):      # HALTS for THIS n within budget (Collatz halts for all TESTED n)
    return (lambda s: s // 2 if s % 2 == 0 else 3 * s + 1, n, lambda s: s == 1)

def increment_never_halts():  # LOOPS in truth, but INFINITE-STATE -> analyzer honestly says UNKNOWN
    return (lambda s: s + 1, 0, lambda s: s == -1)  # target never reachable


def main():
    cases = [
        ("countdown(50000)", (lambda: countdown(50_000))),
        ("constant_stuck", (lambda: constant_stuck())),
        ("two_cycle", (lambda: two_cycle())),
        ("collatz(27)", (lambda: collatz(27))),
        ("collatz(97)", (lambda: collatz(97))),
        ("increment_never_halts", (lambda: increment_never_halts())),
    ]
    results = []
    for name, build in cases:
        step, s0, halted = build()
        verdict, proof = analyze(step, s0, halted)
        results.append({"program": name, "verdict": verdict, "proof": proof})

    for r in results:
        r["verdict_and_proof"] = f"{r.pop('verdict')} :: {json.dumps(r.pop('proof'))}"

    # the universal Collatz claim: "does collatz halt for ALL n?" — this is an OPEN PROBLEM.
    # The design's verdict on the FAMILY (not a fixed n) is necessarily UNKNOWN — and that
    # UNKNOWN sits exactly at the frontier of human mathematics. This is the punchline.
    universal_collatz = {
        "program": "collatz(n) for ALL n  (the Collatz conjecture)",
        "verdict_and_proof": "UNKNOWN :: {\"reason\": \"halting for all n is an OPEN mathematical "
        "problem (Collatz conjecture, unresolved since 1937)\", \"honest_note\": \"the design's pin "
        "is calibrated to the true frontier of knowledge: it neither proves nor bluffs where "
        "mathematics itself has no answer\"}",
    }

    verdicts = {r["program"]: r["verdict_and_proof"].split(" :: ")[0] for r in results}
    report = {
        "date": "2026-07-24",
        "question": "solve the halting problem with the design",
        "answer": "YOU CANNOT (Turing 1936). The design's correct behavior is a SOUND, INCOMPLETE, "
                  "THREE-VERDICT analyzer that ABSTAINS (UNKNOWN) rather than bluff. Solving it would "
                  "mean being a halting oracle, which cannot exist — and claiming to is the '42' collapse.",
        "step_budget": BUDGET,
        "battery": results,
        "the_open_frontier_case": universal_collatz,
        "verdict_summary": verdicts,
        "guarantees": {
            "SOUND": "every HALTS/LOOPS verdict carries a checkable witness (a halting trace or a repeated-state cycle) — the design is never definitively wrong",
            "INCOMPLETE": "the UNKNOWN class is irreducible (increment_never_halts LOOPS in truth but is infinite-state -> honest UNKNOWN; and the Collatz family is genuinely open)",
            "the_honest_shape": "sound + incomplete + abstaining is the ONLY shape Turing permits; a design that emptied UNKNOWN would be lying",
        },
        "mapping_to_the_architecture": {
            "ACT_to_know": "bounded execution — run it, the trace resolves the instance inference cannot decide",
            "VERIFY": "state-repetition + sound static rules give the LOOPS proofs (the verifier that never bluffs)",
            "PLACE_pin": "UNKNOWN is the Oracle pin — name the unknown, never collapse to a confident scalar",
            "why_this_is_the_capstone": "the halting problem is the ur-example of 'a question whose confident answer is a lie'; the design's whole value is that it returns UNKNOWN there — solving it would mean the design is BROKEN",
        },
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print("=== Halting problem under the Oracle discipline (SOUND, INCOMPLETE, ABSTAINING) ===\n")
    for r in results:
        print(f"  {r['program']:26s} -> {r['verdict_and_proof']}")
    print(f"\n  {universal_collatz['program']}")
    print(f"    -> {universal_collatz['verdict_and_proof']}")
    n_unknown = sum(1 for v in verdicts.values() if v == "UNKNOWN")
    print(f"\nsound on all {len(results)} concrete cases; UNKNOWN class non-empty ({n_unknown} + the open Collatz family) — BY TURING, not by weakness.")
    print("the design 'solves' the halting problem by being the machine that knows where knowing ends.")
    print("full report ->", OUT)


if __name__ == "__main__":
    main()
