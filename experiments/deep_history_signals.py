"""Iteration 12 (Σ₀) — can a confirmed/dual signal cut the false-flip whipsaw?

Iter-11 showed the 12mo-momentum gate is noisy (~4 flips/yr, 80-84% reverse in 3mo),
driving the DOWN-calm whipsaw drag. Test three gates in the no-margin Conservative overlay:
  mom  — 12mo momentum >= 0 (the shipped default)
  sma  — price >= 200-day SMA
  dual — stay invested unless BOTH momentum<0 AND price<200dSMA (confirmed de-risk)
Measure Sharpe / maxDD / trades/yr / trend-flips/yr per signal on S&P (1927+) and Nasdaq.
The dual gate should cut flips (harder to trigger a sell); the risk is it de-risks slower,
giving back crash protection. Report honestly. Measured; nothing synthesised.
"""
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
import deep_history_overlay as O

BASE = dict(tv=0.20, trend_m=12, brake=0.20, min_gross=0.0, max_gross=1.0, band=0.30)
BH = dict(tv=0.0, trend_m=6, brake=9.9, min_gross=1.0, max_gross=1.0, band=0.0)


def main():
    out = {}
    for sym in ("^GSPC", "^IXIC"):
        days, px = O.load_asset(sym)
        bh = O.run_overlay(days, px, **BH)
        print(f"\n# {sym}  {days[0]}..{days[-1]}   buy&hold Sharpe {bh['sharpe']:.2f} maxDD {bh['maxdd']*100:.0f}%")
        print(f"{'signal':<8}{'final':>13}{'sharpe':>8}{'maxdd':>8}{'trades/yr':>10}{'flips/yr':>9}")
        rows = {}
        for sig in ("mom", "sma", "dual"):
            r = O.run_overlay(days, px, signal=sig, **BASE)
            rows[sig] = {k: r[k] for k in ("final", "sharpe", "maxdd", "trade_days_per_yr", "trend_flips_per_yr")}
            print(f"{sig:<8}{r['final']:>13,.0f}{r['sharpe']:>8.2f}{r['maxdd']*100:>7.0f}%"
                  f"{r['trade_days_per_yr']:>10.1f}{r['trend_flips_per_yr']:>9.2f}")
        out[sym] = {"buyhold": {k: bh[k] for k in ("sharpe", "maxdd")}, "signals": rows}
    (HERE / "deep_signals.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("\nwrote deep_signals.json")


if __name__ == "__main__":
    main()
