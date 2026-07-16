"""Daily-corrected leveraged trader: optimize overlay honestly, then stress-test.

- Direction: walk-forward shrunk tangency (long-only base direction recomputed
  monthly from trailing 60 months, signed allowed above margin min as before is
  DROPPED here: shorts add little and complicate margin math; direction is the
  long-only capped tangency).
- Daily overlay ("day trading added"): each DAY set gross = min(2, tv / vol20)
  x trend gate x drawdown brake. 2x overnight Reg-T cap; 4:1 intraday is not
  simulatable with daily bars and is NOT claimed.
- Tuning: grid on 2000-2012 ONLY; untouched validation 2013-2026.
- Stress: 1,000 block-bootstrap paths built ONLY from the four worst downturns
  (dot-com, GFC, COVID crash, 2022), 2 years each, starting at $25,000.
"""
import json
import math
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
OUT = Path(__file__).parent
UNIVERSE = ["SPY", "QQQ", "IWM", "EFA", "TLT", "GLD"]
CONTRIB = 20.0
MARGIN_MIN = 2000.0
MAX_GROSS = 2.0
TC = 0.0002  # 2bp per unit turnover (daily adjustments aren't free)


def fetch_daily(sym):
    p1 = int(datetime(1998, 1, 1, tzinfo=timezone.utc).timestamp())
    p2 = int(datetime.now(timezone.utc).timestamp())
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
           f"?interval=1d&period1={p1}&period2={p2}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (UnisonaSim)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        j = json.load(r)
    res = j["chart"]["result"][0]
    ts, adj = res["timestamp"], res["indicators"]["adjclose"][0]["adjclose"]
    return {datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%d"): float(a)
            for t, a in zip(ts, adj) if a is not None}


def tangency_dir(mu, cov, n, cap=0.35, cov_shrink=0.35, mu_shrink=0.5):
    c = cov.copy()
    off = ~np.eye(n, dtype=bool)
    c[off] *= (1 - cov_shrink)
    m = mu_shrink * mu.mean() + (1 - mu_shrink) * mu
    try:
        w = np.linalg.solve(c + 1e-10 * np.eye(n), m)
    except np.linalg.LinAlgError:
        w = np.ones(n)
    w = np.clip(w, 0, None)
    if w.sum() <= 0:
        w = np.ones(n)
    w /= w.sum()
    capn = max(cap, 1 / n + 1e-9)
    for _ in range(20):
        over = w > capn + 1e-12
        if not over.any():
            break
        ex = (w[over] - capn).sum()
        w[over] = capn
        un = ~over
        w[un] += ex * (w[un] / w[un].sum() if w[un].sum() > 0 else 1 / max(un.sum(), 1))
    return w / w.sum()


def build_panel():
    raw = {s: fetch_daily(s) for s in UNIVERSE}
    days = sorted(set(raw["SPY"]))
    px = {s: np.array([raw[s].get(d, np.nan) for d in days]) for s in UNIVERSE}
    for s in UNIVERSE:  # forward-fill gaps so returns are computable once listed
        v = px[s]
        for i in range(1, len(v)):
            if np.isnan(v[i]) and not np.isnan(v[i - 1]):
                v[i] = v[i - 1]
    return days, px


def run_daily(days, px, tv, trend_m, brake, start="2000-01-03", end=None,
              deposits=True, equity0=0.0, irx_flat=0.03):
    n = len(UNIVERSE)
    i0 = next(i for i, d in enumerate(days) if d >= start)
    i1 = len(days) if end is None else next(i for i, d in enumerate(days) if d >= end)
    eq, peak = equity0, max(equity0, 1e-9)
    w_dir = np.zeros(n)
    gross = 0.0
    cur_month = ""
    rets_out, eq_path, min_cushion = [], [], 1e9
    prev_expo = np.zeros(n)
    for i in range(i0, i1):
        d = days[i]
        # monthly: recompute direction from trailing 60 months of daily data
        if d[:7] != cur_month:
            cur_month = d[:7]
            if deposits:
                eq += CONTRIB
            lb = max(0, i - 252 * 5)
            live = [s for s in UNIVERSE if not np.isnan(px[s][lb:i]).any() and i - lb > 252]
            if live:
                R = np.stack([np.diff(np.log(px[s][lb:i][~np.isnan(px[s][lb:i])])) for s in live])
                L = min(r.shape[0] for r in R.reshape(len(live), -1)) if False else R.shape[1]
                mu = R.mean(axis=1) * 21  # monthly-ized
                cov = np.cov(R) * 21
                wd = tangency_dir(mu, np.atleast_2d(cov), len(live))
                w_dir = np.zeros(n)
                for k, s in enumerate(live):
                    w_dir[UNIVERSE.index(s)] = wd[k]
        if i == i0 or eq <= 0:
            eq_path.append((d, max(eq, 0.0)))
            continue
        # daily overlay: vol target + trend gate + drawdown brake
        lo20 = max(0, i - 21)
        r_dir = np.zeros(i - lo20 - 1)
        ok = w_dir.sum() > 0
        if ok:
            comp = [k for k in range(n) if w_dir[k] > 0]
            seg = np.stack([px[UNIVERSE[k]][lo20:i] for k in comp])
            if not np.isnan(seg).any():
                rr = np.diff(np.log(seg), axis=1)
                r_dir = np.array([w_dir[k] for k in comp]) @ rr
        vol20 = float(np.std(r_dir, ddof=1)) * math.sqrt(252) if r_dir.size > 5 else tv
        lo_t = max(0, i - 21 * trend_m)
        trend_ok = True
        if ok and i - lo_t > 21:
            comp = [k for k in range(n) if w_dir[k] > 0]
            seg = np.stack([px[UNIVERSE[k]][lo_t:i] for k in comp])
            if not np.isnan(seg).any():
                gr = seg[:, -1] / seg[:, 0]
                trend_ok = float(np.array([w_dir[k] for k in comp]) @ gr) >= 1.0
        dd = eq / peak - 1.0
        g = min(MAX_GROSS, tv / max(vol20, 1e-6))
        if not trend_ok:
            g = min(g, 1.0)
        if dd < -brake:
            g = min(g, 1.0 + max(0.0, 1.0 - (abs(dd) - brake) / brake))  # taper toward 1x
        if eq < MARGIN_MIN:
            g = min(g, 1.0)
        gross = g
        # apply today's asset returns to yesterday's exposure
        expo = w_dir * gross
        r_today = np.zeros(n)
        for k in range(n):
            if prev_expo[k] != 0 and not (np.isnan(px[UNIVERSE[k]][i]) or np.isnan(px[UNIVERSE[k]][i - 1])):
                r_today[k] = px[UNIVERSE[k]][i] / px[UNIVERSE[k]][i - 1] - 1.0
        port_r = float(prev_expo @ r_today)
        fund = max(0.0, np.abs(prev_expo).sum() - 1.0) * (irx_flat + 0.015) / 252
        tc = TC * float(np.abs(expo - prev_expo).sum())
        eq_r = port_r - fund - tc
        rets_out.append(eq_r)
        eq *= (1.0 + eq_r)
        eq = max(eq, 0.0)
        peak = max(peak, eq)
        # Reg-T cushion at yesterday's gross (long-only book)
        longv = np.abs(prev_expo).sum()
        if longv > 1:
            cushion = (1.0 + port_r - 0.25 * longv * (1 + port_r)) / max(longv, 1e-9)
            min_cushion = min(min_cushion, cushion)
        prev_expo = expo
        eq_path.append((d, eq))
    r = np.array(rets_out)
    sh = r.mean() / r.std(ddof=1) * math.sqrt(252) if r.size > 2 and r.std(ddof=1) > 0 else 0.0
    e = np.array([v for _, v in eq_path])
    peaks = np.maximum.accumulate(np.maximum(e, 1e-9))
    mdd = float(np.min(e / peaks - 1.0))
    return {"final": eq, "sharpe": sh, "maxdd": mdd, "min_cushion": min_cushion,
            "path": eq_path, "rets": r}


def main():
    days, px = build_panel()
    print(f"panel: {len(days)} days {days[0]} -> {days[-1]}")

    # ── honest tuning: grid on 2000-2012, validate 2013+ ─────────────────────
    grid = [(tv, tm, bk) for tv in (0.15, 0.20, 0.25) for tm in (6, 10, 12) for bk in (0.10, 0.15, 0.20)]
    results = []
    for tv, tm, bk in grid:
        tr = run_daily(days, px, tv, tm, bk, start="2000-01-03", end="2013-01-01")
        results.append(((tv, tm, bk), tr["sharpe"], tr["final"]))
    results.sort(key=lambda x: -x[1])
    print("top-3 train configs (2000-2012):",
          [(c, round(s, 2)) for c, s, _f in results[:3]])
    best = results[0][0]
    va = run_daily(days, px, *best, start="2013-01-02")
    fu = run_daily(days, px, *best, start="2000-01-03")
    print(f"BEST {best}: validation 2013+ sharpe {va['sharpe']:.2f} final ${va['final']:,.0f} maxDD {va['maxdd']*100:.0f}%")
    print(f"BEST {best}: full 2000+   sharpe {fu['sharpe']:.2f} final ${fu['final']:,.0f} maxDD {fu['maxdd']*100:.0f}% "
          f"minCushion {fu['min_cushion']*100:.1f}%")

    # ── 1,000 worst-downturn bootstrap paths ────────────────────────────────
    crises = [("2000-03-01", "2003-03-31"), ("2007-10-01", "2009-03-31"),
              ("2020-02-14", "2020-04-30"), ("2022-01-01", "2022-10-31")]
    idx = [i for i, d in enumerate(days)
           if any(a <= d <= b for a, b in crises) and i > 0]
    # joint daily returns on crisis days (NaN-free columns only)
    cols, rmat = [], []
    for i in idx:
        col = []
        bad = False
        for s in UNIVERSE:
            a, b = px[s][i - 1], px[s][i]
            if np.isnan(a) or np.isnan(b) or a <= 0:
                bad = True
                break
            col.append(b / a - 1.0)
        if not bad:
            rmat.append(col)
    rmat = np.array(rmat)
    print(f"crisis-day pool: {rmat.shape[0]} days from 4 downturns")
    rng = np.random.default_rng(20260715)
    T, NB = 504, 1000
    tv, tm, bk = best
    finals, calls = [], 0
    for b in range(NB):
        # stationary block bootstrap, mean block 21 days
        rows = []
        while len(rows) < T:
            st = rng.integers(0, rmat.shape[0])
            ln = min(int(rng.geometric(1 / 21)), T - len(rows), rmat.shape[0] - st)
            rows.extend(range(st, st + max(ln, 1)))
        path = rmat[rows[:T]]
        # run overlay on synthetic path: fixed diversified direction (equal-cap
        # tangency proxy), daily vol/trend/brake overlay, start $25k, no deposits
        w_dir = np.full(len(UNIVERSE), 1 / len(UNIVERSE))
        eq, peak = 25000.0, 25000.0
        prev_g, called = 1.0, False
        r_hist = []
        for t in range(T):
            r_dir = float(w_dir @ path[t])
            r_hist.append(r_dir)
            vol20 = np.std(r_hist[-21:], ddof=1) * math.sqrt(252) if len(r_hist) > 5 else tv
            trend_ok = np.prod(1 + np.array(r_hist[-21 * tm:])) >= 1 if len(r_hist) > 21 else True
            dd = eq / peak - 1
            g = min(MAX_GROSS, tv / max(vol20, 1e-6))
            if not trend_ok:
                g = min(g, 1.0)
            if dd < -bk:
                g = min(g, 1.0)
            port_r = prev_g * r_dir - max(0.0, prev_g - 1) * 0.045 / 252 - TC * abs(g - prev_g)
            if prev_g > 1 and (1 + port_r - 0.25 * prev_g * (1 + port_r)) < 0:
                called = True
            eq *= (1 + port_r)
            eq = max(eq, 0.0)
            peak = max(peak, eq)
            prev_g = g
        finals.append(eq)
        calls += called
    finals = np.array(finals)
    print(f"STRESS (1,000 x 2y crisis-only paths, start $25k, overlay {best}):")
    print(f"  margin calls: {calls}/1000  |  P(final < $10k): {np.mean(finals < 10000)*100:.1f}%")
    print(f"  median final ${np.median(finals):,.0f} · p5 ${np.percentile(finals,5):,.0f} · p95 ${np.percentile(finals,95):,.0f} · min ${finals.min():,.0f}")
    # same stress WITHOUT overlay (static 2x) for comparison
    finals2, calls2 = [], 0
    rng = np.random.default_rng(20260715)
    for b in range(NB):
        rows = []
        while len(rows) < T:
            st = rng.integers(0, rmat.shape[0])
            ln = min(int(rng.geometric(1 / 21)), T - len(rows), rmat.shape[0] - st)
            rows.extend(range(st, st + max(ln, 1)))
        path = rmat[rows[:T]]
        w_dir = np.full(len(UNIVERSE), 1 / len(UNIVERSE))
        eq, peak, called = 25000.0, 25000.0, False
        for t in range(T):
            r_dir = float(w_dir @ path[t])
            port_r = 2.0 * r_dir - 0.045 / 252
            if (1 + port_r - 0.25 * 2.0 * (1 + port_r)) < 0:
                called = True
            eq = max(eq * (1 + port_r), 0.0)
            peak = max(peak, eq)
        finals2.append(eq)
        calls2 += called
    finals2 = np.array(finals2)
    print(f"STRESS static 2x (no overlay): calls {calls2}/1000 | P(final<$10k) {np.mean(finals2<10000)*100:.1f}% | median ${np.median(finals2):,.0f} | min ${finals2.min():,.0f}")

    json.dump({"best": best,
               "validation": {"sharpe": va["sharpe"], "final": va["final"], "maxdd": va["maxdd"]},
               "full": {"sharpe": fu["sharpe"], "final": fu["final"], "maxdd": fu["maxdd"]},
               "stress": {"calls": int(calls), "p_below_10k": float(np.mean(finals < 10000)),
                          "median": float(np.median(finals)), "p5": float(np.percentile(finals, 5))},
               "stress_static": {"calls": int(calls2), "p_below_10k": float(np.mean(finals2 < 10000)),
                                 "median": float(np.median(finals2))}},
              open(OUT / "daily_leverage_opt.json", "w"), indent=1)


if __name__ == "__main__":
    main()
