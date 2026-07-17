"""Momentum tilt inside the brake-to-cash overlay.

Direction becomes classic 12-1 cross-sectional momentum (trailing 252d return
skipping the last 21d) over the same 6-ETF universe: top-k equal weight, or a
50/50 blend with the shrunk tangency direction. Same brake: gross in [0, 2x],
vol-target 35%, 6-mo trend gate -> cash, 30% dd taper -> cash, cash earns RF.
Train 2000-2012 selects among {mom2, mom3, blend3}; validate 2013+; stress.
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

RF = 0.03
TV, TM, BK, MG = 0.35, 6, 0.30, 0.0  # fixed brake config (the validated one)


def directions(days, px, i, mode):
    """Direction weights at day i (month start). Returns np.array over D.UNIVERSE."""
    n = len(D.UNIVERSE)
    lb = max(0, i - 252 * 5)
    live = [s for s in D.UNIVERSE if not np.isnan(px[s][lb:i]).any() and i - lb > 273]
    if not live:
        return np.zeros(n)
    w = np.zeros(n)
    if mode == "tangency":
        R = np.stack([np.diff(np.log(px[s][lb:i][~np.isnan(px[s][lb:i])])) for s in live])
        wd = D.tangency_dir(R.mean(axis=1) * 21, np.atleast_2d(np.cov(R) * 21), len(live))
        for k, s in enumerate(live):
            w[D.UNIVERSE.index(s)] = wd[k]
        return w
    # 12-1 momentum: trailing 252d return, skipping the most recent 21d
    mom = {}
    for s in live:
        a, b = px[s][i - 252], px[s][i - 21]
        if a and b and a > 0 and not (np.isnan(a) or np.isnan(b)):
            mom[s] = b / a - 1.0
    if not mom:
        return np.zeros(n)
    ranked = sorted(mom, key=mom.get, reverse=True)
    k = 2 if mode == "mom2" else 3
    top = ranked[:min(k, len(ranked))]
    for s in top:
        w[D.UNIVERSE.index(s)] = 1.0 / len(top)
    if mode == "blend3":
        wt = directions(days, px, i, "tangency")
        w = 0.5 * w + 0.5 * wt
        ssum = w.sum()
        if ssum > 0:
            w = w / ssum
    return w


def run(days, px, mode, start="2000-01-03", end=None):
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
            w_dir = directions(days, px, i, mode)
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
        vol20 = float(np.std(r_dir, ddof=1)) * math.sqrt(252) if r_dir.size > 5 else TV
        lo_t = max(0, i - 21 * TM)
        trend_ok = True
        if ok and i - lo_t > 21:
            comp = [k for k in range(n) if w_dir[k] > 0]
            seg = np.stack([px[D.UNIVERSE[k]][lo_t:i] for k in comp])
            if not np.isnan(seg).any():
                gr = seg[:, -1] / seg[:, 0]
                trend_ok = float(np.array([w_dir[k] for k in comp]) @ gr) >= 1.0
        dd = eq / peak - 1.0
        g = min(D.MAX_GROSS, max(MG, TV / max(vol20, 1e-6)))
        if not trend_ok:
            g = min(g, MG)
        if dd < -BK:
            over = min(1.0, (abs(dd) - BK) / BK)
            g = min(g, MG + (1.0 - over) * max(0.0, 1.0 - MG))
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
            "time_below_1x": float(np.mean(np.array(gross_hist) < 0.99)) if gross_hist else 0.0,
            "path": eq_path, "rets": r}


def ci(sh, T):
    s = sh / math.sqrt(252)
    se = math.sqrt((1 + s * s / 2) / T) * math.sqrt(252)
    return sh - 1.96 * se, sh + 1.96 * se


def main():
    days, px = D.build_panel()
    train = {}
    for mode in ("mom2", "mom3", "blend3"):
        t = run(days, px, mode, end="2013-01-01")
        train[mode] = t
        print(f"train {mode}: sharpe {t['sharpe']:.2f} final ${t['final']:,.0f} maxDD {t['maxdd']*100:.0f}%")
    # selection: max train final (return-max mandate) among positive-sharpe configs
    best = max((m for m in train if train[m]["sharpe"] > 0), key=lambda m: train[m]["final"])
    print("BEST:", best)
    va = run(days, px, best, start="2013-01-02")
    fu = run(days, px, best)
    for name, r in (("valid", va), ("full", fu)):
        lo, hi = ci(r["sharpe"], len(r["rets"]))
        print(f"{best} {name}: final ${r['final']:,.0f} sharpe {r['sharpe']:.2f} [{lo:.2f},{hi:.2f}] "
              f"maxDD {r['maxdd']*100:.0f}% avgGross {r['avg_gross']:.2f} time<1x {r['time_below_1x']*100:.0f}%")

    m = {}
    for dstr, eqv in fu["path"]:
        m[dstr[:7]] = eqv
    extra = json.loads((HERE / "leverage_momentum_paths.json").read_text(encoding="utf-8"))
    extra["mom"] = m
    (HERE / "leverage_momentum_paths.json").write_text(json.dumps(extra), encoding="utf-8")
    json.dump({"best": best,
               "train": {k: {"sharpe": v["sharpe"], "final": v["final"]} for k, v in train.items()},
               "full": {"final": fu["final"], "sharpe": fu["sharpe"], "maxdd": fu["maxdd"],
                        "avg_gross": fu["avg_gross"], "time_below_1x": fu["time_below_1x"]},
               "validation": {"final": va["final"], "sharpe": va["sharpe"], "maxdd": va["maxdd"]}},
              open(HERE / "momentum_brake.json", "w"), indent=1)
    print("wrote momentum_brake.json + path")


if __name__ == "__main__":
    main()
