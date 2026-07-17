"""Sweep the no-trade band on the CHAMPION itself — 8-asset momentum universe +
brake-to-cash, $2,000 start + $20/mo — before flipping the default or touching
the artifact. The base-overlay band result (+2.5%, sym~0.08) was measured on a
different engine (6-ETF lump, no cash floor); this checks it transfers to the
engine the artifact actually cites (leverage_brake_to_cash.run_daily_cash).

Run (PowerShell — Yahoo fetch): python experiments/champion_notrade_band.py
"""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import leverage_daily_overlay as D
import leverage_brake_to_cash as DB

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
OUT = Path(__file__).parent / "results"
D.UNIVERSE = ["SPY", "QQQ", "IWM", "EFA", "TLT", "GLD", "XMMO", "SPMO"]
INIT = 2000.0
CFG = (0.35, 6, 0.30, 0.0)            # tv, trend_m, brake, min_gross (the champion)
BANDS = [0.0, 0.02, 0.04, 0.08, 0.15]
MODES = ["sym", "brake_aware"]


def n_months(path):
    return len({d[:7] for d, _ in path})


def xirr(n, final, init, monthly):
    """Money-weighted annual return: -(init+monthly) at month 0, -monthly at
    months 1..n-1, +final at month n-1 (the champion's actual cashflow)."""
    def npv(r):
        v = -(init + monthly)
        for j in range(1, n):
            v -= monthly / (1 + r) ** j
        return v + final / (1 + r) ** (n - 1)
    lo, hi = -0.9, 0.9
    for _ in range(200):
        mid = (lo + hi) / 2
        if npv(mid) > 0:  # npv decreasing in r
            lo = mid
        else:
            hi = mid
    return (1 + (lo + hi) / 2) ** 12 - 1


def main():
    days, px = D.build_panel()
    print(f"panel: {len(days)} days {days[0]} -> {days[-1]}")
    print(f"champion band sweep — 8-asset momentum + brake-to-cash, $2k + $20/mo, cfg {CFG}\n")
    print("  mode/band".ljust(22), "final".rjust(11), "CAGR".rjust(7), "maxDD".rjust(7),
          "Sharpe".rjust(7), "trades".rjust(7), "vs band0".rjust(10))
    base = None
    out = {}
    for mode in MODES:
        for band in BANDS:
            r = DB.run_daily_cash(days, px, *CFG, init_cash=INIT, band=band, band_mode=mode)
            nm = n_months(r["path"])
            cagr = xirr(nm, r["final"], INIT, D.CONTRIB)
            if band == 0.0 and base is None:
                base = r["final"]
            row = {"final": r["final"], "cagr": cagr, "maxdd": r["maxdd"],
                   "sharpe": r["sharpe"], "trades": r["trade_days"],
                   "d_vs_band0": r["final"] - base}
            out[f"{mode}_band{band}"] = row
            print(f"  {mode[:5]:>5} b={band:<4}".ljust(22),
                  f"${r['final']:,.0f}".rjust(11), f"{cagr*100:.1f}%".rjust(7),
                  f"{r['maxdd']*100:.0f}%".rjust(7), f"{r['sharpe']:.2f}".rjust(7),
                  f"{r['trade_days']}".rjust(7),
                  (f"+${row['d_vs_band0']:,.0f}" if row['d_vs_band0'] >= 0
                   else f"-${-row['d_vs_band0']:,.0f}").rjust(10))
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "champion_notrade_band.json").write_text(
        json.dumps({"config": CFG, "init_cash": INIT, "baseline_final": base,
                    "months": n_months(DB.run_daily_cash(days, px, *CFG, init_cash=INIT)["path"]),
                    "books": out}, indent=1), encoding="utf-8")
    print(f"\nwrote {OUT / 'champion_notrade_band.json'}")


if __name__ == "__main__":
    main()
