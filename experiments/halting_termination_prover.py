"""Termination PROOFS, not just traces — ranking-function synthesis for the Oracle analyzer.

Upgrade to halting_oracle_discipline.py. The trace method proves only "THIS input halted within
budget". A RANKING FUNCTION proves "EVERY input halts": a measure r(x) into a well-founded set
that (a) is bounded below and (b) strictly decreases on every enabled transition. Classical
theorem (Turing 1949; Floyd 1967): such an r exists => no infinite run => termination for ALL
inputs. That is a universal proof, not per-instance evidence.

SOUNDNESS (the whole point — the verifier proves, never bluffs):
  Programs are guarded LINEAR INTEGER transition systems over the domain N^n (state x in Z^n,
  guards = conjunctions of linear inequalities, updates = affine). A candidate ranking function
  is VERIFIED by discharging two linear-arithmetic implications per transition —
      guard(x) => r(x) >= 0            (bounded below)
      guard(x) => r(x) - r(update x) >= 1   (strict decrease, integer step)
  — with FOURIER-MOTZKIN ELIMINATION in exact rationals. FM decides rational feasibility exactly;
  a rationally-infeasible negation is integer-infeasible too, so a discharged implication is a
  genuine proof over the integers. Synthesis (searching weight templates / lexicographic orders)
  is heuristic and INCOMPLETE; verification is SOUND. Sound + incomplete is the only honest shape
  Turing permits — where no ranking function is found (or none exists, e.g. Collatz) the verdict
  is UNKNOWN, never a bluff.

Verdict hierarchy (strongest first):
  TERMINATES(forall)     -- ranking function found + FM-verified (single or lexicographic).
  NONTERMINATES(forall)  -- a preserved-guard recurrence: guard => guard(update) and enabled,
                            so a deterministic run stays enabled forever (sound universal cert).
  HALTS(this input)      -- bounded run reached a no-guard-enabled (halting) state.
  LOOPS(this input)      -- a full state repeated (deterministic => cycles forever).
  UNKNOWN                -- none of the above; the irreducible pin (Turing).

Run:  python experiments/halting_termination_prover.py
"""

from __future__ import annotations

import json
import os
from fractions import Fraction as Fr
from itertools import permutations

OUT = os.path.join("experiments", "results", "halting_termination_prover.json")
BUDGET = 100_000

# ---------------------------------------------------------------- linear arithmetic (exact)
# An affine expr over n vars is a list of length n+1: [c_0..c_{n-1}, const], meaning
# sum c_i x_i + const. A constraint is such a list, meaning "expr >= 0".

def _fm_infeasible(cons, n):
    """Fourier-Motzkin: True iff the system {expr >= 0} is INFEASIBLE over the rationals.
    Sound for integers: rational-infeasible => integer-infeasible."""
    rows = [[Fr(v) for v in c] for c in cons]
    for k in range(n):
        pos = [r for r in rows if r[k] > 0]
        neg = [r for r in rows if r[k] < 0]
        combined = [r for r in rows if r[k] == 0]
        for p in pos:
            for q in neg:
                lp, lq = -q[k], p[k]              # both > 0; cancel x_k
                comb = [lp * p[i] + lq * q[i] for i in range(n + 1)]
                comb[k] = Fr(0)
                combined.append(comb)
        rows = combined
    return any(r[n] < 0 for r in rows)             # 0 >= negative constant -> contradiction


def prove_ge(guard, dom, expr, k, n):
    """Prove guard & dom => expr >= k over the integers (k in {0,1}), via FM on the negation.
    Negation (integers): expr <= k-1, i.e. (k-1) - expr >= 0."""
    neg = [-expr[i] for i in range(n)] + [Fr(k - 1) - expr[n]]
    return _fm_infeasible(list(guard) + list(dom) + [neg], n)


def r_after_update(w, w0, update, n):
    """Coeffs of r(update(x)) for r = w.x + w0 and affine update rows (each len n+1)."""
    coeff = [sum(w[i] * update[i][j] for i in range(n)) for j in range(n)]
    const = sum(w[i] * update[i][n] for i in range(n)) + w0
    return coeff + [const]


def r_expr(w, w0, n):
    return list(w) + [w0]


def sub(a, b, n):
    return [a[i] - b[i] for i in range(n + 1)]


# ---------------------------------------------------------------- ranking verification
def verify_single(trans, w, w0, n, dom):
    for t in trans:
        Er = r_expr(w, w0, n)
        Ed = sub(Er, r_after_update(w, w0, t["update"], n), n)
        if not prove_ge(t["guard"], dom, Er, 0, n):   # bounded below
            return False
        if not prove_ge(t["guard"], dom, Ed, 1, n):   # strict decrease
            return False
    return True


def verify_lex(trans, comps, n, dom):
    """comps = list of (w, w0). Each transition must strictly decrease some component while all
    earlier components weakly decrease, all used components bounded below."""
    for t in trans:
        ok_t = False
        for j in range(len(comps)):
            prefix_ok = True
            for i in range(j):
                w, w0 = comps[i]
                Er = r_expr(w, w0, n)
                Ed = sub(Er, r_after_update(w, w0, t["update"], n), n)
                if not (prove_ge(t["guard"], dom, Er, 0, n) and prove_ge(t["guard"], dom, Ed, 0, n)):
                    prefix_ok = False
                    break
            if not prefix_ok:
                continue
            w, w0 = comps[j]
            Er = r_expr(w, w0, n)
            Ed = sub(Er, r_after_update(w, w0, t["update"], n), n)
            if prove_ge(t["guard"], dom, Er, 0, n) and prove_ge(t["guard"], dom, Ed, 1, n):
                ok_t = True
                break
        if not ok_t:
            return False
    return True


def synthesize(trans, n, dom):
    # 1) single linear ranking, small integer weights
    rng = (-1, 0, 1, 2)
    def weights(n):
        if n == 1:
            for a in rng:
                yield (a,)
        else:
            for a in rng:
                for b in rng:
                    yield (a, b)
    for w in weights(n):
        if all(v == 0 for v in w):
            continue
        for w0 in (0, 1):
            if verify_single(trans, list(w), w0, n, dom):
                return {"kind": "single_linear", "r": f"{list(w)}.x + {w0}"}
    # 2) lexicographic over unit-vector components (permutations)
    units = [([1 if i == j else 0 for i in range(n)], 0) for j in range(n)]
    for perm in permutations(range(n)):
        comps = [units[j] for j in perm]
        if verify_lex(trans, comps, n, dom):
            return {"kind": "lexicographic", "order": [f"x{j}" for j in perm]}
    return None


def recurrence_nonterm(trans, n, dom):
    """Sound universal non-termination: a single deterministic transition whose guard is
    preserved by its update and is satisfiable -> runs forever from any enabled state."""
    if len(trans) != 1:
        return None
    t = trans[0]
    if _fm_infeasible(list(t["guard"]) + list(dom), n):
        return None                                    # guard unsatisfiable -> vacuous
    for g in t["guard"]:
        g_after = r_after_update(g[:n], g[n], t["update"], n)
        if not prove_ge(t["guard"], dom, g_after, 0, n):
            return None                                # guard not provably preserved
    # empty guard (always enabled) is trivially preserved and never halts
    return {"kind": "preserved_guard_recurrence",
            "witness": "guard implies guard-after-update and is satisfiable -> infinite run for all enabled inputs"}


# ---------------------------------------------------------------- concrete trace (per instance)
def make_step(trans, n):
    def enabled(t, x):
        return all(sum(t["guard"][gi][j] * x[j] for j in range(n)) + t["guard"][gi][n] >= 0
                   for gi in range(len(t["guard"])))
    def step(x):
        for t in trans:
            if enabled(t, x):
                return tuple(sum(t["update"][i][j] * x[j] for j in range(n)) + t["update"][i][n]
                             for i in range(n))
        return None                                    # no guard enabled -> halted
    return step


def trace_verdict(step, x0, budget=BUDGET):
    seen, x = {}, tuple(x0)
    for k in range(budget):
        nxt = step(x)
        if nxt is None:
            return "HALTS", {"steps": k, "witness": "reached a state with no enabled transition"}
        if x in seen:
            return "LOOPS", {"cycle_start": seen[x], "cycle_len": k - seen[x],
                             "witness": "full state repeated in a deterministic system"}
        seen[x] = k
        x = nxt
    return "UNKNOWN", {"reason": f"no halt/repeat in {budget} steps"}


def analyze(prog):
    n = prog["n"]
    dom = [[1 if i == j else 0 for i in range(n)] + [0] for j in range(n)]  # x_j >= 0 (domain N^n)
    if prog.get("trans") is not None:
        cert = synthesize(prog["trans"], n, dom)
        if cert:
            return "TERMINATES(forall)", {"proof": "ranking function", **cert}
        nt = recurrence_nonterm(prog["trans"], n, dom)
        if nt:
            return "NONTERMINATES(forall)", {"proof": "recurrence", **nt}
        step = make_step(prog["trans"], n)
        v, w = trace_verdict(step, prog["start"])
        if v != "UNKNOWN":
            return v + "(this input)", {**w, "note": "no ranking function in template -> per-instance only"}
        return "UNKNOWN", {**w, "honest_note": "no ranking function found AND no repeat -> the pin (Turing)"}
    # non-linear program (e.g. Collatz): only the concrete trace is available
    v, w = trace_verdict(prog["step"], prog["start"])
    return (v + "(this input)" if v != "UNKNOWN" else "UNKNOWN"), {
        **w, "universal_note": "guards/updates are non-linear -> outside the linear ranking class; universal claim UNKNOWN"}


# ---------------------------------------------------------------- battery
def main():
    programs = [
        # countdown over N: while x>=1: x-=1.  single ranking r=x.
        {"name": "countdown  (while x>=1: x--)", "n": 1, "start": [50_000],
         "trans": [{"guard": [[1, -1]], "update": [[1, -1]]}]},
        # race: while x>=1 and y>=1: (x--, y--).  single ranking r=x.
        {"name": "race  (while x>=1 & y>=1: x--,y--)", "n": 2, "start": [40_000, 55_000],
         "trans": [{"guard": [[1, 0, -1], [0, 1, -1]], "update": [[1, 0, -1], [0, 1, -1]]}]},
        # nested loops: inner drains y, outer decrements x and resets y:=x-1. needs LEXICOGRAPHIC.
        {"name": "nested  (outer x, inner y:=x-1)", "n": 2, "start": [30, 20],
         "trans": [{"guard": [[0, 1, -1]], "update": [[1, 0, 0], [0, 1, -1]]},                 # y>=1: y--
                   {"guard": [[1, 0, -1], [0, -1, 0]], "update": [[1, 0, -1], [1, 0, -1]]}]},   # x>=1 & y<=0: x--, y:=x-1
        # increment: always x++.  universal NON-termination via preserved-guard recurrence.
        {"name": "increment  (loop forever: x++)", "n": 1, "start": [0],
         "trans": [{"guard": [], "update": [[1, 1]]}]},
        # two-cycle: 0->1->0.  no ranking; per-instance LOOPS via state repeat.
        {"name": "two_cycle  (0<->1 forever)", "n": 1, "start": [0],
         "trans": [{"guard": [[-1, 0]], "update": [[0, 1]]},     # x<=0: x:=1
                   {"guard": [[1, -1]], "update": [[0, 0]]}]},   # x>=1: x:=0
        # Collatz: non-linear guards (even/odd) -> outside the class. per-instance HALTS; universal UNKNOWN.
        {"name": "collatz(27)  (non-linear)", "n": 1, "start": [27], "trans": None,
         "step": (lambda s: None if s[0] == 1 else ((s[0] // 2,) if s[0] % 2 == 0 else (3 * s[0] + 1,)))},
    ]
    results = []
    for p in programs:
        verdict, proof = analyze(p)
        results.append({"program": p["name"], "verdict": verdict, "proof": proof})

    universal_collatz = {
        "program": "collatz(n) for ALL n  (Collatz conjecture)",
        "verdict": "UNKNOWN",
        "proof": {"reason": "no ranking function is known for Collatz; universal termination is OPEN since 1937",
                  "honest_note": "synthesis returns nothing AND none is known to exist -> the pin sits at the true math frontier"}}

    report = {
        "date": "2026-07-24",
        "upgrade": "the analyzer now DETECTS TERMINATION PROOFS (ranking functions verified by Fourier-Motzkin), not just runs traces",
        "domain": "guarded linear integer transition systems over N^n",
        "soundness": "TERMINATES/NONTERMINATES are universal proofs (ranking fn / preserved-guard recurrence, FM-discharged in exact rationals); HALTS/LOOPS are per-instance witnesses; UNKNOWN is the irreducible Turing pin",
        "verification_method": "Fourier-Motzkin over Fraction: a discharged implication is rationally-infeasible-negation => integer-sound",
        "battery": results,
        "the_open_frontier_case": universal_collatz,
        "honest_scope": {
            "sound": "no false proof: every TERMINATES has an FM-checked ranking function; over N^n as declared",
            "incomplete": "synthesis is template-bounded (small linear weights + unit-vector lexicographic); a true-but-unfound proof -> UNKNOWN, never a bluff",
            "not_magic": "does NOT beat Turing — the linear class is decidable-ish by design; Collatz (non-linear) stays universal-UNKNOWN, which is the point",
        },
        "vs_prior": "halting_oracle_discipline.py gave HALTS only by running a trace (per-instance). This proves TERMINATES for ALL inputs when a ranking function exists — a universal proof, machine-verified.",
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print("=== Termination PROOFS via ranking functions (FM-verified, sound + incomplete) ===\n")
    for r in results:
        pk = r["proof"].get("kind") or r["proof"].get("witness", r["proof"].get("reason", ""))
        print(f"  {r['program']:38s} -> {r['verdict']}")
        detail = r["proof"].get("r") or r["proof"].get("order") or r["proof"].get("witness") or r["proof"].get("reason")
        print(f"      proof: {detail}")
    print(f"\n  {universal_collatz['program']}\n      -> {universal_collatz['verdict']}: {universal_collatz['proof']['reason']}")
    term = sum(1 for r in results if r["verdict"].startswith("TERMINATES"))
    print(f"\n{term} universal termination PROOFS synthesized+verified; non-termination + per-instance + UNKNOWN all sound.")
    print("upgrade delivered: detects termination proofs (ranking functions), not just traces.")
    print("full report ->", OUT)


if __name__ == "__main__":
    main()
