"""
TSFM walk-forward forecast gate (#2343 follow-on) — does a time-series forecaster
actually BEAT NAIVE on our own price series, out-of-sample?

This is the Verify gate that must pass BEFORE the numeric/TSFM route
(lib/local-model-registry.js: keystone-tsfm, verified:false) is flipped live. The
North-Star reason it exists: TSFM / LLM "alpha" routinely evaporates under an
honest walk-forward once you compare against the trivial last-value baseline
(arXiv 2505.07078). A forecaster earns the route only if it clears naive here.

Honest method (NO look-ahead):
  1. Rebuild per-ticker price trajectories from data/kalshi/price-snapshots.jsonl
     (chronological `yes_ask` cents per ticker) — a clean univariate series.
  2. Walk each series forward. At every step t >= WARMUP, the forecaster sees
     ONLY history[:t] and predicts the next value (h=1). Compare to the actual.
  3. Score every forecaster on the SAME (series, t) points:
       - MAE, RMSE               absolute error
       - MASE                    MAE / in-sample naive scale. <1.0 == beats naive.
       - directional accuracy    P(sign of predicted change == sign of actual).
  4. VERDICT: a non-naive forecaster PASSES only if MASE < 1.0 AND directional
     accuracy > 0.50 across the out-of-sample points. Anything else has no edge.

Forecasters (pluggable — this is how Chronos-Bolt / Kronos / the served TSFM plug in):
  naive   last value carried forward (the baseline everything is scaled against)
  drift   last value + mean step so far (random-walk-with-drift)
  mean    rolling mean of the lookback window
  tsfm    POST {series, horizon} to $TSFM_ENDPOINT/forecast, expects {"mean":[...]}.
          If the endpoint is DARK (unreachable) it is skipped with a clear note —
          the baselines still run, so the naive bar is established now.

Run:
  PYTHONIOENCODING=utf-8 python experiments/tsfm_walkforward_eval.py
  python experiments/tsfm_walkforward_eval.py --forecaster tsfm --max-series 200
  python experiments/tsfm_walkforward_eval.py --selftest      # deterministic sanity
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_SNAPSHOTS = REPO / "data" / "kalshi" / "price-snapshots.jsonl"
OUT_DIR = REPO / "data" / "eval" / "tsfm"

WARMUP = 8          # min history points before the first forecast (a TSFM lookback)
MIN_LEN = 16        # a series needs at least this many points to be evaluable
EPS = 1e-9


# ── series loading ────────────────────────────────────────────────────────────

def load_series(path: Path, max_series: int | None = None) -> dict[str, list[float]]:
    """Group price-snapshots.jsonl into chronological per-ticker `yes_ask` series."""
    by_ticker: dict[str, list[tuple[str, float]]] = defaultdict(list)
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            tk = row.get("ticker")
            ya = row.get("yes_ask")
            ts = row.get("ts", "")
            if tk is None or ya is None:
                continue
            try:
                by_ticker[tk].append((ts, float(ya)))
            except (TypeError, ValueError):
                continue
    series: dict[str, list[float]] = {}
    for tk, pts in by_ticker.items():
        pts.sort(key=lambda p: p[0])           # chronological by timestamp
        vals = [v for _, v in pts]
        if len(vals) >= MIN_LEN:
            series[tk] = vals
    # Deterministic order (sorted by ticker) so --max-series is reproducible.
    if max_series is not None:
        series = {k: series[k] for k in sorted(series)[:max_series]}
    return series


# ── forecasters: history (list) -> next-value prediction ──────────────────────

def f_naive(history: list[float]) -> float:
    return history[-1]


def f_drift(history: list[float]) -> float:
    if len(history) < 2:
        return history[-1]
    steps = [history[i] - history[i - 1] for i in range(1, len(history))]
    return history[-1] + sum(steps) / len(steps)


def f_mean(history: list[float], window: int = WARMUP) -> float:
    w = history[-window:]
    return sum(w) / len(w)


class TsfmEndpointForecaster:
    """POST the lookback window to the served TSFM and read back its point mean.

    Dark by default: if $TSFM_ENDPOINT is unset/unreachable, `available` is False
    and the harness skips this forecaster (baselines still run). This mirrors the
    registry contract — the route resolves but falls back when the shim is down.
    """

    def __init__(self, endpoint: str | None = None, horizon: int = 1, timeout: float = 3.0):
        self.endpoint = (endpoint or os.environ.get("TSFM_ENDPOINT") or "").rstrip("/")
        self.horizon = horizon
        self.timeout = timeout
        self.available = bool(self.endpoint)
        self.note = "no TSFM_ENDPOINT set" if not self.endpoint else ""

    def __call__(self, history: list[float]) -> float:
        import urllib.error
        import urllib.request

        payload = json.dumps({"series": history, "horizon": self.horizon}).encode("utf-8")
        req = urllib.request.Request(
            self.endpoint + "/forecast",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, json.JSONDecodeError, ValueError) as exc:
            # First failure marks the endpoint dark for the rest of the run.
            self.available = False
            self.note = f"endpoint unreachable: {type(exc).__name__}"
            return history[-1]  # degrade to naive for this point
        mean = body.get("mean") or body.get("forecast") or []
        if isinstance(mean, list) and mean:
            try:
                return float(mean[0])
            except (TypeError, ValueError):
                return history[-1]
        return history[-1]


# ── metrics ───────────────────────────────────────────────────────────────────

def naive_scale(train: list[float]) -> float:
    """In-sample mean absolute one-step change — the MASE denominator (Hyndman)."""
    if len(train) < 2:
        return EPS
    diffs = [abs(train[i] - train[i - 1]) for i in range(1, len(train))]
    return max(sum(diffs) / len(diffs), EPS)


def evaluate(series: dict[str, list[float]], forecasters: dict[str, object]) -> dict:
    """Walk-forward, one-step, over every series. Returns per-forecaster aggregates."""
    # accum[name] = {abs_err, sq_err, scaled_err, dir_hits, dir_total, n}
    acc = {name: dict(abs_err=0.0, sq_err=0.0, scaled_err=0.0,
                      dir_hits=0, dir_total=0, n=0) for name in forecasters}
    series_used = 0
    points = 0

    for _tk, vals in series.items():
        if len(vals) < WARMUP + 2:
            continue
        series_used += 1
        scale = naive_scale(vals[:WARMUP])  # scale from the initial warmup window only
        for t in range(WARMUP, len(vals) - 1):
            history = vals[:t + 1]
            actual = vals[t + 1]
            last = vals[t]
            points += 1
            # Re-scale progressively off seen data (still no look-ahead).
            scale = naive_scale(history)
            for name, fn in forecasters.items():
                pred = fn(history)
                err = abs(pred - actual)
                a = acc[name]
                a["abs_err"] += err
                a["sq_err"] += (pred - actual) ** 2
                a["scaled_err"] += err / scale
                a["n"] += 1
                # Directional: did we get the sign of the change right? (flat actual ignored)
                if actual != last:
                    pred_up = pred > last
                    act_up = actual > last
                    a["dir_total"] += 1
                    a["dir_hits"] += int(pred_up == act_up)

    results = {}
    for name, a in acc.items():
        n = max(a["n"], 1)
        dt = max(a["dir_total"], 1)
        results[name] = {
            "mae": a["abs_err"] / n,
            "rmse": math.sqrt(a["sq_err"] / n),
            "mase": a["scaled_err"] / n,
            "directional_acc": a["dir_hits"] / dt,
            "points": a["n"],
        }
    results["_meta"] = {"series_used": series_used, "eval_points": points}
    return results


def verdict(results: dict) -> list[dict]:
    """A non-naive forecaster PASSES only if MASE < 1 AND directional acc > 0.5."""
    out = []
    for name, m in results.items():
        if name in ("naive", "_meta"):
            continue
        beats = (m["mase"] < 1.0) and (m["directional_acc"] > 0.5)
        out.append({
            "forecaster": name,
            "mase": round(m["mase"], 4),
            "directional_acc": round(m["directional_acc"], 4),
            "beats_naive": beats,
        })
    return out


# ── selftest (deterministic, no data/endpoint needed) ─────────────────────────

def _selftest() -> int:
    """Construct series with known answers and assert the metrics are sane."""
    # Linear trend: naive lags by exactly the slope every step -> MASE ~ 1.0;
    # drift predicts it perfectly -> MASE ~ 0.
    trend = {"lin": [float(i) for i in range(60)]}
    oracle = {"oracle": lambda h: h[-1] + 1.0}  # knows the +1 slope
    res = evaluate(trend, {"naive": f_naive, "drift": f_drift, **oracle})
    assert abs(res["naive"]["mase"] - 1.0) < 1e-6, res["naive"]["mase"]
    assert res["drift"]["mase"] < 1e-6, res["drift"]["mase"]
    assert res["oracle"]["mase"] < 1e-6, res["oracle"]["mase"]
    assert res["drift"]["directional_acc"] == 1.0
    print("selftest OK: naive MASE=1.0, drift/oracle MASE~0 on a linear trend")
    return 0


# ── main ──────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="TSFM walk-forward forecast gate (beats-naive?)")
    ap.add_argument("--snapshots", default=str(DEFAULT_SNAPSHOTS),
                    help="price-snapshots.jsonl path")
    ap.add_argument("--max-series", type=int, default=None, help="cap series (reproducible)")
    ap.add_argument("--forecaster", choices=["baselines", "tsfm"], default="baselines",
                    help="baselines only, or also POST the served TSFM")
    ap.add_argument("--selftest", action="store_true", help="run deterministic sanity checks")
    ap.add_argument("--no-write", action="store_true", help="don't write the report jsonl")
    args = ap.parse_args(argv)

    if args.selftest:
        return _selftest()

    path = Path(args.snapshots)
    if not path.exists():
        print(f"ERROR: no series file at {path}", file=sys.stderr)
        return 2

    series = load_series(path, args.max_series)
    if not series:
        print(f"ERROR: no evaluable series (>= {MIN_LEN} pts) in {path}", file=sys.stderr)
        return 2

    forecasters: dict[str, object] = {"naive": f_naive, "drift": f_drift, "mean": f_mean}
    tsfm = None
    if args.forecaster == "tsfm":
        tsfm = TsfmEndpointForecaster()
        if tsfm.available:
            forecasters["tsfm"] = tsfm
        else:
            print(f"[tsfm] DARK — {tsfm.note}; running baselines only.", file=sys.stderr)

    results = evaluate(series, forecasters)
    verdicts = verdict(results)

    # ── report ──
    meta = results["_meta"]
    print(f"\nTSFM walk-forward gate — {meta['series_used']} series, "
          f"{meta['eval_points']} out-of-sample points (one-step)\n")
    print(f"  {'forecaster':<10} {'MAE':>8} {'RMSE':>8} {'MASE':>8} {'dir_acc':>8}")
    for name in forecasters:
        m = results[name]
        print(f"  {name:<10} {m['mae']:>8.3f} {m['rmse']:>8.3f} "
              f"{m['mase']:>8.4f} {m['directional_acc']:>8.4f}")
    print("\n  VERDICT (beats naive = MASE<1.0 AND dir_acc>0.5):")
    if not verdicts:
        print("    (no non-naive forecaster ran)")
    for v in verdicts:
        flag = "PASS ✓" if v["beats_naive"] else "FAIL ✗"
        print(f"    {v['forecaster']:<10} MASE={v['mase']:<8} dir={v['directional_acc']:<8} {flag}")
    if tsfm is not None and not tsfm.available:
        print(f"\n  NOTE: TSFM endpoint dark ({tsfm.note}) — verify:false stands until it serves + passes here.")

    if not args.no_write:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        out = OUT_DIR / f"walkforward-{stamp}.jsonl"
        record = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "snapshots": str(path),
            "series_used": meta["series_used"],
            "eval_points": meta["eval_points"],
            "results": {k: results[k] for k in forecasters},
            "verdict": verdicts,
        }
        with out.open("w", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")
        print(f"\n  wrote {out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
