"""M1 (No-Free-Confidence) LONGITUDINAL test on the real convergance ledger.

The static scan (owned_math_m1_m2_ledger_scan.py) measures the terms of the
No-Free-Confidence inequality at a single point in time (total / evidence-backed
/ free confidence mass, both-class grading). This script adds the missing
LONGITUDINAL half asked for in #2786 "Next (2)":

    per-hypothesis confidence TRAJECTORIES vs grounding events -> count violations.

Conjecture (M1): justified confidence can only grow with external-evidence
influx.  Operationally, along a single hypothesis's time-ordered record series,
a step where confidence RISES (dc > EPS) with NO new evidence/grounding/
verification between the two records is a "free-confidence" violation -- exactly
the KILL condition: "confidence grows with zero evidence influx and no canary".

Method
------
1. Load data/convergence/records.jsonl.
2. Group records by a normalized hypothesis/claim string.
3. EXCLUDE placeholder buckets: records whose hypothesis is a generic stub
   (e.g. "model interaction") are NOT a single hypothesis re-asserted over time
   -- they are unrelated interactions filed under one placeholder label, so
   grouping them fabricates a spurious trajectory. We detect and quarantine
   these rather than let them pollute the violation count.
4. For each GENUINE series (>= 2 records), sort by timestamp and inspect every
   consecutive (prev, next) pair:
      dc = c_next - c_prev
      evidence_added = next has evidence/grounding/verification that prev lacked
      violation = (dc > EPS) and (not evidence_added)
5. Count violations; emit per-series detail for any violator; write JSON.

Honest scope: this scans the ledger as it is. Where the data cannot support the
test (no stable per-hypothesis id; placeholder bucketing; one-shot records that
never change confidence), that limitation is reported as the finding -- a clean
result here is only as strong as the trajectories the ledger actually records.

Run:  python experiments/owned_math_m1_longitudinal.py
"""

from __future__ import annotations

import json
import os
import re
from collections import defaultdict
from datetime import datetime, timezone

DEFAULT_RECORDS = [
    os.path.join("data", "convergence", "records.jsonl"),
    r"C:\dev\lantern-os\data\convergence\records.jsonl",
]
OUT = os.path.join("experiments", "results", "owned_math_m1_longitudinal.json")

EPS = 0.01  # minimum confidence rise counted as a "growth" step

# Generic placeholder hypothesis labels: a bucket of unrelated interactions filed
# under one stub, NOT one hypothesis re-asserted. Grouping these fabricates a
# trajectory, so they are quarantined from the violation count (and reported).
PLACEHOLDER_HYPOTHESES = {
    "model interaction",
    "",
}


def _first_existing(paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return None


def _parse_ts(ts):
    if not ts or not isinstance(ts, str):
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _load_jsonl(path):
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
    return rows, bad


def _norm_hypothesis(r):
    h = r.get("hypothesis") or r.get("claim") or ""
    return re.sub(r"\s+", " ", str(h).strip().lower())[:160]


# Evidence-field values that explicitly mean "no external support was found". A record can
# carry a NON-empty `evidence`/`source` string that literally says there is none — e.g.
# evidence="no match found", source="none" — and scoring those as support made a legitimate
# ungrounded→grounded confidence rise read as a free-confidence violation: the same claim went
# 0.6 ("no match found", sources []) → 0.85 ("codebase: PROVIDERS.md, SCRIPTS.md", sources [1])
# 11 days apart, which is evidence being ADDED, exactly what M1 permits (#2786).
_NULL_EVIDENCE = {"", "none", "no match found", "no matches", "no evidence", "not found", "n/a", "unknown"}


def _is_real_support(v):
    """A scalar support field counts unless it's absent or a null-evidence sentinel."""
    return 0 if str(v).strip().lower() in _NULL_EVIDENCE else 1


def _support_count(v):
    """Support magnitude of a field: list → count of non-sentinel entries; str → 0/1;
    absent/None → 0. Used per-field so growth in ANY field registers as influx."""
    if isinstance(v, (list, tuple)):
        return sum(_is_real_support(x) for x in v)
    if isinstance(v, str):
        return _is_real_support(v)
    return 1 if v else 0


def _evidence_signature(r):
    """A hashable signature of the external-evidence support attached to a record.

    Growth of this signature between two records = evidence influx. Each support field is
    its OWN dimension — NOT an `or`-chain that stops at the first present field — so grounding
    added to a field the previous record left empty (sources []→["codebase: …"]) always
    registers. Null-evidence sentinels ("no match found", source "none", …) score 0, so an
    ungrounded→grounded rise reads as evidence added, not free confidence (#2786)."""
    return (
        _support_count(r.get("evidence_ids")),
        _support_count(r.get("evidence")),
        _support_count(r.get("applied_evidence")),
        _support_count(r.get("sources")),
        _is_real_support(r.get("source")),
        _support_count(r.get("grounding_signals")),
        int(bool(r.get("verified"))),
        int(str(r.get("result", "")).lower() == "grounded"),
    )


def _evidence_added(prev, nxt):
    """True if `nxt` carries strictly more external support than `prev`."""
    p, n = _evidence_signature(prev), _evidence_signature(nxt)
    return any(n[i] > p[i] for i in range(len(p)))


def main(argv=None):
    path = _first_existing(DEFAULT_RECORDS)
    if not path:
        print("[m1-long] no records.jsonl found; nothing to scan")
        return 1
    rows, bad = _load_jsonl(path)

    by_h = defaultdict(list)
    for r in rows:
        by_h[_norm_hypothesis(r)].append(r)

    genuine, placeholder = {}, {}
    for k, recs in by_h.items():
        if len(recs) < 2:
            continue
        if k in PLACEHOLDER_HYPOTHESES:
            placeholder[k] = recs
        else:
            genuine[k] = recs

    violations = []
    series_with_numeric = 0
    series_with_variation = 0
    growth_steps = 0

    for k, recs in genuine.items():
        timed = [(_parse_ts(r.get("timestamp") or r.get("ts")), r) for r in recs]
        timed = [(t, r) for t, r in timed if t is not None]
        timed.sort(key=lambda e: e[0])
        confs = [r.get("confidence") for _, r in timed if isinstance(r.get("confidence"), (int, float))]
        if len(confs) >= 2:
            series_with_numeric += 1
            if max(confs) != min(confs):
                series_with_variation += 1
        for (t0, prev), (t1, nxt) in zip(timed, timed[1:]):
            c0, c1 = prev.get("confidence"), nxt.get("confidence")
            if not isinstance(c0, (int, float)) or not isinstance(c1, (int, float)):
                continue
            dc = c1 - c0
            if dc > EPS:
                growth_steps += 1
                if not _evidence_added(prev, nxt):
                    violations.append({
                        "hypothesis": k,
                        "from_conf": c0, "to_conf": c1, "delta": round(dc, 4),
                        "from_ts": (t0.isoformat() if t0 else None),
                        "to_ts": (t1.isoformat() if t1 else None),
                        "from_ev": _evidence_signature(prev),
                        "to_ev": _evidence_signature(nxt),
                    })

    # Characterize the quarantined placeholder buckets (reported, not tested).
    placeholder_report = {}
    for k, recs in placeholder.items():
        confs = [r.get("confidence") for r in recs if isinstance(r.get("confidence"), (int, float))]
        placeholder_report[k] = {
            "n_records": len(recs),
            "distinct_confidences": sorted(set(confs)),
            "note": "unrelated interactions under one stub label; not a trajectory",
        }

    result = {
        "source": path,
        "n_records": len(rows),
        "malformed_lines": bad,
        "n_distinct_hypotheses": len(by_h),
        "n_series_ge2": sum(1 for v in by_h.values() if len(v) >= 2),
        "n_genuine_series": len(genuine),
        "n_placeholder_buckets": len(placeholder),
        "genuine_series_with_numeric_conf": series_with_numeric,
        "genuine_series_with_conf_variation": series_with_variation,
        "confidence_growth_steps_examined": growth_steps,
        "no_free_confidence_violations": len(violations),
        "violations": violations[:50],
        "placeholder_buckets": placeholder_report,
        "eps": EPS,
        "verdict": _verdict(genuine, series_with_variation, len(violations), growth_steps),
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    # ASCII-only summary (stdout may be cp1252 on Windows).
    print("[m1-long] records=%d  distinct-hypotheses=%d  series>=2=%d"
          % (result["n_records"], result["n_distinct_hypotheses"], result["n_series_ge2"]))
    print("[m1-long] genuine series=%d  placeholder buckets quarantined=%d"
          % (result["n_genuine_series"], result["n_placeholder_buckets"]))
    print("[m1-long] genuine series with confidence VARIATION=%d  growth steps examined=%d"
          % (result["genuine_series_with_conf_variation"], result["confidence_growth_steps_examined"]))
    print("[m1-long] NO-FREE-CONFIDENCE VIOLATIONS = %d" % result["no_free_confidence_violations"])
    print("[m1-long] verdict: %s" % result["verdict"])
    print("[m1-long] wrote %s" % OUT)
    return 0


def _verdict(genuine, varied, n_viol, growth_steps):
    if n_viol > 0:
        return ("VIOLATIONS FOUND (%d) -- confidence rose without evidence influx along a "
                "genuine hypothesis series; the M1 mapping or the clamp is leaking." % n_viol)
    if growth_steps == 0:
        return ("UNDER-POWERED: 0 confidence-growth steps across %d genuine series -- the "
                "ledger records hypotheses one-shot (no re-assessment with rising confidence), "
                "so the longitudinal test cannot fire. It confirms the STATIC clamp holds but "
                "does not stress the trajectory claim. To gain power the ledger needs a stable "
                "per-hypothesis id linking re-assessments (and to stop bucketing unrelated "
                "records under placeholder hypothesis text)." % len(genuine))
    return ("PASS (weak): %d growth steps examined across genuine series, all accompanied by "
            "evidence influx; 0 free-confidence violations." % growth_steps)


if __name__ == "__main__":
    raise SystemExit(main())
