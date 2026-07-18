"""Crisis bootstrap for the deeper brake (cash floor 0): 1,000 x 2y, $25k start."""
import math
import sys
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import leverage_daily_overlay as D

days, px = D.build_panel()
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

tv, tm, bk, mg = 0.35, 6, 0.30, 0.0
rng = np.random.default_rng(20260715)
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
        g = min(D.MAX_GROSS, max(mg, tv / max(vol20, 1e-6)))
        if not trend_ok:
            g = min(g, mg)
        if dd < -bk:
            over = min(1.0, (abs(dd) - bk) / bk)
            g = min(g, mg + (1.0 - over) * max(0.0, 1.0 - mg))
        carry = (-(prev_g - 1) * 0.045 / 252) if prev_g > 1 else ((1 - prev_g) * 0.03 / 252)
        port_r = prev_g * r_dir + carry - D.TC * abs(g - prev_g)
        if prev_g > 1 and (1 + port_r - 0.25 * prev_g * (1 + port_r)) < 0:
            called = True
        eq = max(eq * (1 + port_r), 0.0)
        peak = max(peak, eq)
        prev_g = g
    finals.append(eq)
    calls += called
finals = np.array(finals)
print(f"DEEPER-BRAKE STRESS: calls {calls}/1000 | P(final<$10k) {np.mean(finals<10000)*100:.1f}% | "
      f"median ${np.median(finals):,.0f} | p5 ${np.percentile(finals,5):,.0f} | min ${finals.min():,.0f}")
