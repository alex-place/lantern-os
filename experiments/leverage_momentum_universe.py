"""Brake-to-cash with the momentum FUND added to the universe (XMMO, SPMO)."""
import json, math, sys
from pathlib import Path
import numpy as np
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import leverage_daily_overlay as D
import leverage_brake_to_cash as DB

D.UNIVERSE = ["SPY", "QQQ", "IWM", "EFA", "TLT", "GLD", "XMMO", "SPMO"]
days, px = D.build_panel()
tr = DB.run_daily_cash(days, px, 0.35, 6, 0.30, 0.0, start="2000-01-03", end="2013-01-01")
va = DB.run_daily_cash(days, px, 0.35, 6, 0.30, 0.0, start="2013-01-02")
fu = DB.run_daily_cash(days, px, 0.35, 6, 0.30, 0.0)
def ci(sh, T):
    s = sh / math.sqrt(252); se = math.sqrt((1 + s*s/2)/T) * math.sqrt(252)
    return sh - 1.96*se, sh + 1.96*se
for name, r in (("train", tr), ("valid", va), ("full", fu)):
    lo, hi = ci(r["sharpe"], len(r["rets"]))
    print(f"{name}: final ${r['final']:,.0f} sharpe {r['sharpe']:.2f} [{lo:.2f},{hi:.2f}] maxDD {r['maxdd']*100:.0f}% avgGross {r['avg_gross']:.2f}")
m = {}
for dstr, eqv in fu["path"]: m[dstr[:7]] = eqv
extra = json.loads((HERE / "leverage_momentum_paths.json").read_text(encoding="utf-8"))
extra["momu"] = m
(HERE / "leverage_momentum_paths.json").write_text(json.dumps(extra), encoding="utf-8")
json.dump({"full": {"final": fu["final"], "sharpe": fu["sharpe"], "maxdd": fu["maxdd"]},
           "validation": {"final": va["final"], "sharpe": va["sharpe"], "maxdd": va["maxdd"]}},
          open(HERE / "mom_universe.json", "w"), indent=1)
print("wrote mom_universe.json + path")
