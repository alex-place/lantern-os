#!/usr/bin/env python3
"""Oracle-router ceiling from replayed cascade logs (#2998 slice 3).

Spiral's cheap→frontier cascade escalates whenever the cheap (local/owned) tier fails its
verifier. Some of those escalations don't pay off — the frontier (rented) tier fails too — so
they spend a rented call for nothing. A perfect *oracle router* that knew in advance which tier
would solve each task would escalate ONLY when the cheap tier fails AND the frontier tier
succeeds, and never otherwise. The gap between the live cascade and that oracle is the CEILING
on what any smarter router could save — it tells you whether the "learned router" plank in
#2998 is even worth building, before spending a training run on it.

Cost axis = **rented-frontier calls** (the $ axis): the cheap tier is local/owned and ~free at
the margin, the frontier tier is rented. Latency is reported as a secondary proxy. This is pure
replay of existing logs — no model calls, no training, offline.

Log schema (data/eval/cascade/*.jsonl): one row per task with `task`, `cheap_ok`, `frontier_ok`,
`cheap_lat`, `frontier_lat`, `cascade_tier`, `final_ok`. Rows missing the two `*_ok` verdicts are
skipped (can't place them on the router surface) and counted.

Run:  python scripts/spiral_oracle_ceiling.py            # default logs
      python scripts/spiral_oracle_ceiling.py data/eval/cascade/verified-cascade-live.jsonl ...
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys

DEFAULT_LOGS = [
    os.path.join("data", "eval", "cascade", "verified-cascade-live.jsonl"),
    os.path.join("data", "eval", "cascade", "verified-cascade-live-hard.jsonl"),
]


def load_rows(paths):
    """Return (usable_rows, skipped) — a row is usable iff it carries both tier verdicts."""
    rows, skipped = [], 0
    for p in paths:
        if not os.path.exists(p):
            continue
        with open(p, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    skipped += 1
                    continue
                if "cheap_ok" not in r or "frontier_ok" not in r:
                    skipped += 1
                    continue
                rows.append(r)
    return rows, skipped


def _lat(r, key):
    v = r.get(key)
    return float(v) if isinstance(v, (int, float)) else 0.0


def analyze(rows):
    """Compute per-policy solve-rate + rented-frontier-call count + latency over the rows.

    Policies:
      always_cheap    — never escalate.
      always_frontier — always use the rented tier.
      cascade_actual  — cheap first, escalate on cheap failure (what Spiral ships): a frontier
                        call whenever the cheap tier failed, whether or not it helps.
      oracle_router   — the CEILING: escalate only when cheap fails AND frontier succeeds; use
                        cheap when it already solves. Solves every task ANY tier can solve, at the
                        fewest possible rented calls.
    """
    n = len(rows)
    out = {"n": n}
    if n == 0:
        return out

    def pol(solved_fn, frontier_fn, lat_fn):
        return {
            "solved": sum(1 for r in rows if solved_fn(r)),
            "solve_rate": round(sum(1 for r in rows if solved_fn(r)) / n, 4),
            "frontier_calls": sum(1 for r in rows if frontier_fn(r)),
            "total_lat_s": round(sum(lat_fn(r) for r in rows), 2),
        }

    cheap_ok = lambda r: bool(r.get("cheap_ok"))
    front_ok = lambda r: bool(r.get("frontier_ok"))

    out["always_cheap"] = pol(cheap_ok, lambda r: False, lambda r: _lat(r, "cheap_lat"))
    out["always_frontier"] = pol(front_ok, lambda r: True, lambda r: _lat(r, "frontier_lat"))
    # cascade: escalate whenever cheap failed; solved if either tier solved on its turn
    out["cascade_actual"] = pol(
        lambda r: cheap_ok(r) or front_ok(r),
        lambda r: not cheap_ok(r),
        lambda r: _lat(r, "cheap_lat") + (0.0 if cheap_ok(r) else _lat(r, "frontier_lat")),
    )
    # oracle: escalate only when cheap fails AND frontier helps
    out["oracle_router"] = pol(
        lambda r: cheap_ok(r) or front_ok(r),
        lambda r: (not cheap_ok(r)) and front_ok(r),
        lambda r: _lat(r, "cheap_lat") + (_lat(r, "frontier_lat") if (not cheap_ok(r) and front_ok(r)) else 0.0),
    )

    # The headroom: escalations the live cascade spends that never pay off (both tiers fail).
    wasted = sum(1 for r in rows if (not cheap_ok(r)) and (not front_ok(r)))
    casc_front = out["cascade_actual"]["frontier_calls"]
    orac_front = out["oracle_router"]["frontier_calls"]
    out["ceiling"] = {
        "wasted_escalations_both_fail": wasted,
        "cascade_frontier_calls": casc_front,
        "oracle_frontier_calls": orac_front,
        "frontier_calls_saved_by_perfect_router": casc_front - orac_front,
        "frontier_call_reduction_pct": (round(100 * (casc_front - orac_front) / casc_front, 1)
                                        if casc_front else None),
        # cascade and oracle solve the SAME set (any-tier-solvable), so the only gain a router can
        # offer here is spending fewer rented calls — never a higher solve rate. Say so plainly.
        "solve_rate_gain_over_cascade": round(out["oracle_router"]["solve_rate"]
                                              - out["cascade_actual"]["solve_rate"], 4),
        "verdict": _verdict(casc_front, orac_front, n),
    }
    return out


def _verdict(casc_front, orac_front, n):
    if casc_front == 0:
        return ("cheap tier solved everything it could — zero escalations to optimize; a learned "
                "router has no headroom on this sample")
    saved = casc_front - orac_front
    if saved == 0:
        return ("every escalation the cascade made paid off — the cheap-first policy is already "
                "oracle-optimal on rented calls here; the router plank buys nothing on this sample")
    return (f"a perfect router would skip {saved}/{casc_front} escalations (both-fail waste), "
            f"the ceiling on what a learned router could save on rented calls")


def render(report):
    lines = [f"# oracle-router ceiling — n={report['n']} cascade rows", ""]
    if report["n"] == 0:
        lines.append("no usable rows (need cheap_ok + frontier_ok per task).")
        return "\n".join(lines)
    lines.append(f"{'policy':16s} {'solve':>7} {'frontier$':>10} {'lat_s':>8}")
    for k in ("always_cheap", "always_frontier", "cascade_actual", "oracle_router"):
        p = report[k]
        lines.append(f"{k:16s} {p['solve_rate']:>7.3f} {p['frontier_calls']:>10d} {p['total_lat_s']:>8.1f}")
    c = report["ceiling"]
    lines += [
        "",
        f"wasted escalations (both tiers fail): {c['wasted_escalations_both_fail']}",
        f"frontier calls saved by a perfect router: {c['frontier_calls_saved_by_perfect_router']}"
        + (f" ({c['frontier_call_reduction_pct']}% fewer rented calls)"
           if c['frontier_call_reduction_pct'] is not None else ""),
        f"solve-rate gain a router could add over the cascade: {c['solve_rate_gain_over_cascade']:+.3f}",
        f"VERDICT: {c['verdict']}",
    ]
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Oracle-router ceiling from cascade logs (#2998 s3)")
    ap.add_argument("logs", nargs="*", help="cascade jsonl logs (default: verified-cascade-live[-hard])")
    ap.add_argument("--json", action="store_true", help="emit the report as JSON")
    ap.add_argument("--out", default=os.path.join("experiments", "results", "spiral_oracle_ceiling.json"))
    args = ap.parse_args(argv)

    paths = args.logs or [p for pat in DEFAULT_LOGS for p in glob.glob(pat)]
    rows, skipped = load_rows(paths)
    report = analyze(rows)
    report["sources"] = paths
    report["skipped_rows"] = skipped

    if args.json:
        print(json.dumps(report, indent=1))
    else:
        print(render(report))
        if skipped:
            print(f"\n({skipped} rows skipped — missing cheap_ok/frontier_ok)")
    if report["n"]:
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            json.dump(report, f, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
