#!/usr/bin/env python3
"""
reconcile_dual_provider.py — compare the outputs of two providers that ran the
SAME seeded job concurrently (redundancy), and emit a single reconciled verdict.

Two use cases (both are "did the independent twins agree?"):

  1. E-B gated-training run (#2691): each provider produces a Σ_θ A/B/C decision
     (runs/abc/decision.json from experiments/sigma_theta_abc/harness.py). Agreement
     on the WINNER (+ the per-arm gate outcomes) turns two runs into a confirmed
     result; divergence is itself a finding — the gate margin is hardware-sensitive.

  2. Continuation training (orchestration dispatch-all): each provider uploads a
     seeded adapter (output.csf / output.modal.csf). Agreement on the packed
     footer_sha256 is a byte-level reproducibility check across clouds.

First-green-wins is orthogonal: whichever finishes first is the result you ship;
this script grades the SECOND one against it when both complete. Exit 0 = agree
(or only one present), 1 = the two disagree (inspect before trusting either).

Usage:
  python scripts/reconcile_dual_provider.py --decision A/decision.json B/decision.json
  python scripts/reconcile_dual_provider.py --sha 3f8a...  9c1d...
  python scripts/reconcile_dual_provider.py --json < pair.json   # {"a":..., "b":...}
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _load(p):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        return {"_error": f"could not read {p}: {e}"}


def reconcile_decisions(a: dict, b: dict) -> dict:
    """Compare two Σ_θ A/B/C decision dicts (harness.decide output)."""
    def summary(d):
        dec = d.get("decision", d)
        return {"winner": dec.get("winner"), "rl_enabled": dec.get("rl_enabled"),
                "gates": {k: v.get("accept") if isinstance(v, dict) else v
                          for k, v in (d.get("gates") or {}).items()}}
    sa, sb = summary(a), summary(b)
    winner_agree = sa["winner"] == sb["winner"]
    gate_agree = sa["gates"] == sb["gates"]
    agree = winner_agree and gate_agree
    return {
        "mode": "eb_decision", "agree": agree,
        "winner_agree": winner_agree, "gate_agree": gate_agree,
        "a": sa, "b": sb,
        "verdict": (f"CONFIRMED — both providers chose '{sa['winner']}'" if agree
                    else f"DIVERGENT — A='{sa['winner']}' vs B='{sb['winner']}'"
                         " (gate margin is hardware-sensitive; inspect before trusting)"),
    }


def reconcile_sha(a: str, b: str) -> dict:
    agree = a.strip().lower() == b.strip().lower() and bool(a.strip())
    return {"mode": "sha", "agree": agree, "a": a, "b": b,
            "verdict": ("REPRODUCIBLE — identical footer_sha256 across clouds" if agree
                        else "NON-IDENTICAL — seeded adapters differ (GPU nondeterminism "
                             "or a real divergence; diff the training logs)")}


def main() -> None:
    ap = argparse.ArgumentParser(description="Reconcile two redundant provider runs")
    ap.add_argument("--decision", nargs=2, metavar=("A", "B"), help="two decision.json paths")
    ap.add_argument("--sha", nargs=2, metavar=("A", "B"), help="two footer_sha256 values")
    ap.add_argument("--json", action="store_true", help="read {'a':...,'b':...} from stdin")
    args = ap.parse_args()

    if args.decision:
        report = reconcile_decisions(_load(args.decision[0]), _load(args.decision[1]))
    elif args.sha:
        report = reconcile_sha(args.sha[0], args.sha[1])
    elif args.json:
        pair = json.load(sys.stdin)
        report = reconcile_decisions(pair["a"], pair["b"])
    else:
        ap.print_help()
        sys.exit(2)

    print(json.dumps(report, indent=2))
    sys.exit(0 if report["agree"] else 1)


if __name__ == "__main__":
    main()
