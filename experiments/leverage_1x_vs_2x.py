"""1x (protected, unlevered) vs 2x (levered) champion, $2k + $20/mo, 2000->now.
Isolates exactly what enabling margin buys and costs."""
import math, sys
from pathlib import Path
import numpy as np
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import leverage_daily_overlay as D
import leverage_brake_to_cash as DB

D.UNIVERSE = ["SPY","QQQ","IWM","EFA","TLT","GLD","XMMO","SPMO"]
days, px = D.build_panel()

def run(maxg):
    D.MAX_GROSS = maxg
    return DB.run_daily_cash(days, px, 0.35, 6, 0.30, 0.0, init_cash=2000.0)

def ci(sh,T):
    s=sh/math.sqrt(252); se=math.sqrt((1+s*s/2)/T)*math.sqrt(252); return sh-1.96*se, sh+1.96*se

for label, mg in [("1x protected (brake, NO leverage)",1.0),("2x champion (brake + margin)",2.0)]:
    r = run(mg)
    lo,hi = ci(r["sharpe"], len(r["rets"]))
    print(f"{label:38} final ${r['final']:>9,.0f}  Sharpe {r['sharpe']:.2f} [{lo:.2f},{hi:.2f}]  maxDD {r['maxdd']*100:>4.0f}%  avgGross {r['avg_gross']:.2f}")

# margin-call + interest math on the CURRENT live book
eq = 91711.24
for maint, name in [(0.25,"Reg-T 25%"),(0.30,"house 30%")]:
    mv = 2*eq; debit = eq
    # call when (1-f)*mv - debit < maint*(1-f)*mv  ->  f > 1 - debit/((1-maint)*mv)
    f = 1 - debit/((1-maint)*mv)
    print(f"2x on ${eq:,.0f}: positions ${mv:,.0f}, borrow ${debit:,.0f} | margin call at ~{f*100:.0f}% drop ({name})")
for rate,name in [(0.058,"IBKR ~T-bill+150bp (backtest assumption)"),(0.11,"typical retail broker")]:
    print(f"  interest on ${eq:,.0f} borrowed @ {rate*100:.1f}% = ${eq*rate:,.0f}/yr ({name})")
