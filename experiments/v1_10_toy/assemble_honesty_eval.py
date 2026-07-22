#!/usr/bin/env python3
"""
V0-C — assemble the POWERED, frozen honesty eval (survey G5) + declare the gates-off arm (G11).

The binding constraint the repo keeps hitting is eval POWER, not training (2026-07-13 memo:
n=40 -> +/-0.20 CI). SIGMA0-MODEL-DESIGN quantifies the honesty target:
  +/-5pp at p~=0.10 needs ~138 negatives ; +/-3pp at p~=0.05 needs ~203.
So the gate is >=140 held-out DE-GLOSSED negatives. This assembles them from:

  * the frozen probe sets (build_probe_sets.py): factual + assoc negatives are already
    clean, balanced, de-glossed statements with hard labels — a ready negative pool.
  * (later) the mined corpus negatives once session-mining lands real honesty negatives.

Output format = one eval item per line:
  {id, statement, truth: 0|1, family, split: train|holdout, source}
Frozen + versioned (seeded sha256 stratification). The HOLDOUT is what any future honesty
number is reported on; nothing may train on holdout ids.

Gates-off arm (G11): this file also writes eval-manifest.json declaring the TWO required arms
every promotion run must report — `gated` (Sigma_theta/honesty gates ON) and `ungated`
(helpful-only: gates OFF). We only assemble the dataset here; the harness consumes the manifest.
"""
import hashlib
import json
import os

PROBE = "data/eval/v1_10/probe-sets-v1.jsonl"
OUT = "data/eval/v1_10/honesty-eval-v1.jsonl"
MANIFEST = "data/eval/v1_10/eval-manifest.json"
HOLDOUT_FRAC = 0.45  # >=40% per D2; stratified


def split_of(item_id):
    h = int(hashlib.sha256(item_id.encode()).hexdigest(), 16) / 2**256
    return "holdout" if h < HOLDOUT_FRAC else "train"


def main():
    if not os.path.exists(PROBE):
        print(f"missing {PROBE} — run build_probe_sets.py first"); return 1
    rows = [json.loads(l) for l in open(PROBE, encoding="utf-8") if l.strip()]
    # Use factual + assoc (natural-language truth claims). arith is a probe control, not honesty.
    items = []
    for r in rows:
        if r["family"] not in ("factual", "assoc"):
            continue
        iid = f"he-{r['id']}"
        items.append({"id": iid, "statement": r["text"], "truth": r["label"],
                      "family": r["family"], "split": split_of(iid),
                      "source": "probe-sets-v1"})

    with open(OUT, "w", encoding="utf-8") as f:
        for it in items:
            f.write(json.dumps(it) + "\n")

    hold = [i for i in items if i["split"] == "holdout"]
    hold_neg = [i for i in hold if i["truth"] == 0]
    assoc_neg = [i for i in hold if i["truth"] == 0 and i["family"] == "assoc"]

    manifest = {
        "version": "honesty-eval-v1",
        "n_total": len(items), "n_holdout": len(hold), "n_holdout_negatives": len(hold_neg),
        "power": {"target_negatives": 140, "met": len(hold_neg) >= 140,
                  "note": ">=140 -> +/-5pp @ p~0.10 (SIGMA0-MODEL-DESIGN)"},
        "arms": {
            "gated": "Sigma_theta + honesty gates ON (shipping artifact)",
            "ungated": "helpful-only: gates OFF (G11 — measures the un-gated model, per Opus 4.6 practice)",
        },
        "metrics": ["confabulation_rate_on_negatives", "over_abstention_on_positives",
                    "golden_accuracy"],
        "rule": "report confab and over-abstention as SEPARATE columns; never rank across "
                "golden(floor) and holdout; nothing trains on split==holdout.",
        "gaps": ["assoc negatives are the 2510.09033 hard case",
                 "session-mined honesty negatives still pending (Vertex) — will expand holdout"],
    }
    os.makedirs(os.path.dirname(MANIFEST), exist_ok=True)
    json.dump(manifest, open(MANIFEST, "w", encoding="utf-8"), indent=2)

    print(f"wrote {len(items)} eval items -> {OUT}")
    print(f"  holdout: {len(hold)} (negatives {len(hold_neg)}, of which assoc {len(assoc_neg)})")
    met = "MET" if len(hold_neg) >= 140 else "NOT MET"
    print(f"  POWER GATE (>=140 holdout negatives): {met} ({len(hold_neg)}/140)")
    if len(hold_neg) < 140:
        print("  -> assemble more negatives (curate + session-mine) before any honesty number is trusted.")
    print(f"  manifest (+ gates-off arm declared) -> {MANIFEST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
