#!/usr/bin/env python3
"""Build a self-training set from the spiral escalation corpus (#2976 sink).

Reads every ``data/eval/spiral/*.jsonl`` row emitted by ``spiral-harness.js``
(``_defaultCorpus``) and turns the exec-verified solutions into a
replay-balanced, reward-weighted SFT set for the local coder (Ouro lane).

Design inputs (session 2026-07-27):
- RWOPD (arXiv:2605.13501): weight verifier-passing rollouts by verdict tier
  instead of discarding partials — here: escalated solves (the cheap tier
  FAILED, the escalation rung passed exec-verify) carry weight 1.0 as the
  rung-lift signal; cheap solves carry a lower replay weight.
- #2729: pure-distill collapses the base; replay balance is mandatory. The
  cheap-solved rows ARE the replay set — problems the student's rung already
  handles — so the mix falls out of the corpus itself.
- Aletheia (arXiv:2601.14290): do NOT try to distill the escalation/backtrack
  behavior into the student (5% transfer). Control flow stays in the harness;
  the student only trains on (prompt -> verified solution).

Known gap (recorded, not papered over): the corpus sink does not store the
FAILED cheap attempt on escalated rows, so contrastive / repair-style pairs
cannot be built yet. Emitting that field is the top schema ask for the next
spiral update (see --report).

Usage:
  python scripts/spiral_build_self_train.py            # write set + report
  python scripts/spiral_build_self_train.py --dry-run  # report only
"""
import argparse
import glob
import hashlib
import json
import os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(REPO, "data", "eval", "spiral")
OUT_PATH = os.path.join(SRC_DIR, "self-train", "spiral-self-train-v1.jsonl")

# RWOPD-style verdict weights. Escalated rows are the lift signal (a rung the
# student could not clear, solved and exec-verified by the higher rung);
# cheap rows are replay anchors against distribution collapse (#2729).
WEIGHT_ESCALATED = 1.0
WEIGHT_CHEAP_REPLAY = 0.4


def rows(src_dir):
    for f in sorted(glob.glob(os.path.join(src_dir, "*.jsonl"))):
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if r.get("prompt") and r.get("solution"):
                    r["_src"] = os.path.basename(f)
                    yield r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--src", default=SRC_DIR)
    ap.add_argument("--out", default=OUT_PATH)
    args = ap.parse_args()

    seen = set()
    out, n_esc, n_cheap, n_dup = [], 0, 0, 0
    for r in rows(args.src):
        key = hashlib.sha256(
            (r["prompt"] + "\x00" + r["solution"]).encode("utf-8")
        ).hexdigest()
        if key in seen:
            n_dup += 1
            continue
        seen.add(key)
        escalated = r.get("tier") == "escalated" or r.get("distillTarget")
        if escalated:
            n_esc += 1
        else:
            n_cheap += 1
        out.append(
            {
                "id": r.get("id"),
                "prompt": r["prompt"],
                "completion": r["solution"],
                "weight": WEIGHT_ESCALATED if escalated else WEIGHT_CHEAP_REPLAY,
                "role": "rung_lift" if escalated else "replay",
                "tier": r.get("tier"),
                "entry_point": r.get("entry_point"),
                "tests": r.get("tests"),  # keep the exec-verify contract with the row
                "source_file": r["_src"],
                "provenance": "spiral-harness exec-verified (fix-rate)",
            }
        )

    total = len(out)
    report = {
        "total": total,
        "rung_lift": n_esc,
        "replay": n_cheap,
        "duplicates_dropped": n_dup,
        "replay_ratio": round(n_cheap / total, 3) if total else None,
        "schema_gaps_for_next_spiral_update": [
            "failed cheap attempt not stored on escalated rows -> no contrastive/repair pairs",
            "no per-turn verify detail (which tests failed) -> no partial-credit weights beyond the tier binary",
            "no cost/model fields on corpus rows -> cannot compute oracle-router savings from this sink alone",
        ],
    }
    print(json.dumps(report, indent=2))
    if args.dry_run:
        return
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        for rec in out:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(f"wrote {total} records -> {args.out}")


if __name__ == "__main__":
    main()
