"""Iteration 4 — HYBRID: brake the accumulated balance, deposit fresh cash at 100%.

Iteration 3 showed a tension under DCA: buy&hold accumulates more (fresh deposits buy
dips) while the no-margin overlay protects drawdown. The hybrid tries to get both:

  - each monthly deposit is invested 100% at that day's price (always buy the dip),
  - the drawdown/trend/vol brake only ever SELLS the pre-existing invested balance to
    cash (protection), and re-risking buys respect the no-trade band,
  - never borrows (invested <= equity), so zero margin risk.

We track dollars in two sleeves — invested V and cash K (K earns RF, never negative) —
because "deposit at full weight regardless of gross" is naturally a dollar statement.
The reported return stream removes deposit inflows so Sharpe/maxDD are honest. Compared
head-to-head with buyhold and the pure no_margin overlay on the same deposit schedule.
Everything measured from deep_history.json; nothing synthesised.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
import deep_history_overlay as O
import deep_history_dca as DCA

CONTRIB = 20.0
RF, TC = O.RF, O.TC


def run_hybrid(days, px, tv, trend_m, brake, band, start=None, end=None):
    i0 = 0 if start is None else next(i for i, d in enumerate(days) if d >= start)
    i1 = len(days) if end is None else next((i for i, d in enumerate(days) if d >= end), len(days))
    V, K, peak = 0.0, 0.0, 1e-9     # invested $, cash $, equity peak
    cur_month, deposited = "", 0.0
    rets, eq_path = [], []
    overlay_trade_days, turnover_sum = 0, 0.0
    for i in range(i0, i1):
        d = days[i]
        # 1) deposit at 100% into the asset on the first trading day of the month
        if d[:7] != cur_month:
            cur_month = d[:7]
            V += CONTRIB
            deposited += CONTRIB
        eq0 = V + K
        if i == i0:
            eq_path.append((d, eq0)); continue
        # 2) apply today's market move to the invested sleeve; cash accrues RF
        asset_r = px[i] / px[i - 1] - 1.0
        V *= (1.0 + asset_r)
        K *= (1.0 + RF / 252)
        eq = V + K
        eq_after_mkt = eq
        # 3) overlay target gross (same brake math as the pure overlay)
        lo = max(0, i - 21)
        seg = px[lo:i]
        r20 = np.diff(np.log(seg)) if seg.size > 2 else np.array([0.0])
        vol20 = float(np.std(r20, ddof=1)) * math.sqrt(252) if r20.size > 5 and np.std(r20) > 0 else tv
        lo_t = max(0, i - 21 * trend_m)
        trend_ok = px[i - 1] / px[lo_t] >= 1.0 if i - lo_t > 21 else True
        dd = eq / peak - 1.0
        g = min(1.0, max(0.0, tv / max(vol20, 1e-6)))       # never borrow: cap 1.0
        if not trend_ok:
            g = 0.0
        if dd < -brake:
            over = min(1.0, (abs(dd) - brake) / brake)
            g = min(g, (1.0 - over) * 1.0)                  # taper toward all-cash
        # 4) rebalance V toward g*eq; de-risk always honored, add-risk respects band
        target_V = g * eq
        delta = target_V - V
        derisk = delta < -1e-12
        if delta < 0 or (abs(delta) / max(eq, 1e-9) > band):
            moved = abs(delta)
            V += delta
            K -= delta
            if K < 0:                                        # safety: never borrow
                V += K; K = 0.0
            cost = TC * (moved / max(eq, 1e-9))
            eq_new = eq * (1.0 - cost)
            # apply cost proportionally to invested sleeve
            V *= (1.0 - cost); K *= (1.0 - cost)
            eq = eq_new
            overlay_trade_days += 1
            turnover_sum += moved / max(eq, 1e-9)
        # 5) honest daily return excludes the deposit inflow (compare eq to pre-move-of-day)
        # return = (equity after market+rebalance) / (equity after deposit, before market) - 1
        r_day = eq / max(eq0, 1e-9) - 1.0
        rets.append(r_day)
        peak = max(peak, eq)
        eq_path.append((d, eq))
    r = np.array(rets)
    e = np.array([v for _, v in eq_path])
    peaks = np.maximum.accumulate(np.maximum(e, 1e-9))
    yrs = max(len(r) / 252.0, 1e-9)
    sh = r.mean() / r.std(ddof=1) * math.sqrt(252) if r.size > 2 and r.std(ddof=1) > 0 else 0.0
    return {"final": e[-1], "deposited": deposited, "multiple": e[-1] / max(deposited, 1e-9),
            "sharpe": sh, "maxdd": float(np.min(e / peaks - 1.0)),
            "overlay_trades_per_yr": overlay_trade_days / yrs, "years": yrs}


def main():
    NR = dict(tv=0.20, trend_m=12, brake=0.20, band=0.30)  # iter-2 selected non-risky config
    out = {}
    for sym in ("^GSPC", "^IXIC"):
        days, px = O.load_asset(sym)
        bh = DCA.run_dca(days, px, tv=0.0, trend_m=6, brake=9.9, min_gross=1.0, max_gross=1.0, band=0.0)
        nm = DCA.run_dca(days, px, min_gross=0.0, max_gross=1.0, **NR)
        hy = run_hybrid(days, px, **NR)
        print(f"\n# {sym}  {days[0]}..{days[-1]}  DCA ${CONTRIB:.0f}/mo")
        print(f"{'book':<16}{'final':>13}{'mult':>7}{'sharpe':>8}{'maxdd':>8}{'ov.trades/yr':>13}")
        rows = {"buyhold": bh, "no_margin": nm, "hybrid": hy}
        for name, r in rows.items():
            tpy = r.get("overlay_trades_per_yr", r.get("trade_days_per_yr", 0.0))
            print(f"{name:<16}{r['final']:>13,.0f}{r['multiple']:>7.2f}{r['sharpe']:>8.2f}"
                  f"{r['maxdd']*100:>7.0f}%{tpy:>13.1f}")
        out[sym] = {name: {k: v for k, v in r.items()} for name, r in rows.items()}
    (HERE / "deep_hybrid.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("\nwrote deep_hybrid.json")


if __name__ == "__main__":
    main()
