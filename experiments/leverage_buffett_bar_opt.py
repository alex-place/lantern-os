"""Round 3: gate lowered to the Buffett bar (Sharpe 0.79) — maximize return.

Pre-committed selection (train 2000-2012 ONLY): among configs whose train Sharpe
beats SPY's train Sharpe (the relative Buffett-style bar — absolute 0.79 on a
two-bear window would empty the set), pick MAX TRAIN FINAL. Validate 2013+,
report full-period vs the 0.79 bar with a Lo-CI, and stress the winner.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import leverage_daily_overlay as D
import leverage_overlay_opt2 as O2

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
OUT = Path(__file__).parent
BAR = 0.79


def spy_run(days, px, start, end=None):
    """SPY-only DCA in the same daily engine: deposit-stripped Sharpe + final."""
    i0 = next(i for i, d in enumerate(days) if d >= start)
    i1 = len(days) if end is None else next(i for i, d in enumerate(days) if d >= end)
    shares, cur, eq_prev = 0.0, "", 0.0
    rets = []
    for i in range(i0, i1):
        p = px["SPY"][i]
        if np.isnan(p):
            continue
        if days[i][:7] != cur:
            cur = days[i][:7]
            shares += D.CONTRIB / p
            eq_prev = shares * (px["SPY"][i - 1] if not np.isnan(px["SPY"][i - 1]) else p) if i > i0 else 0
        eq = shares * p
        if eq_prev > 0:
            rets.append(eq / eq_prev - 1.0)
        eq_prev = eq
    r = np.array(rets)
    sh = r.mean() / r.std(ddof=1) * math.sqrt(252) if r.size > 2 else 0.0
    return sh, shares * px["SPY"][max(j for j in range(i0, i1) if not np.isnan(px["SPY"][j]))]


def ci(sh, T):
    s = sh / math.sqrt(252)
    se = math.sqrt((1 + s * s / 2) / T) * math.sqrt(252)
    return sh - 1.96 * se, sh + 1.96 * se


def verdict(sh, lo):
    if lo >= BAR:
        return "meets_ci"
    if sh >= BAR:
        return "meets_point"
    return "below"


def main():
    days, px = D.build_panel()
    spy_tr_sh, spy_tr_fin = spy_run(days, px, "2000-01-03", "2013-01-01")
    spy_full_sh, spy_full_fin = spy_run(days, px, "2000-01-03")
    spy_va_sh, spy_va_fin = spy_run(days, px, "2013-01-02")
    print(f"SPY: train sharpe {spy_tr_sh:.2f} final ${spy_tr_fin:,.0f} | "
          f"validation {spy_va_sh:.2f} ${spy_va_fin:,.0f} | full {spy_full_sh:.2f} ${spy_full_fin:,.0f}")

    grid = [(tv, tm, bk) for tv in (0.20, 0.25, 0.30, 0.35) for tm in (6, 10, 12) for bk in (0.15, 0.20, 0.30)]
    rows = []
    for cfg in grid:
        tr = D.run_daily(days, px, *cfg, start="2000-01-03", end="2013-01-01")
        rows.append((cfg, tr["sharpe"], tr["final"]))
    eligible = [r for r in rows if r[1] >= spy_tr_sh]
    print(f"eligible (train sharpe >= SPY train {spy_tr_sh:.2f}): {len(eligible)}/{len(rows)}")
    pool = eligible if eligible else rows
    pool.sort(key=lambda x: -x[2])  # MAX RETURN among the risk-qualified
    print("top-3 by train final:", [(c, round(s, 2), f"${f:,.0f}") for c, s, f in pool[:3]])
    best = pool[0][0]

    va = D.run_daily(days, px, *best, start="2013-01-02")
    fu = D.run_daily(days, px, *best, start="2000-01-03")
    fu_lo, fu_hi = ci(fu["sharpe"], len(fu["rets"]))
    va_lo, va_hi = ci(va["sharpe"], len(va["rets"]))
    print(f"BEST {best}:")
    print(f"  validation: sharpe {va['sharpe']:.2f} [{va_lo:.2f},{va_hi:.2f}] -> {verdict(va['sharpe'], va_lo)} | "
          f"final ${va['final']:,.0f} (SPY ${spy_va_fin:,.0f}, {va['final']-spy_va_fin:+,.0f}) maxDD {va['maxdd']*100:.0f}%")
    print(f"  full:       sharpe {fu['sharpe']:.2f} [{fu_lo:.2f},{fu_hi:.2f}] -> {verdict(fu['sharpe'], fu_lo)} | "
          f"final ${fu['final']:,.0f} (SPY ${spy_full_fin:,.0f}, {fu['final']-spy_full_fin:+,.0f}) "
          f"maxDD {fu['maxdd']*100:.0f}% minCushion {fu['min_cushion']*100:.1f}%")

    # crisis stress on the winner
    from datetime import datetime
    crises = [("2000-03-01", "2003-03-31"), ("2007-10-01", "2009-03-31"),
              ("2020-02-14", "2020-04-30"), ("2022-01-01", "2022-10-31")]
    idx = [i for i, d in enumerate(days) if any(a <= d <= b for a, b in crises) and i > 0]
    rmat = []
    for i in idx:
        col, bad = [], False
        for s in D.UNIVERSE:
            a, b = px[s][i - 1], px[s][i]
            if np.isnan(a) or np.isnan(b) or a <= 0:
                bad = True
                break
            col.append(b / a - 1.0)
        if not bad:
            rmat.append(col)
    st = O2.stress(best, np.array(rmat), f"buffett-bar winner {best}")

    json.dump({"bar": BAR, "best": list(best),
               "spy": {"train_sharpe": spy_tr_sh, "full_sharpe": spy_full_sh, "full_final": spy_full_fin},
               "validation": {"sharpe": va["sharpe"], "lo": va_lo, "final": va["final"],
                              "verdict": verdict(va["sharpe"], va_lo)},
               "full": {"sharpe": fu["sharpe"], "lo": fu_lo, "final": fu["final"],
                        "verdict": verdict(fu["sharpe"], fu_lo), "maxdd": fu["maxdd"]},
               "stress": st},
              open(OUT / "buffett_bar_opt.json", "w"), indent=1)


if __name__ == "__main__":
    main()
