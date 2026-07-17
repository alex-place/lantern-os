"""Champion vs no-brake vs SPY with $2,000 initial + $20/month, 2000->now."""
import json, math, sys
from pathlib import Path
import numpy as np
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import leverage_daily_overlay as D
import leverage_brake_to_cash as DB

INIT, MONTHLY = 2000.0, 20.0
D.UNIVERSE = ["SPY", "QQQ", "IWM", "EFA", "TLT", "GLD", "XMMO", "SPMO"]
days, px = D.build_panel()

def ci(sh, T):
    s = sh / math.sqrt(252); se = math.sqrt((1 + s*s/2)/T) * math.sqrt(252)
    return sh - 1.96*se, sh + 1.96*se

# 1) champion: momentum universe + brake-to-cash, $2k start
ch = DB.run_daily_cash(days, px, 0.35, 6, 0.30, 0.0, init_cash=INIT)
lo, hi = ci(ch["sharpe"], len(ch["rets"]))
print(f"champion: final ${ch['final']:,.0f} sharpe {ch['sharpe']:.2f} [{lo:.2f},{hi:.2f}] maxDD {ch['maxdd']*100:.0f}%")

# 2) SPY buy&hold + DCA, $2k start (same engine style)
i0 = next(i for i, d in enumerate(days) if d >= "2000-01-03")
spy_sh, cur, path_spy = 0.0, "", []
for i in range(i0, len(days)):
    ppx = px["SPY"][i]
    if np.isnan(ppx): continue
    if days[i][:7] != cur:
        cur = days[i][:7]
        add = INIT + MONTHLY if not path_spy else MONTHLY
        spy_sh += add / ppx
    path_spy.append((days[i], spy_sh * ppx))
e = np.array([v for _, v in path_spy])
peaks = np.maximum.accumulate(np.maximum(e, 1e-9))
print(f"SPY: final ${e[-1]:,.0f} maxDD {np.min(e/peaks-1)*100:.0f}%")

# 3) no-brake static-ish 2x (daily 2x tangency, funding, no overlay), $2k start
n = len(D.UNIVERSE)
eq, cur, w_dir, prev_expo = INIT, "", np.zeros(n), np.zeros(n)
path_nb = []
for i in range(i0, len(days)):
    d = days[i]
    if d[:7] != cur:
        cur = d[:7]
        eq += MONTHLY
        lb = max(0, i - 252*5)
        live = [s for s in D.UNIVERSE if not np.isnan(px[s][lb:i]).any() and i - lb > 252]
        if live:
            R = np.stack([np.diff(np.log(px[s][lb:i][~np.isnan(px[s][lb:i])])) for s in live])
            wd = D.tangency_dir(R.mean(axis=1)*21, np.atleast_2d(np.cov(R)*21), len(live))
            w_dir = np.zeros(n)
            for k, s in enumerate(live): w_dir[D.UNIVERSE.index(s)] = wd[k]
    if i == i0 or eq <= 0:
        path_nb.append((d, max(eq, 0.0))); continue
    r_today = np.zeros(n)
    for k in range(n):
        if prev_expo[k] != 0 and not (np.isnan(px[D.UNIVERSE[k]][i]) or np.isnan(px[D.UNIVERSE[k]][i-1])):
            r_today[k] = px[D.UNIVERSE[k]][i] / px[D.UNIVERSE[k]][i-1] - 1.0
    port_r = float(prev_expo @ r_today) - max(0.0, float(np.abs(prev_expo).sum()) - 1.0) * 0.045/252
    eq = max(eq * (1 + port_r), 0.0)
    prev_expo = w_dir * 2.0
    path_nb.append((d, eq))
e2 = np.array([v for _, v in path_nb])
pk2 = np.maximum.accumulate(np.maximum(e2, 1e-9))
print(f"no-brake 2x: final ${e2[-1]:,.0f} maxDD {np.min(e2/pk2-1)*100:.0f}%")

def monthly(path):
    m = {}
    for dstr, v in path: m[dstr[:7]] = v
    return m
extra = json.loads((HERE / "dca_champion_paths.json").read_text(encoding="utf-8"))
extra["k_champ"], extra["k_spy"], extra["k_nb"] = monthly(ch["path"]), monthly(path_spy), monthly(path_nb)
(HERE / "dca_champion_paths.json").write_text(json.dumps(extra), encoding="utf-8")
json.dump({"champion": {"final": ch["final"], "sharpe": ch["sharpe"], "maxdd": ch["maxdd"]},
           "spy": {"final": float(e[-1]), "maxdd": float(np.min(e/peaks-1))},
           "nobrake": {"final": float(e2[-1]), "maxdd": float(np.min(e2/pk2-1))}},
          open(HERE / "twok_start.json", "w"), indent=1)
print("wrote twok_start.json + paths")
