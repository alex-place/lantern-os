"""Champion instrumented run (full trade log) + 1,000-path bootstrap test.

A) Re-run the champion ($2,000 + $20/mo, 2000->now, 8-asset universe, brake-to-
   cash) capturing EVERY trade: monthly direction rebalances (target weights)
   and every day the gross changes by >= 0.01x (with the binding reason).
B) Bootstrap test: 1,000 alternate 2-year histories block-bootstrapped from the
   joint daily returns of the all-8 era (2015-10+ — includes 2018Q4, 2020, 2022),
   $2,000 + $20/mo premise, equal-weight direction proxy + exact brake mechanics.
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

D.UNIVERSE = ["SPY", "QQQ", "IWM", "EFA", "TLT", "GLD", "XMMO", "SPMO"]
TV, TM, BK, MG = 0.35, 6, 0.30, 0.0
RF, INIT, MONTHLY = 0.03, 2000.0, 20.0

days, px = D.build_panel()
n = len(D.UNIVERSE)
i0 = next(i for i, d in enumerate(days) if d >= "2000-01-03")

# ── A) instrumented champion run ─────────────────────────────────────────────
eq, peak = INIT, INIT
w_dir = np.zeros(n)
prev_expo = np.zeros(n)
cur = ""
trades = []           # {date, type, detail...}
gross_prev = 0.0
weights_hist = []
for i in range(i0, len(days)):
    d = days[i]
    if d[:7] != cur:
        cur = d[:7]
        eq += MONTHLY
        lb = max(0, i - 252 * 5)
        live = [s for s in D.UNIVERSE if not np.isnan(px[s][lb:i]).any() and i - lb > 252]
        if live:
            R = np.stack([np.diff(np.log(px[s][lb:i][~np.isnan(px[s][lb:i])])) for s in live])
            wd = D.tangency_dir(R.mean(axis=1) * 21, np.atleast_2d(np.cov(R) * 21), len(live))
            new_dir = np.zeros(n)
            for k, s in enumerate(live):
                new_dir[D.UNIVERSE.index(s)] = wd[k]
            if np.abs(new_dir - w_dir).sum() > 0.005:
                trades.append({"date": d, "type": "rebalance",
                               "weights": {D.UNIVERSE[k]: round(float(new_dir[k]) * 100, 1)
                                           for k in range(n) if new_dir[k] > 0.001},
                               "equity": round(eq, 2)})
            w_dir = new_dir
            weights_hist.append(w_dir.copy())
    if i == i0 or eq <= 0:
        continue
    lo20 = max(0, i - 21)
    r_dir = np.zeros(i - lo20 - 1)
    ok = w_dir.sum() > 0
    comp = [k for k in range(n) if w_dir[k] > 0]
    if ok:
        seg = np.stack([px[D.UNIVERSE[k]][lo20:i] for k in comp])
        if not np.isnan(seg).any():
            r_dir = np.array([w_dir[k] for k in comp]) @ np.diff(np.log(seg), axis=1)
    vol20 = float(np.std(r_dir, ddof=1)) * math.sqrt(252) if r_dir.size > 5 else TV
    lo_t = max(0, i - 21 * TM)
    trend_ok = True
    if ok and i - lo_t > 21:
        seg = np.stack([px[D.UNIVERSE[k]][lo_t:i] for k in comp])
        if not np.isnan(seg).any():
            trend_ok = float(np.array([w_dir[k] for k in comp]) @ (seg[:, -1] / seg[:, 0])) >= 1.0
    dd = eq / peak - 1.0
    g = min(D.MAX_GROSS, max(MG, TV / max(vol20, 1e-6)))
    reason = "vol-target"
    if not trend_ok:
        g2 = min(g, MG)
        if g2 < g: reason = "trend-down->cash"
        g = g2
    if dd < -BK:
        over = min(1.0, (abs(dd) - BK) / BK)
        g3 = min(g, MG + (1.0 - over) * max(0.0, 1.0 - MG))
        if g3 < g: reason = "drawdown-taper"
        g = g3
    if eq < D.MARGIN_MIN:
        g4 = min(g, 1.0)
        if g4 < g: reason = "below-margin-min"
        g = g4
    expo = w_dir * g
    r_today = np.zeros(n)
    for k in range(n):
        if prev_expo[k] != 0 and not (np.isnan(px[D.UNIVERSE[k]][i]) or np.isnan(px[D.UNIVERSE[k]][i - 1])):
            r_today[k] = px[D.UNIVERSE[k]][i] / px[D.UNIVERSE[k]][i - 1] - 1.0
    port_r = float(prev_expo @ r_today)
    pg = float(np.abs(prev_expo).sum())
    carry = (-(pg - 1.0) * (RF + 0.015) / 252) if pg > 1 else ((1.0 - pg) * RF / 252)
    eq = max(eq * (1.0 + port_r + carry - D.TC * float(np.abs(expo - prev_expo).sum())), 0.0)
    peak = max(peak, eq)
    if abs(g - gross_prev) >= 0.01:
        trades.append({"date": d, "type": "brake", "gross_from": round(gross_prev, 2),
                       "gross_to": round(g, 2), "reason": reason, "equity": round(eq, 2)})
        gross_prev = g
    prev_expo = expo

avg_w = np.mean(np.stack(weights_hist), axis=0)
last_w = weights_hist[-1]
out_a = {"final": round(eq, 2), "n_trades": len(trades),
         "n_rebalances": sum(1 for t in trades if t["type"] == "rebalance"),
         "n_brake_moves": sum(1 for t in trades if t["type"] == "brake"),
         "avg_weights": {D.UNIVERSE[k]: round(float(avg_w[k]) * 100, 1) for k in range(n)},
         "last_weights": {D.UNIVERSE[k]: round(float(last_w[k]) * 100, 1) for k in range(n) if last_w[k] > 0.001},
         "trades": trades}
json.dump(out_a, open(HERE / "champion_trades.json", "w"), indent=0)
print(f"A) final ${eq:,.0f} | trades {len(trades)} (rebalances {out_a['n_rebalances']}, brake moves {out_a['n_brake_moves']})")
print("   avg weights:", out_a["avg_weights"])

# ── B) 1,000-path bootstrap on the champion mechanics ───────────────────────
j0 = next(i for i, d in enumerate(days) if d >= "2015-10-13")
rmat = []
for i in range(j0, len(days)):
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
print(f"B) bootstrap pool: {rmat.shape[0]} all-8 days (2015-10+)")

rng = np.random.default_rng(20260717)
T, NB = 504, 1000
w_eq = np.full(n, 1.0 / n)
finals, calls, min_eqs = [], 0, []
for b in range(NB):
    rows = []
    while len(rows) < T:
        st = rng.integers(0, rmat.shape[0])
        ln = min(int(rng.geometric(1 / 21)), T - len(rows), rmat.shape[0] - st)
        rows.extend(range(st, st + max(ln, 1)))
    path = rmat[rows[:T]]
    eqb, peakb, prev_g, called = INIT, INIT, 0.0, False
    min_eq = INIT
    r_hist = []
    for t in range(T):
        if t % 21 == 0:
            eqb += MONTHLY
        r_dir = float(w_eq @ path[t])
        r_hist.append(r_dir)
        vol20 = np.std(r_hist[-21:], ddof=1) * math.sqrt(252) if len(r_hist) > 5 else TV
        trend_ok = np.prod(1 + np.array(r_hist[-21 * TM:])) >= 1 if len(r_hist) > 21 else True
        ddb = eqb / peakb - 1
        g = min(D.MAX_GROSS, max(MG, TV / max(vol20, 1e-6)))
        if not trend_ok:
            g = min(g, MG)
        if ddb < -BK:
            over = min(1.0, (abs(ddb) - BK) / BK)
            g = min(g, MG + (1.0 - over) * max(0.0, 1.0 - MG))
        if eqb < D.MARGIN_MIN:
            g = min(g, 1.0)
        carry = (-(prev_g - 1) * 0.045 / 252) if prev_g > 1 else ((1 - prev_g) * RF / 252)
        port_r = prev_g * r_dir + carry - D.TC * abs(g - prev_g)
        if prev_g > 1 and (1 + port_r - 0.25 * prev_g * (1 + port_r)) < 0:
            called = True
        eqb = max(eqb * (1 + port_r), 0.0)
        peakb = max(peakb, eqb)
        min_eq = min(min_eq, eqb)
        prev_g = g
    finals.append(eqb)
    min_eqs.append(min_eq)
    calls += called
finals = np.array(finals)
paid = INIT + MONTHLY * (T // 21)
out_b = {"paths": NB, "paid_in": paid,
         "margin_calls": int(calls),
         "p_loss": float(np.mean(finals < paid)),
         "p_below_1k": float(np.mean(finals < 1000)),
         "median": float(np.median(finals)), "p5": float(np.percentile(finals, 5)),
         "p95": float(np.percentile(finals, 95)), "worst": float(finals.min()),
         "best": float(finals.max())}
json.dump(out_b, open(HERE / "champion_boot.json", "w"), indent=1)
print(f"B) 1,000 paths ($%.0f paid in): calls %d | P(loss) %.1f%% | P(<$1k) %.1f%% | median $%.0f | p5 $%.0f | worst $%.0f | best $%.0f"
      % (paid, calls, out_b['p_loss']*100, out_b['p_below_1k']*100, out_b['median'], out_b['p5'], out_b['worst'], out_b['best']))
