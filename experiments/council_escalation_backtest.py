#!/usr/bin/env python3
"""Σ₀ Council — operator-escalation backtest.

The council's one *native* capability claim is that its disagreement scalar Δ
(lib/council-review.js) predicts decisions the operator later reverts. This script is the
instrument that scores that claim against ground truth — turning the "escalation recall"
projection (Low confidence, magnitude unknown) into a measured number.

Ground truth = git revert history. Signal = the Δ logged per council review, joined to the
commit/PR it produced, labelled bad iff that commit was later reverted (or the record carries
an explicit ``outcome`` of reverted/failed/rejected).

HONEST STATE (2026-06-29): Δ was never logged before lib/council-review.js existed, so
``data/convergence/council-reviews.jsonl`` starts empty. With zero labelled records the
backtest is *not runnable* — which is itself the finding: the #1 measurement was blocked on
instrumentation, not GPU. This script reports that truth, shows the available label pool (git
reverts), and states exactly what must accrue. Once councilReview runs in the serving/decision
path and records are labelled, re-run and it emits precision/recall + a Δ-threshold sweep.

Run:  python experiments/council_escalation_backtest.py
Appends a timestamped run summary to data/convergence/council-backtest-log.jsonl.
"""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# Windows consoles default to cp1252, which can't encode "Σ₀". Make stdout UTF-8 so the
# instrument prints the same everywhere instead of crashing on a heading.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

REPO = Path(__file__).resolve().parents[1]
REVIEWS = REPO / "data" / "convergence" / "council-reviews.jsonl"
RUN_LOG = REPO / "data" / "convergence" / "council-backtest-log.jsonl"

# A council record is "bad" (should have escalated) iff its outcome says so.
BAD_OUTCOMES = {"reverted", "failed", "rejected", "rolled_back"}
GOOD_OUTCOMES = {"merged", "ok", "kept", "approved", "shipped"}


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return rows


def git_revert_pool() -> dict:
    """The eventual label pool: revert commits / total commits. Context only — these are not
    yet joined to council records (council records need a commit/PR id to join on)."""
    def count(args: list[str]) -> int:
        try:
            out = subprocess.run(["git", *args], cwd=REPO, capture_output=True,
                                  encoding="utf-8", errors="replace", check=True)
            return sum(1 for ln in out.stdout.splitlines() if ln.strip())
        except (subprocess.CalledProcessError, FileNotFoundError):
            return -1
    reverts = count(["log", "--grep=revert", "-i", "--oneline"])
    total = count(["log", "--oneline"])
    return {"revert_commits": reverts, "total_commits": total}


def threshold_sweep(rows: list[dict]) -> list[dict]:
    """For each Δ threshold τ, precision/recall of (Δ>=τ) against the bad-outcome label."""
    labelled = [
        (float(r.get("delta", 0.0)), str(r.get("outcome", "")).lower())
        for r in rows
        if str(r.get("outcome", "")).lower() in BAD_OUTCOMES | GOOD_OUTCOMES
    ]
    if not labelled:
        return []
    pos = sum(1 for _, o in labelled if o in BAD_OUTCOMES)
    out = []
    for i in range(1, 10):
        tau = i / 10.0
        tp = sum(1 for d, o in labelled if d >= tau and o in BAD_OUTCOMES)
        fp = sum(1 for d, o in labelled if d >= tau and o in GOOD_OUTCOMES)
        precision = tp / (tp + fp) if (tp + fp) else None
        recall = tp / pos if pos else None
        out.append({"tau": tau, "precision": precision, "recall": recall, "tp": tp, "fp": fp})
    return out


def main() -> None:
    rows = read_jsonl(REVIEWS)
    pool = git_revert_pool()
    labelled = [r for r in rows if str(r.get("outcome", "")).lower() in BAD_OUTCOMES | GOOD_OUTCOMES]
    escalated = sum(1 for r in rows if r.get("escalated"))

    print("=" * 64)
    print("Σ₀ Council — operator-escalation backtest")
    print("=" * 64)
    print(f"council reviews logged : {len(rows)}")
    print(f"  of which escalated   : {escalated}")
    print(f"  with an outcome label: {len(labelled)}")
    print(f"git revert label pool  : {pool['revert_commits']} reverts / {pool['total_commits']} commits")

    sweep = threshold_sweep(rows)
    if sweep:
        print("\nΔ-threshold sweep (precision / recall vs reverted-outcome):")
        for s in sweep:
            p = f"{s['precision']:.2f}" if s["precision"] is not None else "  -- "
            rc = f"{s['recall']:.2f}" if s["recall"] is not None else "  -- "
            print(f"  τ={s['tau']:.1f}  precision={p}  recall={rc}  (tp={s['tp']} fp={s['fp']})")
        runnable = True
    else:
        print("\nNOT RUNNABLE YET — n=0 labelled council records.")
        print("This is the finding: Δ history did not exist before lib/council-review.js.")
        print("To make it runnable:")
        print("  1. Call councilReview() on real decisions (serving / autowork PR path).")
        print("  2. Tag each record's context with the commit/PR it produced (decisionId -> sha).")
        print("  3. Label outcome: 'reverted' if that commit was later reverted, else 'merged'.")
        print("  Then re-run — this prints precision/recall and the operator-escalation number.")
        runnable = False

    summary = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "reviews": len(rows),
        "escalated": escalated,
        "labelled": len(labelled),
        "git_pool": pool,
        "runnable": runnable,
        "sweep": sweep,
    }
    RUN_LOG.parent.mkdir(parents=True, exist_ok=True)
    with RUN_LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(summary) + "\n")
    print(f"\nrun summary appended -> {RUN_LOG.relative_to(REPO)}")


if __name__ == "__main__":
    main()
