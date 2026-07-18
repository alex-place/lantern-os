"""Iteration 10 (Σ₀) — transaction-cost sensitivity of the low-turnover recommendation.

The whole loop-1 case rests on "trade less" (~1/month). If that edge evaporates once
fills are realistic, the recommendation is fragile. Re-run the no-margin Conservative
config (band0.30/brake0.20/trend12mo) at TC = 2 / 5 / 10 / 20 bp per unit turnover on
S&P (1927+) and Nasdaq (1971+), and compare net Sharpe/final to buy&hold (which has zero
turnover, so TC-invariant). `run_overlay` reads the module constant O.TC, so we set it
per run and restore. Measured; nothing synthesised.
"""
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
import deep_history_overlay as O

NR = dict(tv=0.20, trend_m=12, brake=0.20, min_gross=0.0, max_gross=1.0, band=0.30)
BH = dict(tv=0.0, trend_m=6, brake=9.9, min_gross=1.0, max_gross=1.0, band=0.0)
BPS = [2, 5, 10, 20]


def main():
    out = {}
    _tc0 = O.TC
    for sym in ("^GSPC", "^IXIC"):
        days, px = O.load_asset(sym)
        bh = O.run_overlay(days, px, **BH)                       # TC-invariant
        print(f"\n# {sym}  {days[0]}..{days[-1]}   buy&hold Sharpe {bh['sharpe']:.2f} "
              f"final ${bh['final']:,.0f} maxDD {bh['maxdd']*100:.0f}%")
        print(f"{'TC(bp)':>7}{'nm.final':>12}{'nm.sharpe':>10}{'nm.maxdd':>9}"
              f"{'turn/yr':>9}{'trades/yr':>10}{'beats B&H?':>11}")
        rows = {}
        for bp in BPS:
            O.TC = bp / 1e4
            r = O.run_overlay(days, px, **NR)
            beats = r["sharpe"] > bh["sharpe"]
            rows[bp] = {k: r[k] for k in ("final", "sharpe", "maxdd", "turnover_per_yr", "trade_days_per_yr")}
            rows[bp]["beats_bh_sharpe"] = bool(beats)
            print(f"{bp:>7}{r['final']:>12,.0f}{r['sharpe']:>10.2f}{r['maxdd']*100:>8.0f}%"
                  f"{r['turnover_per_yr']:>9.1f}{r['trade_days_per_yr']:>10.1f}{('YES' if beats else 'no'):>11}")
        O.TC = _tc0
        out[sym] = {"buyhold": {k: bh[k] for k in ("final", "sharpe", "maxdd")}, "by_tc_bp": rows}
    (HERE / "deep_tcost.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("\nwrote deep_tcost.json")


if __name__ == "__main__":
    main()
