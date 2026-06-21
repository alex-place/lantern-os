#!/usr/bin/env python3
"""
Rollover promotion gate (#895).

The Σ₀ Keystone-coding-agent rollover (#892) advances through stages
(shadow → assist → default → independent). A stage may only advance when the live
kernel clears two measurable bars on the golden eval set, expressed as an External
Reality envelope [claim, evidence, confidence, source]:

  Gate B (grounding/accuracy): the run's accuracy must beat the cold baseline
    (0.34 — the ungrounded Ollama-HTTP row, see data/eval/leaderboard.jsonl). A run
    at/below the cold floor is no better than not rolling over.
  Gate F (cost): bytes_per_correct must not regress vs the chosen baseline row —
    the kernel may not get *more* expensive per correct answer as it advances.

This script reads the leaderboard row for a stage (optionally running
scripts/eval_keystone.py first), evaluates the two gates, prints a PASS/FAIL plus
the grounding envelope, and exits 0 on PASS / 1 on FAIL — so CI or `make
gate-rollover` can block a stage advance.

The threshold logic (`evaluate_gate`) is a pure function with no I/O, locked by
tests/test_rollover_gate.py; the live eval run is delegated to eval_keystone.py
(reused, not duplicated — reconciles with #843).

Usage:
    python scripts/rollover_gate.py --stage assist
    python scripts/rollover_gate.py --stage assist --run --label keystone-assist --engine loop
"""

import argparse
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))

from convergence.grounding import GroundingEnvelope  # noqa: E402

LEADERBOARD = os.path.join(ROOT, "data", "eval", "leaderboard.jsonl")
COLD_BASELINE_ACCURACY = 0.34  # the ungrounded cold floor (#843/#895)


def evaluate_gate(row, baseline_row=None, gate_b_floor=COLD_BASELINE_ACCURACY, stage="?"):
    """Pure gate logic. Returns a verdict dict carrying a grounding envelope.

    row, baseline_row: leaderboard summary dicts (as written by eval_keystone.py).
    Gate B passes when row.accuracy > gate_b_floor.
    Gate F passes when row.bytes_per_correct <= baseline_row.bytes_per_correct
      (lower is better). Skipped (None) when no baseline / either value missing.
    """
    acc = float(row.get("accuracy") or 0.0)
    gate_b_pass = acc > gate_b_floor
    gate_b = {"metric": "accuracy", "value": acc, "floor": gate_b_floor, "passed": gate_b_pass}

    gate_f = None
    bpc = row.get("bytes_per_correct")
    base_bpc = (baseline_row or {}).get("bytes_per_correct")
    if bpc is not None and base_bpc is not None:
        gate_f_pass = float(bpc) <= float(base_bpc)
        gate_f = {"metric": "bytes_per_correct", "value": float(bpc),
                  "baseline": float(base_bpc), "passed": gate_f_pass}

    # A gate that can't be evaluated (no baseline) does not block, but is reported.
    passed = gate_b_pass and (gate_f is None or gate_f["passed"])

    # Confidence is grounded in the real margin over the floor, clamped to [0, 0.95].
    margin = (acc - gate_b_floor) / (1.0 - gate_b_floor) if acc > gate_b_floor else 0.0
    confidence = round(min(0.95, max(0.0, margin)), 3)

    evidence = [
        f"leaderboard row ts={row.get('ts')} label={row.get('label')} "
        f"accuracy={acc} bytes_per_correct={bpc}",
    ]
    if baseline_row is not None:
        evidence.append(
            f"baseline row ts={baseline_row.get('ts')} label={baseline_row.get('label')} "
            f"bytes_per_correct={base_bpc}"
        )
    envelope = GroundingEnvelope(
        claim=f"Keystone {'MAY' if passed else 'may NOT'} advance to rollover stage '{stage}'",
        evidence=evidence,
        confidence=confidence if passed else 0.0,
        source=f"{os.path.relpath(LEADERBOARD, ROOT).replace(os.sep, '/')}#ts={row.get('ts')}",
    ).validate()

    return {"passed": passed, "stage": stage, "gate_b": gate_b, "gate_f": gate_f,
            "envelope": envelope.to_dict()}


def _read_rows(path):
    if not os.path.exists(path):
        return []
    return [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]


def _latest_row(rows, predicate):
    for r in reversed(rows):
        if predicate(r):
            return r
    return None


def main():
    ap = argparse.ArgumentParser(description="Rollover promotion gate (#895)")
    ap.add_argument("--stage", required=True,
                    help="stage being advanced into: shadow|assist|default|independent")
    ap.add_argument("--leaderboard", default=LEADERBOARD)
    ap.add_argument("--baseline-label", default=None,
                    help="leaderboard label whose row is the cost baseline (default: the "
                         "newest row that is NOT this stage's row)")
    ap.add_argument("--floor", type=float, default=COLD_BASELINE_ACCURACY)
    ap.add_argument("--run", action="store_true",
                    help="run scripts/eval_keystone.py for this stage first (live kernel)")
    ap.add_argument("--label", default=None, help="eval label when --run is used")
    ap.add_argument("--engine", default="http")
    ap.add_argument("--base", default="http://127.0.0.1:11434")
    a = ap.parse_args()

    if a.run:
        label = a.label or f"keystone-{a.stage}"
        cmd = [sys.executable, os.path.join(ROOT, "scripts", "eval_keystone.py"),
               "--label", label, "--stage", a.stage, "--engine", a.engine, "--base", a.base]
        print(f"[rollover-gate] running eval: {' '.join(cmd)}", flush=True)
        subprocess.run(cmd, check=True, cwd=ROOT)

    rows = _read_rows(a.leaderboard)
    if not rows:
        print(f"[rollover-gate] FAIL: no leaderboard rows in {a.leaderboard}")
        return 1

    row = _latest_row(rows, lambda r: r.get("rollover_stage") == a.stage)
    if row is None:
        print(f"[rollover-gate] FAIL: no leaderboard row tagged rollover_stage='{a.stage}'. "
              f"Run eval_keystone.py with --stage {a.stage} (or pass --run).")
        return 1

    if a.baseline_label:
        baseline = _latest_row(rows, lambda r: r.get("label") == a.baseline_label)
    else:
        baseline = _latest_row(rows, lambda r: r is not row and r.get("bytes_per_correct") is not None)

    verdict = evaluate_gate(row, baseline, gate_b_floor=a.floor, stage=a.stage)
    print(("PASS" if verdict["passed"] else "FAIL") + f" — rollover stage '{a.stage}'")
    print(json.dumps(verdict, ensure_ascii=False, indent=2))
    return 0 if verdict["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
