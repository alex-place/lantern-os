#!/usr/bin/env python3
"""Σ₀ council outcome backtest — the provable-demo instrument.

The thesis to prove: the council's disagreement scalar Δ predicts which decisions get reverted /
fail. To measure that we need decisions that carry BOTH a Δ (council score) AND an outcome
(success / reverted). Tonight those live in two unjoined datasets:

  - data/convergence/council-reviews.jsonl  — Δ + verdict, but only on CHAT replies (no commit/PR).
  - data/autowork-runs/<date>.jsonl         — real OUTCOMES (status, phase, issue, pr) per self-
                                              coding run, but delta=None (the council never scored
                                              the patch).

So this does two things, honestly:
  1. Measures the REAL owned number that exists now: the autowork self-coding success rate and the
     failure-phase distribution (where the self-improving loop actually breaks). This is the
     baseline the council aims to lift, and it is measured on real owned runs — not projected.
  2. Attempts the Δ↔outcome join and reports exactly what's missing to make "Δ predicts reverts"
     computable: the council must score autowork PATCHES (tag each run with Δ), then outcomes
     accrue and a real precision/recall lands here.

Run:  python experiments/council_outcome_backtest.py
"""
from __future__ import annotations

import glob
import json
import os
import sys
from collections import Counter, defaultdict

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COUNCIL = os.path.join(REPO, "data", "convergence", "council-reviews.jsonl")
RUNS_GLOB = os.path.join(REPO, "data", "autowork-runs", "*.jsonl")

# Terminal phases that mean the run produced a shippable result vs. failed, and the phase where a
# failure stopped (the diagnostic that says WHERE the self-coding loop breaks).
SUCCESS_PHASES = {"open_pr", "pr", "done_pr", "committed", "pushed"}


def read_jsonl(path):
    out = []
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
    except FileNotFoundError:
        pass
    return out


def reduce_runs():
    """Group autowork step-records by runId → one outcome per run (success/error + failing phase)."""
    steps = defaultdict(list)
    for path in glob.glob(RUNS_GLOB):
        for rec in read_jsonl(path):
            rid = rec.get("runId")
            if rid:
                steps[rid].append(rec)
    runs = {}
    for rid, recs in steps.items():
        recs.sort(key=lambda r: r.get("ts", ""))
        terminal = recs[-1]
        # success if any step reached a PR/commit phase with non-error status
        succeeded = any(
            (r.get("phase") in SUCCESS_PHASES or r.get("pr"))
            and r.get("status") not in ("error", "failed", "stopped")
            for r in recs
        )
        # the phase where it stopped if it failed
        fail_phase = None
        if not succeeded:
            errs = [r for r in recs if r.get("status") in ("error", "failed", "stopped")]
            fail_phase = (errs[-1].get("phase") if errs else terminal.get("phase")) or "unknown"
        runs[rid] = {
            "issue": terminal.get("issue"),
            "succeeded": succeeded,
            "fail_phase": fail_phase,
            "steps": len(recs),
        }
    return runs


def main():
    council = read_jsonl(COUNCIL)
    runs = reduce_runs()

    print("=" * 66)
    print("Σ₀ council outcome backtest")
    print("=" * 66)

    # ── 1) the REAL owned number: self-coding success rate + where it fails ──
    n = len(runs)
    succ = sum(1 for r in runs.values() if r["succeeded"])
    print("\n[1] Self-coding (autowork) outcomes — MEASURED on real owned runs")
    print(f"    runs            : {n}")
    if n:
        print(f"    succeeded (PR)  : {succ}  ({100*succ/n:.1f}%)")
        print(f"    failed          : {n-succ}  ({100*(n-succ)/n:.1f}%)")
        fails = Counter(r["fail_phase"] for r in runs.values() if not r["succeeded"] and r["fail_phase"])
        print("    failure by phase (where the self-improving loop breaks):")
        for phase, c in fails.most_common():
            print(f"      {phase:<22} {c:>4}  ({100*c/(n-succ):.0f}% of failures)")

    # ── 2) the Δ↔outcome join: can we compute "Δ predicts reverts" yet? ──
    print("\n[2] Δ ↔ outcome join — can the council's Δ be scored against outcomes?")
    council_with_decision = [c for c in council if c.get("pr") or c.get("issue") or c.get("commit")]
    runs_with_delta = [r for r in runs.values() if r.get("delta") is not None]
    print(f"    council records             : {len(council)}  (Δ logged)")
    print(f"      ↳ tagged with a PR/issue  : {len(council_with_decision)}")
    print(f"    autowork runs               : {n}  (outcome logged)")
    print(f"      ↳ tagged with a council Δ : {len(runs_with_delta)}")
    joinable = len(council_with_decision) and len(runs_with_delta)
    if joinable:
        print("    JOINABLE — computing precision/recall of Δ vs reverted would go here.")
    else:
        print("    NOT JOINABLE YET — the two halves don't meet:")
        print("      • council Δ is on CHAT replies (no commit/PR to revert)")
        print("      • autowork runs have outcomes but delta=None (council never scored the patch)")
        print("    To make 'Δ predicts reverts' computable, ONE wire is needed:")
        print("      score each autowork patch with councilReview() and tag the run with its Δ;")
        print("      then label the run's PR as reverted/merged. After N runs accrue, re-run this")
        print("      script and section [2] prints the real precision/recall — the provable number.")

    # ── 3) the council Δ distribution that DOES exist (descriptive, not predictive) ──
    if council:
        verds = Counter(c.get("verdict") for c in council)
        deltas = [c.get("delta") for c in council if isinstance(c.get("delta"), (int, float))]
        print("\n[3] Council Δ distribution on chat replies (descriptive)")
        print(f"    verdicts: {dict(verds)}")
        if deltas:
            deltas.sort()
            print(f"    Δ range : min {deltas[0]:.3f}  median {deltas[len(deltas)//2]:.3f}  max {deltas[-1]:.3f}")


if __name__ == "__main__":
    main()
