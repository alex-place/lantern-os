"""M6 first test — can canary-events.jsonl support a lead-time analysis?

The lasing-threshold claim needs per-generation signal TRAJECTORIES (gain vs
leak over time) to test whether threshold crossings precede canary firings.
This census establishes what the event log actually contains.

Run:  python experiments/owned_math_m6_canary_census.py
"""

from __future__ import annotations

import json
import os
from collections import Counter

CAND = [
    os.path.join("data", "convergence", "canary-events.jsonl"),
    r"C:\dev\lantern-os\data\convergence\canary-events.jsonl",
]
OUT = os.path.join("experiments", "results", "owned_math_m6_canary_census.json")


def main():
    path = next((p for p in CAND if os.path.exists(p)), None)
    events, bad = [], 0
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                bad += 1

    fields = Counter()
    tripped = Counter()
    has_series = 0
    signal_keys = Counter()
    for e in events:
        for k in e:
            fields[k] += 1
        for t in e.get("tripped", []) or []:
            tripped[t] += 1
        sig = (e.get("collapse") or {}).get("signals") or {}
        for k, v in sig.items():
            signal_keys[k] += 1
            if isinstance(v, list) and len(v) > 1:
                has_series += 1

    report = {
        "path": path,
        "n_events": len(events),
        "n_malformed": bad,
        "fields": dict(fields),
        "tripped_distribution": dict(tripped),
        "signal_keys_seen": dict(signal_keys),
        "events_with_time_series_signals": has_series,
        "verdict": (
            "LEAD-TIME ANALYSIS NOT YET POSSIBLE: events are terminal per-generation "
            "snapshots (scalar signals at fire/pass time); the lasing-threshold test "
            "needs per-token signal trajectories. Instrumentation ask: behind a flag, "
            "log the per-token signal vector (selfRepeat, ngramEcho, entropy-z, exit "
            "depth) for BOTH fired and non-fired generations, sampled; then estimate "
            "per-mode gain/leak and measure crossing→fire lead time."
            if has_series == 0 else
            "Some series present — lead-time analysis partially possible; see fields."
        ),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
