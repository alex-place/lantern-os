"""Iteration 3 — the non-risky overlay under REAL DCA deposits (not lump sum).

The live plan dollar-cost-averages a fixed monthly contribution; iterations 1-2 used
a lump sum for clean dollar-for-dollar comparison. This re-runs the same three books
(buyhold / leveraged 2x / no_margin <=1x) with a $CONTRIB monthly deposit added on the
first trading day of each month, starting from $0, over the full deep history.

With deposits, "final value" mixes contributions and returns, so we report:
  final $, total deposited, final/deposited multiple, the Sharpe & maxDD of the daily
  equity RETURN stream (deposit inflows removed so they don't distort risk), and
  trades/yr. Everything measured from deep_history.json; nothing synthesised.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
import deep_history_overlay as O

CONTRIB = 20.0
RF, BORROW_SPREAD, TC = O.RF, O.BORROW_SPREAD, O.TC


def run_dca(days, px, tv, trend_m, brake, min_gross, max_gross, band, start=None, end=None):
    i0 = 0 if start is None else next(i for i, d in enumerate(days) if d >= start)
    i1 = len(days) if end is None else next((i for i, d in enumerate(days) if d >= end), len(days))
    eq, peak = 0.0, 1e-9
    prev_g, cur_month = 0.0, ""
    deposited = 0.0
    rets, eq_path = [], []
    turnover_sum, trade_days, gross_hist = 0.0, 0, []
    for i in range(i0, i1):
        d = days[i]
        if d[:7] != cur_month:              # first trading day of a new month -> deposit
            cur_month = d[:7]
            eq += CONTRIB
            deposited += CONTRIB
        if i == i0:
            eq_path.append((d, eq)); continue
        lo = max(0, i - 21)
        seg = px[lo:i]
        r20 = np.diff(np.log(seg)) if seg.size > 2 else np.array([0.0])
        vol20 = float(np.std(r20, ddof=1)) * math.sqrt(252) if r20.size > 5 and np.std(r20) > 0 else tv
        lo_t = max(0, i - 21 * trend_m)
        trend_ok = px[i - 1] / px[lo_t] >= 1.0 if i - lo_t > 21 else True
        dd = eq / peak - 1.0
        g = min(max_gross, max(min_gross, tv / max(vol20, 1e-6)))
        if not trend_ok:
            g = min(g, min_gross)
        if dd < -brake:
            over = min(1.0, (abs(dd) - brake) / brake)
            g = min(g, min_gross + (1.0 - over) * max(0.0, 1.0 - min_gross))
        derisk = g < prev_g - 1e-12
        if band > 0 and abs(g - prev_g) <= band and not derisk:
            g = prev_g
        asset_r = px[i] / px[i - 1] - 1.0
        carry = (-(prev_g - 1.0) * (RF + BORROW_SPREAD) / 252) if prev_g > 1 else ((1.0 - prev_g) * RF / 252)
        moved = abs(g - prev_g)
        turnover_sum += moved
        if moved > 1e-12:
            trade_days += 1
        eq_r = prev_g * asset_r + carry - TC * moved
        rets.append(eq_r)
        eq = max(eq * (1.0 + eq_r), 0.0)
        peak = max(peak, eq)
        prev_g = g
        gross_hist.append(g)
        eq_path.append((d, eq))
    r = np.array(rets)
    e = np.array([v for _, v in eq_path])
    peaks = np.maximum.accumulate(np.maximum(e, 1e-9))
    yrs = max(len(r) / 252.0, 1e-9)
    sh = r.mean() / r.std(ddof=1) * math.sqrt(252) if r.size > 2 and r.std(ddof=1) > 0 else 0.0
    return {"final": eq, "deposited": deposited, "multiple": eq / max(deposited, 1e-9),
            "sharpe": sh, "maxdd": float(np.min(e / peaks - 1.0)),
            "avg_gross": float(np.mean(gross_hist)) if gross_hist else 0.0,
            "trade_days_per_yr": trade_days / yrs, "years": yrs}


def main():
    # Use the iteration-2 selected non-risky config for the no_margin book.
    NR = dict(tv=0.20, trend_m=12, brake=0.20, band=0.30)   # band/brake/trend from the sweep
    out = {}
    for sym in ("^GSPC", "^IXIC"):
        days, px = O.load_asset(sym)
        books = {
            "buyhold":   dict(tv=0.0, trend_m=6, brake=9.9, min_gross=1.0, max_gross=1.0, band=0.0),
            "leveraged": dict(tv=0.20, trend_m=6, brake=0.15, min_gross=0.0, max_gross=2.0, band=0.10),
            "no_margin": dict(**NR, min_gross=0.0, max_gross=1.0),
        }
        print(f"\n# {sym}  {days[0]}..{days[-1]}  DCA ${CONTRIB:.0f}/mo")
        print(f"{'book':<12}{'final':>13}{'deposited':>11}{'mult':>7}{'sharpe':>8}{'maxdd':>8}{'trades/yr':>10}")
        res = {}
        for name, cfg in books.items():
            r = run_dca(days, px, **cfg)
            res[name] = r
            print(f"{name:<12}{r['final']:>13,.0f}{r['deposited']:>11,.0f}{r['multiple']:>7.2f}"
                  f"{r['sharpe']:>8.2f}{r['maxdd']*100:>7.0f}%{r['trade_days_per_yr']:>10.1f}")
        out[sym] = {k: {kk: vv for kk, vv in v.items()} for k, v in res.items()}
    (HERE / "deep_dca.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("\nwrote deep_dca.json")


if __name__ == "__main__":
    main()
