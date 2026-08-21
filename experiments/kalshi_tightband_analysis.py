"""
Kalshi tight-band trajectory analysis — does CIO have EARLY lead-time value?

The tight-band JSONL (data/kalshi/tight-band-*.jsonl) captures live in-game
markets at ~6-second resolution. As games resolve, prices converge from ~0.5
to 0 or 1. This harness asks:

    At what % of the game elapsed did Σ₀ first certify convergence to the
    winning side? The earlier, the more lead-time trading value CIO has.

Also builds per-ticker trajectory summaries used by C7 of the Impossibility
Engine (convergence certificate shifts the valid interval toward p*).

Output:
  - Console: lead-time report for each resolved market
  - data/kalshi/cio-trajectory-cache.jsonl: per-ticker latest CIO result

Run:  python experiments/kalshi_tightband_analysis.py [data/kalshi/tight-band-YYYY-MM-DD.jsonl]
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import List, Optional, Tuple

import torch

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kalshi_cio_backtest import Snapshot, MarketTrajectory, CIOConvergenceModel  # noqa: E402
from kalshi_snapshot_codec import iter_snapshots, find_snapshot_files  # noqa: E402

DT = torch.float64
RESOLVED_THRESHOLD = 0.95
MIN_POINTS = 6
CERT_EDGE   = 0.08

CACHE_OUT = Path(__file__).resolve().parents[1] / "data" / "kalshi" / "cio-trajectory-cache.jsonl"
ACCURACY_LOG = Path(__file__).resolve().parents[1] / "data" / "kalshi" / "cio-accuracy-log.jsonl"


def load_trajectories(path: Path) -> dict:
    by_ticker: dict[str, list] = defaultdict(list)
    meta: dict[str, dict] = {}

    # Decodes v1, v2 (keyframe+delta) and .gz transparently.
    for row in iter_snapshots(path):
        ts = (row.get("ts") or "")[:19]
        snap = row.get("snapshot", {})
        for m in snap.get("markets", []):
            ticker = m.get("ticker", "")
            if not ticker:
                continue
            ya_c = m.get("yes_ask") or 0
            na_c = m.get("no_ask") or 0
            ya = ya_c / 100.0
            na = na_c / 100.0
            if ya <= 0 and na <= 0:
                continue
            s = ya + na
            yes_mid = ya / s if s > 0 else 0.5
            by_ticker[ticker].append((ts, yes_mid, ya, na))
            if ticker not in meta:
                meta[ticker] = {
                    "close_time": m.get("close_time", ""),
                    "title": m.get("title") or m.get("ticker", ""),
                }

    trajs = {}
    for ticker, rows in by_ticker.items():
        rows.sort(key=lambda x: x[0])
        final_price = rows[-1][1]
        resolved = final_price >= RESOLVED_THRESHOLD or final_price <= (1 - RESOLVED_THRESHOLD)
        trajs[ticker] = {
            "snaps": rows,
            "close_time": meta[ticker]["close_time"],
            "title": meta[ticker]["title"],
            "final_price": final_price,
            "resolved": resolved,
        }
    return trajs


def cio_sliding_window(snaps: list, model: CIOConvergenceModel, close_ts: str = None) -> Optional[Tuple[int, float, float]]:
    snap_objs = [Snapshot(ya, na) for (_, _, ya, na) in snaps]
    for i in range(MIN_POINTS, len(snap_objs) + 1):
        traj = MarketTrajectory(snap_objs[:i], outcome=-1, close_ts=close_ts)
        p_star, has_signal = model.predict(traj)
        price_now = snap_objs[i - 1].yes_mid
        edge = p_star - price_now
        if has_signal and abs(edge) > CERT_EDGE:
            return i, p_star, edge
    return None


def build_cache(trajs: dict, model: CIOConvergenceModel) -> List[dict]:
    cache = []
    for ticker, info in trajs.items():
        snaps = info["snaps"]
        if len(snaps) < MIN_POINTS:
            continue
        snap_objs = [Snapshot(ya, na) for (_, _, ya, na) in snaps]
        traj = MarketTrajectory(snap_objs, outcome=-1, close_ts=info.get("close_time"))
        p_star, has_signal = model.predict(traj)
        price_now = snap_objs[-1].yes_mid
        edge = p_star - price_now if has_signal else 0.0
        cache.append({
            "ticker": ticker,
            "ts": snaps[-1][0],
            "close_time": info["close_time"],
            "has_signal": has_signal,
            "p_star": round(p_star, 4) if has_signal else None,
            "price_now": round(price_now, 4),
            "edge": round(edge, 4),
            "n_points": len(snaps),
            "resolved": info["resolved"],
            "final_price": round(info["final_price"], 4),
        })
    return cache


def main() -> None:
    path_arg = sys.argv[1] if len(sys.argv) > 1 else None
    if path_arg:
        path = Path(path_arg)
    else:
        data_dir = Path(__file__).resolve().parents[1] / "data" / "kalshi"
        candidates = find_snapshot_files(data_dir)  # includes .gz
        if not candidates:
            print("No tight-band-*.jsonl found in data/kalshi/. Run the observer engine first.")
            return
        path = candidates[-1]

    print(f"Loading: {path.name}  ({path.stat().st_size / 1e6:.0f} MB)", flush=True)
    trajs = load_trajectories(path)
    resolved = {t: v for t, v in trajs.items() if v["resolved"]}
    print(f"Markets: {len(trajs)} total, {len(resolved)} resolved (price >= 0.95 or <= 0.05)")
    print()

    model = CIOConvergenceModel()

    lead_times = []
    for ticker, info in resolved.items():
        cert = cio_sliding_window(info["snaps"], model, close_ts=info.get("close_time"))
        if cert is None:
            continue
        cert_idx, p_star, edge = cert
        n_total = len(info["snaps"])
        pct_elapsed = cert_idx / n_total
        correct = (edge > 0 and info["final_price"] >= RESOLVED_THRESHOLD) or \
                  (edge < 0 and info["final_price"] <= (1 - RESOLVED_THRESHOLD))
        side = "YES" if edge > 0 else "NO"
        lead_times.append((pct_elapsed, ticker, cert_idx, n_total, p_star, edge, side, correct))

    if lead_times:
        lead_times.sort(key=lambda x: x[0])
        print(f"CIO lead-time in resolved markets (edge > {CERT_EDGE:.0%}, sorted earliest-first):")
        print(f"{'%elapsed':>8}  {'pts@cert':>8}  {'n_total':>7}  {'p*':>5}  "
              f"{'edge':>7}  {'side':>4}  {'ok':>3}  ticker")
        print("-" * 100)
        for pct, t, ci, nt, ps, ed, side, ok in lead_times:
            flag = "OK" if ok else "X"
            print(f"{pct:>8.1%}  {ci:>8}  {nt:>7}  {ps:>5.3f}  {ed:>+7.3f}  {side:>4}  "
                  f"{flag:>3}  {t}")
        n_correct = sum(1 for *_, ok in lead_times if ok)
        print(f"\nAccuracy: {n_correct}/{len(lead_times)} = "
              f"{n_correct/len(lead_times)*100:.0f}% correct direction")
        avg_lead = sum(x[0] for x in lead_times) / len(lead_times)
        print(f"Average lead-time: first signal at {avg_lead:.1%} of trajectory elapsed")

        # Append run to longitudinal accuracy log (#425)
        import datetime
        log_row = {
            "date": datetime.date.today().isoformat(),
            "run_at": datetime.datetime.utcnow().isoformat() + "Z",
            "n_resolved": len(lead_times),
            "n_correct": n_correct,
            "accuracy": round(n_correct / len(lead_times), 4),
            "avg_lead_time": round(avg_lead, 4),
        }
        ACCURACY_LOG.parent.mkdir(parents=True, exist_ok=True)
        with ACCURACY_LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(log_row) + "\n")
        print(f"Appended accuracy row to {ACCURACY_LOG.name}")
    else:
        print("No Σ0-certified edges found in resolved markets.")

    print(f"\nBuilding CIO trajectory cache for Impossibility Engine C7...")
    cache = build_cache(trajs, model)
    CACHE_OUT.parent.mkdir(parents=True, exist_ok=True)
    with CACHE_OUT.open("w", encoding="utf-8") as f:
        for row in cache:
            f.write(json.dumps(row) + "\n")
    n_sig = sum(1 for r in cache if r["has_signal"])
    print(f"Wrote {len(cache)} rows to {CACHE_OUT.name}  "
          f"({n_sig} with signal, {len(cache)-n_sig} no signal)")


if __name__ == "__main__":
    main()
