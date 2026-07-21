"""M2 third pass — cross-ledger survey: which existing stream can power rho TODAY?

The bootstrap showed grounding-calibration.jsonl cannot support a staleness fit.
Before building new instrumentation, survey every longitudinal outcome ledger the
repo already writes and grade each on rho-fittability: does any key/entity have
>=2 time-separated (>60s) outcome observations, with both outcome classes present?

Run:  python experiments/owned_math_m2_ledger_survey.py
"""

from __future__ import annotations

import json
import os
from collections import defaultdict
from datetime import datetime, timezone

ROOTS = [".", r"C:\dev\lantern-os"]
LEDGERS = [
    ("grounding-calibration", "data/convergence/grounding-calibration.jsonl",
     ("key",), ("outcome",), ("ts",)),
    ("trading-trades", "data/trading/trades.jsonl",
     ("market", "ticker", "symbol", "market_ticker"), ("outcome", "result", "won", "pnl", "realized_pnl"), ("ts", "timestamp", "time")),
    ("trading-signals", "data/trading/signals.jsonl",
     ("market", "ticker", "symbol", "market_ticker"), ("outcome", "result", "won", "resolved"), ("ts", "timestamp", "time")),
    ("kalshi-cio-accuracy", "data/kalshi/cio-accuracy-log.jsonl",
     ("date", "run", "market"), ("accuracy", "n_resolved"), ("date", "ts", "timestamp")),
    ("council-reviews", "data/convergence/council-reviews.jsonl",
     ("pr", "issue", "id", "target"), ("verdict", "approved", "delta"), ("ts", "timestamp")),
    ("canary-events", "data/convergence/canary-events.jsonl",
     ("agent", "provider", "surface"), ("tripped",), ("ts",)),
]
OUT = os.path.join("experiments", "results", "owned_math_m2_ledger_survey.json")


def parse_ts(v):
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def first(r, names):
    for nm in names:
        if nm in r and r[nm] is not None:
            return nm, r[nm]
    return None, None


def survey(path, key_names, out_names, ts_names):
    rows, bad = [], 0
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                bad += 1
    by_key = defaultdict(list)
    key_field = out_field = ts_field = None
    for r in rows:
        kf, kv = first(r, key_names)
        of, ov = first(r, out_names)
        tf, tv = first(r, ts_names)
        t = parse_ts(tv)
        if kv is None or ov is None or t is None:
            continue
        key_field, out_field, ts_field = kf, of, tf
        by_key[str(kv)].append((t, json.dumps(ov, default=str)[:40]))

    fittable_keys = 0
    for k, evs in by_key.items():
        evs.sort()
        spaced = [e for i, e in enumerate(evs)
                  if i == 0 or (e[0] - evs[i - 1][0]).total_seconds() >= 60]
        outcomes = {e[1] for e in spaced}
        if len(spaced) >= 2 and len(outcomes) >= 2:
            fittable_keys += 1
    return {
        "n_rows": len(rows), "n_malformed": bad,
        "fields_used": {"key": key_field, "outcome": out_field, "ts": ts_field},
        "n_keys_with_usable_fields": len(by_key),
        "n_rho_fittable_keys (>=2 spaced obs, both classes)": fittable_keys,
    }


def main():
    report = {}
    for name, rel, kn, on, tn in LEDGERS:
        path = next((os.path.join(r, rel) for r in ROOTS if os.path.exists(os.path.join(r, rel))), None)
        if not path:
            report[name] = {"exists": False}
            continue
        try:
            report[name] = {"exists": True, **survey(path, kn, on, tn)}
        except Exception as e:  # survey must never die on one weird ledger
            report[name] = {"exists": True, "error": str(e)[:120]}

    best = max((v.get("n_rho_fittable_keys (>=2 spaced obs, both classes)", 0), k)
               for k, v in report.items() if isinstance(v, dict))
    report["_verdict"] = (
        f"Best available stream: {best[1]} with {best[0]} fittable keys. "
        + ("Enough to pilot a per-key rho fit." if best[0] >= 10 else
           "NO stream is rich enough — the spaced-probe instrumentation (#2787) is "
           "confirmed as the only path to M2's cadence law.")
    )
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
