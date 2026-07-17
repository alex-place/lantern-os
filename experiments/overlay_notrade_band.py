"""Does the daily brake overlay bleed return to wasted re-trades? Put the
tranche's no-trade band in and re-measure.

The overlay (experiments/leverage_daily_overlay.py) re-trades to its exact
vol-target x trend x brake exposure EVERY DAY, paying TC=2bp on every wiggle.
The control-engineering tranche (docs/research/2026-07-17-...analysis.md, Ask 2)
says: under transaction costs the optimal policy holds inside a no-trade band
around the target (arXiv:1303.3148 / 1306.2802), so calendar/continuous
rebalancing wastes cost. This measures the claim on our own overlay.

For each band width and mode we hold the overlay config FIXED (grid-tuned once on
2000-2012, no look-ahead) and vary only the band, on a clean $25k lump with NO
deposits so the deposit schedule can't confound the cost effect. Reported over
the full 2000+ sample and the untouched 2013+ validation, against SPY buy-&-hold.

  sym         : band both directions (may delay the brake — the risk to watch)
  brake_aware : band only blocks risk-ADDING / reshuffling trades; a de-risking
                move (brake/trend cutting gross) always trades immediately

Run (PowerShell — Yahoo fetch needs egress): python experiments/overlay_notrade_band.py
Writes experiments/results/overlay_notrade_band.json
"""
import json
import math
import sys
from pathlib import Path

import numpy as np

import leverage_daily_overlay as ov

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
OUT = Path(__file__).parent / "results"
EQUITY0 = 25000.0
BANDS = [0.0, 0.01, 0.02, 0.04, 0.08, 0.15]
MODES = ["sym", "brake_aware"]
TRAIN_END = "2013-01-01"
VAL_START = "2013-01-02"


def spy_buy_hold(days, px, start, end=None):
    """$EQUITY0 into SPY at the first day >= start, held to end. Returns final,
    CAGR, Sharpe, maxDD on the same daily grid the overlay uses."""
    i0 = next(i for i, d in enumerate(days) if d >= start)
    i1 = len(days) if end is None else next(i for i, d in enumerate(days) if d >= end)
    s = px["SPY"][i0:i1]
    s = s[~np.isnan(s)]
    if len(s) < 3:
        return {}
    path = EQUITY0 * s / s[0]
    rets = np.diff(s) / s[:-1]
    sh = rets.mean() / rets.std(ddof=1) * math.sqrt(252) if rets.std(ddof=1) > 0 else 0.0
    peaks = np.maximum.accumulate(path)
    mdd = float(np.min(path / peaks - 1.0))
    yrs = len(s) / 252.0
    cagr = (path[-1] / path[0]) ** (1 / yrs) - 1 if yrs > 0 else 0.0
    return {"final": float(path[-1]), "cagr": cagr, "sharpe": sh, "maxdd": mdd}


def cagr_of(final, yrs):
    return (final / EQUITY0) ** (1 / yrs) - 1 if final > 0 and yrs > 0 else -1.0


def run_window(days, px, cfg, start, end):
    yrs = None
    out = {}
    base = None
    for mode in MODES:
        for band in BANDS:
            r = ov.run_daily(days, px, *cfg, start=start, end=end,
                             deposits=False, equity0=EQUITY0, band=band, band_mode=mode)
            if yrs is None:
                yrs = max(len(r["rets"]) / 252.0, 1e-9)
            row = {
                "final": r["final"], "cagr": cagr_of(r["final"], yrs),
                "sharpe": r["sharpe"], "maxdd": r["maxdd"],
                "turnover_per_yr": r["turnover_per_yr"], "trade_days": r["trade_days"],
            }
            if band == 0.0:
                base = row  # band=0 is identical across modes; keep one as baseline
            row["d_final_vs_band0"] = row["final"] - (base["final"] if base else row["final"])
            out[f"{mode}_band{band}"] = row
    out["_baseline_band0"] = base
    out["_years"] = yrs
    return out


def main():
    days, px = ov.build_panel()
    print(f"panel: {len(days)} days {days[0]} -> {days[-1]}")

    # Tune the overlay config ONCE on 2000-2012 (Sharpe), no band — same as
    # leverage_daily_overlay.main(), so the band is the only thing we vary.
    grid = [(tv, tm, bk) for tv in (0.15, 0.20, 0.25)
            for tm in (6, 10, 12) for bk in (0.10, 0.15, 0.20)]
    tuned = sorted(
        ((c, ov.run_daily(days, px, *c, start="2000-01-03", end=TRAIN_END,
                          deposits=False, equity0=EQUITY0)["sharpe"]) for c in grid),
        key=lambda x: -x[1])
    cfg = tuned[0][0]
    print(f"overlay config (tuned on 2000-2012 Sharpe): tv/trend/brake = {cfg}")

    full = run_window(days, px, cfg, "2000-01-03", None)
    val = run_window(days, px, cfg, VAL_START, None)
    spy_full = spy_buy_hold(days, px, "2000-01-03", None)
    spy_val = spy_buy_hold(days, px, VAL_START, None)

    result = {
        "config": {"tv": cfg[0], "trend_m": cfg[1], "brake": cfg[2]},
        "equity0": EQUITY0, "deposits": False,
        "note": "band units = L1 exposure drift as fraction of equity (~ tranche +-Xpp). "
                "band=0 is the legacy every-day-retrade overlay. Net of TC=2bp/turnover.",
        "full_2000": {"spy": spy_full, "years": full["_years"], "books": {k: v for k, v in full.items() if not k.startswith("_")}},
        "validation_2013": {"spy": spy_val, "years": val["_years"], "books": {k: v for k, v in val.items() if not k.startswith("_")}},
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "overlay_notrade_band.json").write_text(json.dumps(result, indent=1), encoding="utf-8")

    def show(label, win, spy):
        print(f"\n=== {label} (SPY buy-hold: ${spy['final']:,.0f}, CAGR {spy['cagr']*100:.1f}%, "
              f"Sharpe {spy['sharpe']:.2f}, maxDD {spy['maxdd']*100:.0f}%) ===")
        print("  mode/band".ljust(20), "final".rjust(11), "CAGR".rjust(7), "Sharpe".rjust(7),
              "maxDD".rjust(7), "turn/yr".rjust(8), "vs band0".rjust(10))
        for mode in MODES:
            for band in BANDS:
                r = win["books"][f"{mode}_band{band}"]
                print(f"  {mode[:5]:>5} b={band:<4}".ljust(20),
                      f"${r['final']:,.0f}".rjust(11), f"{r['cagr']*100:.1f}%".rjust(7),
                      f"{r['sharpe']:.2f}".rjust(7), f"{r['maxdd']*100:.0f}%".rjust(7),
                      f"{r['turnover_per_yr']:.1f}".rjust(8),
                      (f"+${r['d_final_vs_band0']:,.0f}" if r['d_final_vs_band0'] >= 0
                       else f"-${-r['d_final_vs_band0']:,.0f}").rjust(10))

    show("FULL 2000+", result["full_2000"], spy_full)
    show("VALIDATION 2013+", result["validation_2013"], spy_val)
    print(f"\nwrote {OUT / 'overlay_notrade_band.json'}")


if __name__ == "__main__":
    main()
