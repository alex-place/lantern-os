"""Iteration 9 (Σ₀) — production-EXACT weighting: monthly capped tangency, not equal-weight.

Iter-5 used an equal-weight blend as a stand-in for the live book. This ports the ACTUAL
production weighting — the capped shrunk tangency (`tangency_dir`, cap 0.35 / covShrink
0.35 / muShrink 0.5, minObs 60), recomputed MONTHLY from a trailing 5y window, exactly as
champion-book.js `targetWeights` / leverage_daily_overlay do — onto the deep-history proxy
panel, then applies the no-margin Conservative overlay to the tangency book. Question: does
the real weighting change the "diversification + brake" conclusion vs equal-weight?

Panel: S&P (^GSPC), bond proxy (from ^TNX, iter-5), gold (GC=F), Nasdaq (^IXIC) — common
window 2000+ (gold's start). Lump-sum $25k, 2bp/turnover. Measured; nothing synthesised.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
import deep_history_cache as C
import deep_history_overlay as O
import deep_history_blend as B
import leverage_daily_overlay as L   # provides the production tangency_dir


def tangency_book_price(days, panel_px, lookback_days=252 * 5, recompute="month"):
    """Daily return series of the monthly-recomputed capped-tangency book over `panel_px`
    (dict sym->aligned price array). Weights use production tangency_dir params."""
    syms = list(panel_px)
    n = len(syms)
    price = np.ones(len(days))
    w = np.zeros(n)
    cur_month = ""
    for i in range(1, len(days)):
        d = days[i]
        if d[:7] != cur_month:                 # recompute weights monthly
            cur_month = d[:7]
            lb = max(0, i - lookback_days)
            live = [k for k in range(n)
                    if not np.isnan(panel_px[syms[k]][lb:i]).any() and i - lb > 60]
            if len(live) >= 2:
                R = np.stack([np.diff(np.log(panel_px[syms[k]][lb:i])) for k in live])
                mu = R.mean(axis=1) * 21
                cov = np.cov(R) * 21
                wd = L.tangency_dir(mu, np.atleast_2d(cov), len(live))
                w = np.zeros(n)
                for j, k in enumerate(live):
                    w[k] = wd[j]
        # today's book return from yesterday's weights
        r = 0.0
        for k in range(n):
            if w[k] > 0 and not (np.isnan(panel_px[syms[k]][i]) or np.isnan(panel_px[syms[k]][i - 1])):
                r += w[k] * (panel_px[syms[k]][i] / panel_px[syms[k]][i - 1] - 1.0)
        price[i] = price[i - 1] * (1.0 + r)
    return price


def main():
    data = C.build_cache(); s = data["series"]
    # aligned common calendar from 2000 (gold start), S&P/bond/gold/nasdaq
    days = [d for d in sorted(s["^GSPC"]) if d >= "2000-08-30"]
    def arr(sym):
        v = np.array([s[sym].get(d, np.nan) for d in days])
        for i in range(1, len(v)):
            if np.isnan(v[i]): v[i] = v[i - 1]
        return v
    spx = arr("^GSPC"); nas = arr("^IXIC"); gold = arr("GC=F")
    bond = B.bond_index_from_tnx(days, s["^TNX"])
    panel = {"SPX": spx, "BOND": bond, "GOLD": gold, "NAS": nas}

    tang = tangency_book_price(days, panel)
    # equal-weight blend for comparison (iter-5 style)
    ew = np.ones(len(days))
    rr = np.zeros(len(days))
    for sym in panel:
        v = panel[sym]; r = np.zeros(len(days)); r[1:] = v[1:] / v[:-1] - 1.0
        rr += r / len(panel)
    for i in range(1, len(days)):
        ew[i] = ew[i - 1] * (1 + rr[i])

    NR = dict(tv=0.20, trend_m=12, brake=0.20, min_gross=0.0, max_gross=1.0, band=0.30)
    BH = dict(tv=0.0, trend_m=6, brake=9.9, min_gross=1.0, max_gross=1.0, band=0.0)
    print(f"# production tangency vs equal-weight  {days[0]}..{days[-1]}  (4-asset)\n")
    print(f"{'book':<26}{'final':>12}{'cagr':>8}{'sharpe':>8}{'maxdd':>8}{'trades/yr':>10}")
    out = {}
    for label, px in [("tangency buy&hold", tang), ("tangency + no_margin", tang),
                      ("eq-weight buy&hold", ew), ("eq-weight + no_margin", ew)]:
        cfg = NR if "no_margin" in label else BH
        r = O.run_overlay(days, px, **cfg)
        out[label] = {k: r[k] for k in ("final", "cagr", "sharpe", "maxdd", "trade_days_per_yr")}
        print(f"{label:<26}{r['final']:>12,.0f}{r['cagr']*100:>7.1f}%{r['sharpe']:>8.2f}"
              f"{r['maxdd']*100:>7.0f}%{r['trade_days_per_yr']:>10.1f}")
    (HERE / "deep_tangency.json").write_text(json.dumps({"range": [days[0], days[-1]], "books": out}, indent=1), encoding="utf-8")
    print("\nwrote deep_tangency.json")


if __name__ == "__main__":
    main()
