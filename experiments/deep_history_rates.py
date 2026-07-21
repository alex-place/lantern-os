"""Iteration 18 (Σ₀, LOOP3) — how much of the brake's edge depends on the cash yield?

The no-margin overlay parks idle capital in cash earning RF. Iter-17 flagged the flat-3%
assumption. Here we vary the cash/idle yield to 0% / 3% / 6% and re-measure vs buy&hold. The
0% case is the ZIRP stress (2009-2021): if idle cash earns NOTHING, does the drawdown brake
still beat buy&hold — i.e. is the edge from crash-avoidance, or just from cash interest?
(buy&hold holds no cash and never borrows, so RF is irrelevant to it — TC-sweep-style: set
O.RF per run and restore.) Measured; nothing synthesised.
"""
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
import deep_history_overlay as O

NR = dict(tv=0.20, trend_m=12, brake=0.20, min_gross=0.0, max_gross=1.0, band=0.30)
BH = dict(tv=0.0, trend_m=6, brake=9.9, min_gross=1.0, max_gross=1.0, band=0.0)
RATES = [0.0, 0.03, 0.06]


def main():
    out = {}
    _rf0 = O.RF
    for sym in ("^GSPC", "^IXIC"):
        days, px = O.load_asset(sym)
        bh = O.run_overlay(days, px, **BH)   # RF-invariant
        print(f"\n# {sym}  {days[0]}..{days[-1]}   buy&hold Sharpe {bh['sharpe']:.2f} maxDD {bh['maxdd']*100:.0f}% final ${bh['final']:,.0f}")
        print(f"{'cashYield':>10}{'nm.final':>13}{'nm.sharpe':>10}{'nm.maxdd':>9}{'beats B&H Sharpe?':>18}")
        rows = {}
        for rf in RATES:
            O.RF = rf
            r = O.run_overlay(days, px, **NR)
            beats = r["sharpe"] > bh["sharpe"]
            rows[f"{int(rf*100)}pct"] = {k: r[k] for k in ("final", "sharpe", "maxdd")} | {"beats_bh": bool(beats)}
            print(f"{rf*100:>9.0f}%{r['final']:>13,.0f}{r['sharpe']:>10.2f}{r['maxdd']*100:>8.0f}%{('YES' if beats else 'no'):>18}")
        O.RF = _rf0
        out[sym] = {"buyhold": {k: bh[k] for k in ("sharpe", "maxdd", "final")}, "by_cash_yield": rows}
    (HERE / "deep_rates.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("\nwrote deep_rates.json")


if __name__ == "__main__":
    main()
