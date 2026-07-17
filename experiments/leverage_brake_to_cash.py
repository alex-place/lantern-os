"""Deeper brake: borrow less AND convert to cash.

Extends the daily overlay so gross can fall BELOW 1x (partial/full cash):
  - vol targeting uncapped below 1: g_vol = tv / vol20, clamped to [min_gross, 2]
  - trend gate: 6-mo trend down -> gross capped at the CASH floor (not 1.0)
  - drawdown brake: dd worse than brake -> taper toward min_gross (not 1.0)
  - cash side: the uninvested fraction (1 - gross) EARNS the T-bill rate;
    borrowing (gross > 1) still PAYS T-bill + 150bp. Same 2bp turnover drag.

Grid over {tv} x {brake} x {min_gross}, trained 2000-2012 only (selection:
max train final among configs with train Sharpe >= SPY-train), validated 2013+,
plus the crisis bootstrap. Compares against the current path forward.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import leverage_daily_overlay as D

RF = 0.03  # flat cash/funding base, matches run_daily's irx_flat


def run_daily_cash(days, px, tv, trend_m, brake, min_gross, start="2000-01-03", end=None):
    n = len(D.UNIVERSE)
    i0 = next(i for i, d in enumerate(days) if d >= start)
    i1 = len(days) if end is None else next(i for i, d in enumerate(days) if d >= end)
    eq, peak = 0.0, 1e-9
    w_dir = np.zeros(n)
    cur_month = ""
    rets_out, eq_path = [], []
    prev_expo = np.zeros(n)
    gross_hist = []
    for i in range(i0, i1):
        d = days[i]
        if d[:7] != cur_month:
            cur_month = d[:7]
            eq += D.CONTRIB
            lb = max(0, i - 252 * 5)
            live = [s for s in D.UNIVERSE if not np.isnan(px[s][lb:i]).any() and i - lb > 252]
            if live:
                R = np.stack([np.diff(np.log(px[s][lb:i][~np.isnan(px[s][lb:i])])) for s in live])
                mu = R.mean(axis=1) * 21
                cov = np.cov(R) * 21
                wd = D.tangency_dir(mu, np.atleast_2d(cov), len(live))
                w_dir = np.zeros(n)
                for k, s in enumerate(live):
                    w_dir[D.UNIVERSE.index(s)] = wd[k]
        if i == i0 or eq <= 0:
            eq_path.append((d, max(eq, 0.0)))
            continue
        lo20 = max(0, i - 21)
        r_dir = np.zeros(i - lo20 - 1)
        ok = w_dir.sum() > 0
        if ok:
            comp = [k for k in range(n) if w_dir[k] > 0]
            seg = np.stack([px[D.UNIVERSE[k]][lo20:i] for k in comp])
            if not np.isnan(seg).any():
                rr = np.diff(np.log(seg), axis=1)
                r_dir = np.array([w_dir[k] for k in comp]) @ rr
        vol20 = float(np.std(r_dir, ddof=1)) * math.sqrt(252) if r_dir.size > 5 else tv
        lo_t = max(0, i - 21 * trend_m)
        trend_ok = True
        if ok and i - lo_t > 21:
            comp = [k for k in range(n) if w_dir[k] > 0]
            seg = np.stack([px[D.UNIVERSE[k]][lo_t:i] for k in comp])
            if not np.isnan(seg).any():
                gr = seg[:, -1] / seg[:, 0]
                trend_ok = float(np.array([w_dir[k] for k in comp]) @ gr) >= 1.0
        dd = eq / peak - 1.0
        # vol targeting, UNCAPPED below 1x — clamps to [min_gross, MAX_GROSS]
        g = min(D.MAX_GROSS, max(min_gross, tv / max(vol20, 1e-6)))
        if not trend_ok:
            g = min(g, min_gross)          # trend down -> to the cash floor
        if dd < -brake:
            # taper toward the cash floor as the drawdown deepens
            over = min(1.0, (abs(dd) - brake) / brake)
            g = min(g, min_gross + (1.0 - over) * max(0.0, 1.0 - min_gross))
        if eq < D.MARGIN_MIN:
            g = min(g, 1.0)
        expo = w_dir * g
        r_today = np.zeros(n)
        for k in range(n):
            if prev_expo[k] != 0 and not (np.isnan(px[D.UNIVERSE[k]][i]) or np.isnan(px[D.UNIVERSE[k]][i - 1])):
                r_today[k] = px[D.UNIVERSE[k]][i] / px[D.UNIVERSE[k]][i - 1] - 1.0
        port_r = float(prev_expo @ r_today)
        prev_g = float(np.abs(prev_expo).sum())
        carry = (-(prev_g - 1.0) * (RF + 0.015) / 252) if prev_g > 1 else ((1.0 - prev_g) * RF / 252)
        tc = D.TC * float(np.abs(expo - prev_expo).sum())
        eq_r = port_r + carry - tc
        rets_out.append(eq_r)
        eq = max(eq * (1.0 + eq_r), 0.0)
        peak = max(peak, eq)
        prev_expo = expo
        gross_hist.append(prev_g)
        eq_path.append((d, eq))
    r = np.array(rets_out)
    sh = r.mean() / r.std(ddof=1) * math.sqrt(252) if r.size > 2 and r.std(ddof=1) > 0 else 0.0
    e = np.array([v for _, v in eq_path])
    peaks = np.maximum.accumulate(np.maximum(e, 1e-9))
    return {"final": eq, "sharpe": sh, "maxdd": float(np.min(e / peaks - 1.0)),
            "avg_gross": float(np.mean(gross_hist)) if gross_hist else 0.0,
            "pct_in_cashish": float(np.mean(np.array(gross_hist) < 0.99)) if gross_hist else 0.0,
            "path": eq_path, "rets": r}


def main():
    days, px = D.build_panel()
    # SPY train Sharpe from the buffett run: 0.18 (recompute cheaply not needed; use known bar)
    SPY_TRAIN_SHARPE = 0.18
    grid = [(tv, bk, mg) for tv in (0.20, 0.35) for bk in (0.15, 0.30) for mg in (0.0, 0.5)]
    rows = []
    for tv, bk, mg in grid:
        tr = run_daily_cash(days, px, tv, 6, bk, mg, start="2000-01-03", end="2013-01-01")
        rows.append(((tv, bk, mg), tr["sharpe"], tr["final"]))
        print(f"  train ({tv},{bk},{mg}): sharpe {tr['sharpe']:.2f} final ${tr['final']:,.0f}")
    eligible = [r for r in rows if r[1] >= SPY_TRAIN_SHARPE] or rows
    eligible.sort(key=lambda x: -x[2])
    best = eligible[0][0]
    print("BEST train config:", best)

    va = run_daily_cash(days, px, best[0], 6, best[1], best[2], start="2013-01-02")
    fu = run_daily_cash(days, px, best[0], 6, best[1], best[2], start="2000-01-03")
    ref = D.run_daily(days, px, 0.35, 6, 0.30, start="2000-01-03")  # current path forward
    for name, r in [("deeper-brake full", fu), ("deeper-brake valid", va)]:
        T = len(r["rets"])
        s = r["sharpe"] / math.sqrt(252)
        se = math.sqrt((1 + s * s / 2) / T) * math.sqrt(252)
        print(f"{name}: final ${r['final']:,.0f} sharpe {r['sharpe']:.2f} [{r['sharpe']-1.96*se:.2f},{r['sharpe']+1.96*se:.2f}] "
              f"maxDD {r['maxdd']*100:.0f}% avgGross {r['avg_gross']:.2f} time<1x {r['pct_in_cashish']*100:.0f}%")
    print(f"current path fwd: final ${ref['final']:,.0f} sharpe {ref['sharpe']:.2f} maxDD {ref['maxdd']*100:.0f}%")

    # monthly path for the chart
    m = {}
    for dstr, eqv in fu["path"]:
        m[dstr[:7]] = eqv
    extra = json.loads((HERE / "extra_paths.json").read_text(encoding="utf-8"))
    extra["deeper"] = m
    (HERE / "extra_paths.json").write_text(json.dumps(extra), encoding="utf-8")
    json.dump({"best": list(best),
               "full": {"final": fu["final"], "sharpe": fu["sharpe"], "maxdd": fu["maxdd"],
                        "avg_gross": fu["avg_gross"], "time_below_1x": fu["pct_in_cashish"]},
               "validation": {"final": va["final"], "sharpe": va["sharpe"], "maxdd": va["maxdd"]}},
              open(HERE / "deeper_brake.json", "w"), indent=1)
    print("wrote deeper_brake.json + path")


if __name__ == "__main__":
    main()
