"""Iteration 11 (Σ₀) — WHERE does the brake add value, and where does it cost?

Attributes the no-margin overlay's return vs buy&hold across market regimes, classified
by information available AT THE TIME (no look-ahead): the trailing 12-month trend sign and
the current drawdown bucket. Also isolates the trend overlay's known weakness — WHIPSAW:
signal flips that reverse quickly, paying a round-trip for nothing.

For each day the book steps: regime = UPTREND (12mo trend ≥ 0) or DOWNTREND (< 0), and a
drawdown bucket (calm > −10% / correction −10..−20% / bear < −20%). We sum each book's
daily log-return within each regime and report the excess (no_margin − buy&hold). Whipsaw
= trend-sign flips; we count them and the fraction that reversed within 3 months (a false
signal). Honest: expect the brake to LAG in strong uptrends and pay whipsaw in chop, and to
WIN big in downtrends/bears. Measured from deep_history.json; nothing synthesised.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
import deep_history_overlay as O

NR = dict(tv=0.20, trend_m=12, brake=0.20, min_gross=0.0, max_gross=1.0, band=0.30)
BH = dict(tv=0.0, trend_m=6, brake=9.9, min_gross=1.0, max_gross=1.0, band=0.0)


def dd_bucket(dd):
    if dd > -0.10: return "calm(>-10%)"
    if dd > -0.20: return "correction(-10..-20)"
    return "bear(<-20%)"


def analyze(sym):
    days, px = O.load_asset(sym)
    nm = O.run_overlay(days, px, **NR)
    bh = O.run_overlay(days, px, **BH)
    rn, rb = nm["rets"], bh["rets"]
    n = min(rn.size, rb.size)
    # rets[k] corresponds to day index k+1 (i0=0). Classify by info at day k (prior close).
    # buy&hold equity path = asset; use its running peak for drawdown.
    eq_bh = np.array([v for _, v in bh["path"]])
    peak = np.maximum.accumulate(eq_bh)
    ddser = eq_bh / peak - 1.0
    regimes = {}          # (trend, ddbucket) -> [bh_log, nm_log, days]
    trend_state = []      # +1/-1 per step for whipsaw
    for k in range(n):
        i = k + 1
        lo_t = max(0, i - 252)
        trend = px[i - 1] / px[lo_t] - 1.0 if i - lo_t > 60 else 0.0
        tsign = "UP" if trend >= 0 else "DOWN"
        trend_state.append(1 if trend >= 0 else -1)
        key = (tsign, dd_bucket(ddser[i - 1] if i - 1 < len(ddser) else 0.0))
        a = regimes.setdefault(key, [0.0, 0.0, 0])
        a[0] += math.log1p(rb[k]); a[1] += math.log1p(rn[k]); a[2] += 1
    # whipsaw: count trend-sign flips and fraction reversing within ~63 trading days (3mo)
    ts = np.array(trend_state)
    flips = np.where(np.diff(ts) != 0)[0]
    quick_reversal = 0
    for j in range(len(flips) - 1):
        if flips[j + 1] - flips[j] <= 63:      # flipped back within 3 months
            quick_reversal += 1
    whip = {"flips": int(len(flips)),
            "flips_per_yr": len(flips) / (n / 252.0),
            "quick_reversal_frac": (quick_reversal / len(flips)) if len(flips) else 0.0}

    print(f"\n# {sym}  {days[0]}..{days[-1]}")
    print(f"{'regime':<34}{'days':>7}{'B&H %/yr':>10}{'nm %/yr':>10}{'excess/yr':>11}")
    rows = {}
    for key in sorted(regimes, key=lambda k: (-regimes[k][2])):
        bl, nl, dd = regimes[key]
        yrs = dd / 252.0
        bh_ann = (math.exp(bl) ** (1 / max(yrs, 1e-9)) - 1) * 100
        nm_ann = (math.exp(nl) ** (1 / max(yrs, 1e-9)) - 1) * 100
        label = f"{key[0]:<5} {key[1]}"
        print(f"{label:<34}{dd:>7}{bh_ann:>9.1f}%{nm_ann:>9.1f}%{nm_ann-bh_ann:>10.1f}%")
        rows[f"{key[0]}|{key[1]}"] = {"days": dd, "bh_ann_pct": round(bh_ann, 2),
                                      "nm_ann_pct": round(nm_ann, 2), "excess_ann_pct": round(nm_ann - bh_ann, 2)}
    print(f"  whipsaw: {whip['flips']} trend flips ({whip['flips_per_yr']:.2f}/yr); "
          f"{whip['quick_reversal_frac']:.0%} reversed within 3mo")
    return {"symbol": sym, "regimes": rows, "whipsaw": whip}


def main():
    out = {}
    for sym in ("^GSPC", "^IXIC"):
        out[sym] = analyze(sym)
    (HERE / "deep_regime.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("\nwrote deep_regime.json")


if __name__ == "__main__":
    main()
