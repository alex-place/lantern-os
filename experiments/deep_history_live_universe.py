"""Closing validation — Conservative overlay on the ACTUAL live 8-ETF book.

Iterations 1-6 used index PROXIES (S&P/Nasdaq/…) to reach 1927. This confirms the
recommendation on the real universe the live code trades:
  SPY QQQ IWM EFA TLT GLD XMMO SPMO
ETFs have short histories (SPMO inception 2015, XMMO ~2005), so the common window is
much shorter than the proxy study — stated honestly. We test:
  - the full 8-ETF book (common window, ~2015+),
  - a 6-ETF sub-book dropping the two newest momentum ETFs (reaches ~2007),
each as an EQUAL-WEIGHT blend (a stand-in for the live tangency book — the point here is
the OVERLAY behaviour, not the weighting), no-margin Conservative overlay vs buy&hold.
Everything measured from Yahoo adjclose; nothing synthesised.
"""
import sys
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
import deep_history_cache as C
import deep_history_overlay as O

FULL = ["SPY", "QQQ", "IWM", "EFA", "TLT", "GLD", "XMMO", "SPMO"]
SUB = ["SPY", "QQQ", "IWM", "EFA", "TLT", "GLD"]


def fetch_many(syms):
    out = {}
    for s in syms:
        try:
            out[s] = C.fetch_series(s, 2003)
        except Exception as e:
            print(f"  {s}: FETCH FAIL {type(e).__name__}")
    return out


def eq_weight_blend(series, syms):
    # common date range = latest first-date across syms .. earliest last-date
    firsts = max(min(series[s]) for s in syms)
    lasts = min(max(series[s]) for s in syms)
    days = [d for d in sorted(series[syms[0]]) if firsts <= d <= lasts]
    px = {s: np.array([series[s].get(d, np.nan) for d in days]) for s in syms}
    for s in syms:  # ffill
        v = px[s]
        for i in range(1, len(v)):
            if np.isnan(v[i]) and not np.isnan(v[i - 1]):
                v[i] = v[i - 1]
    # daily equal-weight rebalanced blend
    rets = np.zeros(len(days))
    for s in syms:
        v = px[s]
        r = np.zeros(len(days))
        r[1:] = v[1:] / v[:-1] - 1.0
        rets += r / len(syms)
    blend = np.ones(len(days))
    for i in range(1, len(days)):
        blend[i] = blend[i - 1] * (1.0 + rets[i])
    return days, blend


def run(label, syms, series):
    days, blend = eq_weight_blend(series, syms)
    NR = dict(tv=0.20, trend_m=12, brake=0.20, min_gross=0.0, max_gross=1.0, band=0.30)
    BH = dict(tv=0.0, trend_m=6, brake=9.9, min_gross=1.0, max_gross=1.0, band=0.0)
    bh = O.run_overlay(days, blend, **BH)
    nm = O.run_overlay(days, blend, **NR)
    print(f"\n# {label}  {days[0]}..{days[-1]}  ({bh['years']:.1f}y, {len(syms)} ETFs eq-weight)")
    print(f"{'book':<14}{'final':>12}{'cagr':>8}{'sharpe':>8}{'maxdd':>8}{'trades/yr':>10}")
    for name, r in [("buyhold", bh), ("no_margin", nm)]:
        print(f"{name:<14}{r['final']:>12,.0f}{r['cagr']*100:>7.1f}%{r['sharpe']:>8.2f}"
              f"{r['maxdd']*100:>7.0f}%{r['trade_days_per_yr']:>10.1f}")
    return {"label": label, "range": [days[0], days[-1]], "years": bh["years"],
            "buyhold": {k: bh[k] for k in ("final", "cagr", "sharpe", "maxdd")},
            "no_margin": {k: nm[k] for k in ("final", "cagr", "sharpe", "maxdd", "trade_days_per_yr")}}


def main():
    import json
    series = fetch_many(FULL)
    out = {}
    out["8etf_full"] = run("Full live universe (8 ETFs)", FULL, series)
    out["6etf_sub"] = run("6-ETF sub-book (drops XMMO/SPMO, longer window)", SUB, series)
    (HERE / "deep_live_universe.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("\nwrote deep_live_universe.json")


if __name__ == "__main__":
    main()
