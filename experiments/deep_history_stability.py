"""Iteration 19+20 (Σ₀, LOOP3) — decade-by-decade stability + vol-target (tv) robustness.

(19) Is the brake's edge consistent across decades or driven by a few crisis eras? Per-decade
     buy&hold vs no_margin Sharpe + excess CAGR on S&P (1930s→2020s) and Nasdaq.
(20) Is the shipped tv=0.20 a robust choice or a knife-edge? Sweep tv in {0.10..0.30}.
Reuse run_overlay. Measured; nothing synthesised; decades where the brake loses are shown.
"""
import json
import sys
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
import deep_history_overlay as O

NR = dict(tv=0.20, trend_m=12, brake=0.20, min_gross=0.0, max_gross=1.0, band=0.30)
BH = dict(tv=0.0, trend_m=6, brake=9.9, min_gross=1.0, max_gross=1.0, band=0.0)


def decades(sym):
    days, px = O.load_asset(sym)
    y0 = int(days[0][:4]); y1 = int(days[-1][:4])
    d0 = (y0 // 10) * 10
    print(f"\n# {sym} decade stability   (excess = no_margin − buy&hold)")
    print(f"{'decade':<10}{'B&H Sh':>8}{'nm Sh':>8}{'ΔSh':>7}{'B&H DD':>8}{'nm DD':>8}{'B&H cagr':>10}{'nm cagr':>9}")
    rows = {}
    for dec in range(d0, y1 + 1, 10):
        s, e = f"{dec}-01-01", f"{dec+10}-01-01"
        try:
            bh = O.run_overlay(days, px, start=s, end=e, **BH)
            nm = O.run_overlay(days, px, start=s, end=e, **NR)
        except (StopIteration, Exception):
            continue
        if bh["rets"].size < 200:
            continue
        rows[f"{dec}s"] = {"bh_sharpe": bh["sharpe"], "nm_sharpe": nm["sharpe"],
                           "d_sharpe": nm["sharpe"] - bh["sharpe"], "bh_maxdd": bh["maxdd"],
                           "nm_maxdd": nm["maxdd"], "bh_cagr": bh["cagr"], "nm_cagr": nm["cagr"]}
        flag = "" if nm["sharpe"] >= bh["sharpe"] else "  <-brake worse"
        print(f"{str(dec)+'s':<10}{bh['sharpe']:>8.2f}{nm['sharpe']:>8.2f}{nm['sharpe']-bh['sharpe']:>+7.2f}"
              f"{bh['maxdd']*100:>7.0f}%{nm['maxdd']*100:>7.0f}%{bh['cagr']*100:>9.1f}%{nm['cagr']*100:>8.1f}%{flag}")
    return rows


def tv_sweep(sym):
    days, px = O.load_asset(sym)
    bh = O.run_overlay(days, px, **BH)
    print(f"\n# {sym} vol-target sweep   (buy&hold Sharpe {bh['sharpe']:.2f})")
    print(f"{'tv':>6}{'sharpe':>8}{'maxdd':>8}{'final':>14}{'trades/yr':>10}")
    rows = {}
    for tv in (0.10, 0.15, 0.20, 0.25, 0.30):
        cfg = dict(NR); cfg["tv"] = tv
        r = O.run_overlay(days, px, **cfg)
        star = " *shipped" if abs(tv - 0.20) < 1e-9 else ""
        rows[f"tv_{int(tv*100)}"] = {k: r[k] for k in ("sharpe", "maxdd", "final", "trade_days_per_yr")}
        print(f"{tv:>6.2f}{r['sharpe']:>8.2f}{r['maxdd']*100:>7.0f}%{r['final']:>14,.0f}{r['trade_days_per_yr']:>10.1f}{star}")
    return rows


def main():
    out = {"decades": {}, "tv_sweep": {}}
    for sym in ("^GSPC", "^IXIC"):
        out["decades"][sym] = decades(sym)
    for sym in ("^GSPC", "^IXIC"):
        out["tv_sweep"][sym] = tv_sweep(sym)
    (HERE / "deep_stability.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("\nwrote deep_stability.json")


if __name__ == "__main__":
    main()
