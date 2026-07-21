"""M1/M2 first tests on the real convergance ledgers (owned-math conjecture slate).

M1 (No-Free-Confidence): measure the terms of the conjectured inequality as they
exist in data/convergence/records.jsonl today — total confidence mass, evidence-
backed mass, the *free-confidence* mass (confident + unanchored + unverified),
and the both-class split of graded records.

M2 (Grounding half-life): fit the staleness rate rho from the per-key event
stream in data/convergence/grounding-calibration.jsonl (ages from a success
observation to the next failure observation of the same key = staleness
samples; exposure-based MLE handles right-censoring crudely), then derive the
EOQ-style optimal re-grounding interval T* = sqrt(2 * (p_verify/p_error) / rho)
and compare it to the shipped 30-minute GROUNDING_TICK.

Honest scope: this scans the ledgers as they are; where a field needed by the
conjecture does not exist, that absence is reported as a finding, not papered
over. Run:  python experiments/owned_math_m1_m2_ledger_scan.py
"""

from __future__ import annotations

import json
import math
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

DEFAULT_RECORDS = [
    os.path.join("data", "convergence", "records.jsonl"),
    r"C:\dev\lantern-os\data\convergence\records.jsonl",
]
DEFAULT_CAL = [
    os.path.join("data", "convergence", "grounding-calibration.jsonl"),
    r"C:\dev\lantern-os\data\convergence\grounding-calibration.jsonl",
]
OUT = os.path.join("experiments", "results", "owned_math_m1_m2_ledger_scan.json")


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


def scan_m1(records):
    n = len(records)
    conf_total = 0.0
    conf_backed = 0.0
    conf_free = 0.0
    free_high = 0  # confidence >= 0.8, no evidence, unverified
    verified_true = 0
    verified_with_refute_note = 0
    fields_seen = defaultdict(int)
    per_reasoner_free = defaultdict(float)

    refuted_true = 0
    graded_any = 0
    for r in records:
        for k in r.keys():
            fields_seen[k] += 1
        c = r.get("confidence")
        c = float(c) if isinstance(c, (int, float)) else 0.0
        ev = r.get("evidence_ids") or r.get("evidence") or r.get("applied_evidence") or r.get("sources") or []
        has_evidence = bool(ev)
        verified = bool(r.get("verified"))
        refuted = bool(r.get("refuted"))
        graded = verified or refuted or ("refuted" in r)  # both-class grading present
        conf_total += c
        if graded:
            graded_any += 1
        if has_evidence or graded:
            conf_backed += c
        else:
            conf_free += c
            per_reasoner_free[str(r.get("reasoner", r.get("agent", "?")))] += c
            if c >= 0.8:
                free_high += 1
        if verified:
            verified_true += 1
        if refuted:
            refuted_true += 1

    return {
        "n_records": n,
        "confidence_mass_total": round(conf_total, 2),
        "confidence_mass_evidence_or_graded": round(conf_backed, 2),
        "confidence_mass_FREE": round(conf_free, 2),
        "free_mass_fraction": round(conf_free / conf_total, 4) if conf_total else None,
        "n_high_conf_unanchored (c>=0.8, no evidence, ungraded)": free_high,
        "n_graded_any_class": graded_any,
        "n_verified_true": verified_true,
        "n_refuted_true (both-class)": refuted_true,
        "top_free_mass_by_reasoner": dict(
            sorted(per_reasoner_free.items(), key=lambda kv: -kv[1])[:5]
        ),
        "fields_present": {k: v for k, v in sorted(fields_seen.items(), key=lambda kv: -kv[1])},
    }


def scan_m2(cal_rows):
    by_key = defaultdict(list)
    for r in cal_rows:
        t = _parse_ts(r.get("ts"))
        if t is None:
            continue
        out = r.get("outcome")
        if out not in (0, 1, True, False):
            continue
        by_key[str(r.get("key", "?"))].append((t, 1 if out in (1, True) else 0))

    MIN_DT_S = 60.0           # de-burst: probes < 60 s apart are one observation
    flip_ages_s = []          # success -> next observation is failure
    exposure_s = 0.0          # total time spent "last observation was success"
    n_flips = 0
    n_burst_dropped = 0
    for key, events in by_key.items():
        events.sort(key=lambda e: e[0])
        for (t0, o0), (t1, o1) in zip(events, events[1:]):
            dt = (t1 - t0).total_seconds()
            if dt <= 0:
                continue
            if dt < MIN_DT_S:
                n_burst_dropped += 1
                continue
            if o0 == 1:
                exposure_s += dt
                if o1 == 0:
                    n_flips += 1
                    flip_ages_s.append(dt)

    result = {
        "n_events": sum(len(v) for v in by_key.values()),
        "n_keys": len(by_key),
        "n_burst_pairs_dropped (<60s)": n_burst_dropped,
        "n_success_to_failure_flips": n_flips,
        "exposure_hours_after_success": round(exposure_s / 3600.0, 2),
    }
    if n_flips == 0 or exposure_s <= 0:
        result["verdict"] = (
            "INSTRUMENTATION GAP: no success->failure flip ages measurable — "
            "the calibration ledger is too thin/bursty to fit rho yet"
        )
        return result

    rho_per_s = n_flips / exposure_s  # censored-exposure MLE (exponential)
    half_life_h = math.log(2) / rho_per_s / 3600.0
    result["rho_per_hour"] = round(rho_per_s * 3600.0, 6)
    result["staleness_half_life_hours"] = round(half_life_h, 2)
    result["median_flip_age_minutes"] = round(
        sorted(flip_ages_s)[len(flip_ages_s) // 2] / 60.0, 1
    )
    tstars = {}
    for ratio in (0.01, 0.1, 1.0):  # p_verify / p_error
        tstar_s = math.sqrt(2.0 * ratio / rho_per_s)
        tstars[f"p_v/p_e={ratio}"] = f"{tstar_s/60.0:.1f} min"
    result["T_star_EOQ"] = tstars
    result["shipped_GROUNDING_TICK"] = "30.0 min"
    return result


def main():
    rec_path = _first_existing(DEFAULT_RECORDS)
    cal_path = _first_existing(DEFAULT_CAL)
    report = {"records_path": rec_path, "calibration_path": cal_path}

    if rec_path:
        records, bad = _load_jsonl(rec_path)
        report["m1_no_free_confidence"] = scan_m1(records)
        report["m1_no_free_confidence"]["n_malformed_lines"] = bad
    else:
        report["m1_no_free_confidence"] = {"error": "records.jsonl not found"}

    if cal_path:
        cal, bad = _load_jsonl(cal_path)
        report["m2_grounding_half_life"] = scan_m2(cal)
        report["m2_grounding_half_life"]["n_malformed_lines"] = bad
    else:
        report["m2_grounding_half_life"] = {"error": "grounding-calibration.jsonl not found"}

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    json.dump(report, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
