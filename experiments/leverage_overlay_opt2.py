"""Round 2: dual objective — Sharpe AND beat SPY DCA by >= $10k, crisis-robust.

Selection rule (pre-committed, train 2000-2012 only): among configs whose train
final beats train SPY-DCA by >= 10%, pick max train Sharpe. Validate 2013+,
report full period, then stress the winner on 1,000 crisis-only paths.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import leverage_daily_overlay as D

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
OUT = Path(__file__).parent


def spy_dca(days, px, start, end=None):
    i0 = next(i for i, d in enumerate(days) if d >= start)
    i1 = len(days) if end is None else next(i for i, d in enumerate(days) if d >= end)
    shares, cur = 0.0, ""
    for i in range(i0, i1):
        if days[i][:7] != cur and not np.isnan(px["SPY"][i]):
            cur = days[i][:7]
            shares += D.CONTRIB / px["SPY"][i]
    last = next(j for j in range(i1 - 1, i0, -1) if not np.isnan(px["SPY"][j]))
    return shares * px["SPY"][last]


def stress(best, rmat, label):
    rng = np.random.default_rng(20260715)
    tv, tm, bk = best
    T, NB = 504, 1000
    finals, calls = [], 0
    for b in range(NB):
        rows = []
        while len(rows) < T:
            st = rng.integers(0, rmat.shape[0])
            ln = min(int(rng.geometric(1 / 21)), T - len(rows), rmat.shape[0] - st)
            rows.extend(range(st, st + max(ln, 1)))
        path = rmat[rows[:T]]
        w_dir = np.full(len(D.UNIVERSE), 1 / len(D.UNIVERSE))
        eq, peak, called, prev_g = 25000.0, 25000.0, False, 1.0
        r_hist = []
        for t in range(T):
            r_dir = float(w_dir @ path[t])
            r_hist.append(r_dir)
            vol20 = np.std(r_hist[-21:], ddof=1) * math.sqrt(252) if len(r_hist) > 5 else tv
            trend_ok = np.prod(1 + np.array(r_hist[-21 * tm:])) >= 1 if len(r_hist) > 21 else True
            dd = eq / peak - 1
            g = min(D.MAX_GROSS, tv / max(vol20, 1e-6))
            if not trend_ok:
                g = min(g, 1.0)
            if dd < -bk:
                g = min(g, 1.0)
            port_r = prev_g * r_dir - max(0.0, prev_g - 1) * 0.045 / 252 - D.TC * abs(g - prev_g)
            if prev_g > 1 and (1 + port_r - 0.25 * prev_g * (1 + port_r)) < 0:
                called = True
            eq = max(eq * (1 + port_r), 0.0)
            peak = max(peak, eq)
            prev_g = g
        finals.append(eq)
        calls += called
    finals = np.array(finals)
    print(f"STRESS {label}: calls {calls}/1000 | P(final<$10k) {np.mean(finals<10000)*100:.1f}% | "
          f"median ${np.median(finals):,.0f} | p5 ${np.percentile(finals,5):,.0f} | min ${finals.min():,.0f}")
    return {"calls": int(calls), "p_below_10k": float(np.mean(finals < 10000)),
            "median": float(np.median(finals)), "p5": float(np.percentile(finals, 5)),
            "min": float(finals.min())}


def main():
    days, px = D.build_panel()
    spy_train = spy_dca(days, px, "2000-01-03", "2013-01-01")
    spy_full = spy_dca(days, px, "2000-01-03")
    print(f"SPY DCA: train ${spy_train:,.0f}  full ${spy_full:,.0f}")

    grid = [(tv, tm, bk) for tv in (0.20, 0.25, 0.30) for tm in (6, 10, 12) for bk in (0.15, 0.20, 0.30)]
    rows = []
    for cfg in grid:
        tr = D.run_daily(days, px, *cfg, start="2000-01-03", end="2013-01-01")
        rows.append((cfg, tr["sharpe"], tr["final"]))
    eligible = [r for r in rows if r[2] >= spy_train * 1.10]
    pool = eligible if eligible else rows
    pool.sort(key=lambda x: -x[1])
    print(f"eligible (train final >= 1.10x SPY-train): {len(eligible)}/{len(rows)}")
    print("top-3:", [(c, round(s, 2), f"${f:,.0f}") for c, s, f in pool[:3]])
    best = pool[0][0]

    va = D.run_daily(days, px, *best, start="2013-01-02")
    fu = D.run_daily(days, px, *best, start="2000-01-03")
    spy_va = spy_dca(days, px, "2013-01-02")
    print(f"BEST {best}: validation sharpe {va['sharpe']:.2f} final ${va['final']:,.0f} (SPY ${spy_va:,.0f}, diff ${va['final']-spy_va:+,.0f}) maxDD {va['maxdd']*100:.0f}%")
    print(f"BEST {best}: full sharpe {fu['sharpe']:.2f} final ${fu['final']:,.0f} (SPY ${spy_full:,.0f}, diff ${fu['final']-spy_full:+,.0f}) "
          f"maxDD {fu['maxdd']*100:.0f}% minCushion {fu['min_cushion']*100:.1f}%")

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
    rmat = np.array(rmat)
    st = stress(best, rmat, f"overlay {best}")

    json.dump({"best": list(best), "spy_full": spy_full,
               "validation": {"sharpe": va["sharpe"], "final": va["final"], "spy": spy_va, "maxdd": va["maxdd"]},
               "full": {"sharpe": fu["sharpe"], "final": fu["final"], "diff_vs_spy": fu["final"] - spy_full,
                        "maxdd": fu["maxdd"], "min_cushion": fu["min_cushion"]},
               "stress": st},
              open(OUT / "daily_leverage_opt2.json", "w"), indent=1)


if __name__ == "__main__":
    main()
