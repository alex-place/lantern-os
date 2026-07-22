"""M2 second pass — run the kill criterion: bootstrap stability of the EOQ T*.

Cluster bootstrap over KEYS of grounding-calibration.jsonl (the honest unit —
events within a key are dependent): resample keys with replacement B times,
recompute the de-burst exposure MLE rho and T* = sqrt(2*ratio/rho) at
p_v/p_e = 0.1. Report the spread. The claim's kill criterion is "fitted T*
wildly unstable across resamples" — this script decides it on today's data.

Run:  python experiments/owned_math_m2_bootstrap.py
"""

from __future__ import annotations

import json
import math
import os
from collections import defaultdict
from datetime import datetime, timezone

import numpy as np

CAL = [
    os.path.join("data", "convergence", "grounding-calibration.jsonl"),
    r"C:\dev\lantern-os\data\convergence\grounding-calibration.jsonl",
]
OUT = os.path.join("experiments", "results", "owned_math_m2_bootstrap.json")
B = 2000
MIN_DT_S = 60.0
RATIO = 0.1


def load_events():
    path = next((p for p in CAL if os.path.exists(p)), None)
    by_key = defaultdict(list)
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                r = json.loads(line)
            except (json.JSONDecodeError, TypeError):
                continue
            try:
                t = datetime.fromisoformat(str(r.get("ts", "")).replace("Z", "+00:00"))
            except ValueError:
                continue
            o = r.get("outcome")
            if o in (0, 1, True, False):
                by_key[str(r.get("key", "?"))].append(
                    (t.astimezone(timezone.utc), 1 if o in (1, True) else 0))
    for k in by_key:
        by_key[k].sort(key=lambda e: e[0])
    return by_key


def key_stats(events):
    flips, exposure = 0, 0.0
    for (t0, o0), (t1, o1) in zip(events, events[1:]):
        dt = (t1 - t0).total_seconds()
        if dt < MIN_DT_S:
            continue
        if o0 == 1:
            exposure += dt
            if o1 == 0:
                flips += 1
    return flips, exposure


def main():
    by_key = load_events()
    keys = list(by_key)
    per_key = {k: key_stats(v) for k, v in by_key.items()}
    rng = np.random.default_rng(23)

    tstars, halflives, undefined = [], [], 0
    for _ in range(B):
        sample = rng.choice(len(keys), size=len(keys), replace=True)
        flips = sum(per_key[keys[i]][0] for i in sample)
        expo = sum(per_key[keys[i]][1] for i in sample)
        if flips == 0 or expo <= 0:
            undefined += 1
            continue
        rho = flips / expo                      # per second
        halflives.append(math.log(2) / rho / 3600.0)
        tstars.append(math.sqrt(2 * RATIO / rho) / 60.0)

    def q(a, p):
        return round(float(np.percentile(a, p)), 1) if a else None

    report = {
        "n_keys": len(keys),
        "per_key_flips_exposure_h": {k: [v[0], round(v[1] / 3600, 1)] for k, v in per_key.items()},
        "bootstrap_B": B,
        "undefined_resamples (0 flips)": undefined,
        "undefined_fraction": round(undefined / B, 3),
        "halflife_hours": {"p2.5": q(halflives, 2.5), "median": q(halflives, 50), "p97.5": q(halflives, 97.5)},
        "Tstar_minutes (p_v/p_e=0.1)": {"p2.5": q(tstars, 2.5), "median": q(tstars, 50), "p97.5": q(tstars, 97.5)},
        "kill_criterion": "T* unstable across resamples",
        "verdict": None,
    }
    if undefined / B > 0.2 or (tstars and (np.percentile(tstars, 97.5) / max(np.percentile(tstars, 2.5), 1e-9) > 5)):
        report["verdict"] = (
            "UNSTABLE on today's data — the estimator is fine but the 6-key bursty "
            "ledger cannot support a cadence decision; instrumentation (spaced probes, "
            "many keys) must land before per-topic T* ships. Kill criterion FIRES for "
            "the data, not the law."
        )
    else:
        report["verdict"] = "Stable enough to proceed to per-topic fits."
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
