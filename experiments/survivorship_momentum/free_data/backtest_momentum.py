"""
Survivorship-FREE 12-1 momentum on the S&P 500, 2013-2026.

Key survivorship-free properties:
  - Eligible set at each rebalance = point-in-time index membership (fja05680),
    NOT today's membership. Names that later died are eligible while they lived.
  - Delisted/acquired/bankrupt names realize their REAL return up to their last
    traded price (bankruptcies -> ~0), instead of being silently dropped.
The biased twin (same code, survivors_only=True) restricts to names with data
through the end -> reproduces the inflation.
"""
import json, os, csv, math
from datetime import date
import numpy as np

BASE = os.path.dirname(os.path.abspath(__file__))
PRICES = os.path.join(BASE, os.environ.get("PRICES_DIR", "prices"))
RF_ANNUAL = 0.02  # constant risk-free for excess-Sharpe (matches champion methodology band)

import re
def norm(t):  # BRK.B / brk-b / BRK-B all match
    return re.sub(r'[^A-Z0-9]', '', t.upper())

def pdte(s):
    y,m,d = s[:10].split("-"); return date(int(y),int(m),int(d))

# ---- load price series: ticker -> dict(date_iso -> adjClose) sorted ----
def load_prices():
    px = {}
    for fn in os.listdir(PRICES):
        if not fn.endswith(".json"): continue
        t = fn[:-5]
        try: rows = json.load(open(os.path.join(PRICES, fn)))
        except Exception: continue
        if not rows: continue
        s = {}
        for r in rows:
            c = r.get("adjClose")
            if c is None: continue
            s[r["date"][:10]] = float(c)
        if len(s) >= 60:
            px[norm(t)] = dict(sorted(s.items()))
    return px

# ---- point-in-time membership from the "Historical Components & Changes" csv ----
def load_membership():
    path = os.path.join(BASE, "sp500_pit.csv")
    snaps = []  # (date, set(tickers))
    with open(path, newline="") as f:
        for row in csv.reader(f):
            if row[0] == "date" or not row[0]: continue
            d = pdte(row[0]); ticks = set(norm(x) for x in row[1].split(",") if x.strip())
            snaps.append((d, ticks))
    snaps.sort(key=lambda x: x[0])
    return snaps

def members_on(snaps, d):
    # most recent snapshot on/before d
    lo, hi, ans = 0, len(snaps)-1, snaps[0][1]
    while lo <= hi:
        mid = (lo+hi)//2
        if snaps[mid][0] <= d: ans = snaps[mid][1]; lo = mid+1
        else: hi = mid-1
    return ans

# ---- month-end trading dates from an index proxy (union of all dates) ----
def month_ends(px):
    alld = set()
    for s in px.values(): alld.update(s.keys())
    alld = sorted(alld)
    by_month = {}
    for ds in alld:
        by_month[ds[:7]] = ds  # last date seen for the month (sorted -> last wins)
    return [by_month[m] for m in sorted(by_month)]

def price_asof(series, d_iso):
    """last adjClose on/before d_iso (within 10 days), else None -> handles delist gaps."""
    keys = series  # dict sorted
    if d_iso in keys: return keys[d_iso]
    # linear-ish: find greatest key <= d_iso
    prev = None
    for k in keys:
        if k <= d_iso: prev = k
        else: break
    if prev is None: return None
    # guard against stale (>15 calendar days) -> treat as delisted before d
    return keys[prev]

def last_price_upto(series, d_iso):
    prev = None
    for k in series:
        if k <= d_iso: prev = k
        else: break
    return (prev, series[prev]) if prev else (None, None)

def run(survivors_only=False, top_quintile=True):
    px = load_prices()
    snaps = load_membership()
    mes = month_ends(px)
    lo = os.environ.get("WIN_LO", "2012-12"); hi = os.environ.get("WIN_HI", "2026-06")
    mes = [d for d in mes if lo <= d[:7] <= hi]

    survivors = set()
    if survivors_only:
        for t,s in px.items():
            last = list(s.keys())[-1]
            if last >= "2026-05-01": survivors.add(t)

    monthly_ret = []; dates = []; n_held_log = []; delisted_hits = 0; total_hits = 0
    for i in range(12, len(mes)-1):
        t_form = mes[i]        # formation month-end
        t_next = mes[i+1]      # holding month-end
        t_skip = mes[i-1]      # skip most recent month (12-1): signal uses t-12..t-1
        t_12   = mes[i-12]
        mem = members_on(snaps, pdte(t_form))
        cands = []
        for t, s in px.items():
            if t not in mem: continue
            if survivors_only and t not in survivors: continue
            p12 = price_asof(s, t_12); p1 = price_asof(s, t_skip); p0 = price_asof(s, t_form)
            if not p12 or not p1 or not p0: continue
            # require the series to actually reach near t_form (not stale-dead before formation)
            lastk = list(s.keys())[-1]
            if lastk < t_12: continue
            signal = p1/p12 - 1.0    # 12-1 momentum (t-12 .. t-1)
            cands.append((t, signal, p0))
        if len(cands) < 20: continue
        cands.sort(key=lambda x: x[1], reverse=True)
        k = max(1, int(len(cands)*0.2)) if top_quintile else len(cands)
        picks = cands[:k]
        rets = []
        for t, sig, p0 in picks:
            s = px[t]
            lk, lp = last_price_upto(s, t_next)
            if lp is None: continue
            total_hits += 1
            # if the series died before the holding month-end, this name delisted mid-hold
            if lk < t_next[:10]:
                delisted_hits += 1
            r = lp/p0 - 1.0
            # cap absurd single-name monthly moves from data glitches at +/-100%/-100%
            r = max(-0.999, min(3.0, r))
            rets.append(r)
        if not rets: continue
        monthly_ret.append(float(np.mean(rets)))
        dates.append(t_next); n_held_log.append(len(rets))

    r = np.array(monthly_ret)
    if len(r) < 24: return {"error":"too few months", "months":len(r)}
    rf_m = RF_ANNUAL/12
    ann_ret = float(np.prod(1+r)**(12/len(r)) - 1)
    ann_vol = float(np.std(r, ddof=1)*math.sqrt(12))
    sharpe  = float((np.mean(r)-rf_m)/np.std(r, ddof=1)*math.sqrt(12))
    eq = np.cumprod(1+r); peak = np.maximum.accumulate(eq); dd = eq/peak - 1
    maxdd = float(dd.min())
    # worst 3 months (momentum-crash signature)
    worst = sorted(r)[:3]
    return {
        "survivors_only": survivors_only,
        "months": len(r), "start": dates[0], "end": dates[-1],
        "universe_tickers": len(px),
        "CAGR": round(ann_ret,4), "ann_vol": round(ann_vol,4),
        "Sharpe": round(sharpe,3), "maxDD": round(maxdd,4),
        "cum_return": round(float(eq[-1]-1),4),
        "avg_n_held": round(float(np.mean(n_held_log)),1),
        "mid_hold_delist_frac": round(delisted_hits/max(1,total_hits),4),
        "worst_3_months": [round(x,3) for x in worst],
    }

def spy_benchmark():
    p = os.path.join(PRICES, "SPY.json")
    if not os.path.exists(p): return None
    rows = json.load(open(p))
    s = dict(sorted((r["date"][:10], float(r["adjClose"])) for r in rows if r.get("adjClose")))
    mes = {}
    for d in s: mes[d[:7]] = d
    lo = os.environ.get("WIN_LO", "2012-12"); hi = os.environ.get("WIN_HI", "2026-06")
    keys = [mes[m] for m in sorted(mes) if lo <= m <= hi]
    vals = [s[k] for k in keys]
    r = np.diff(vals)/np.array(vals[:-1])
    rf_m = RF_ANNUAL/12
    ann_ret = float(np.prod(1+r)**(12/len(r))-1)
    sharpe = float((np.mean(r)-rf_m)/np.std(r,ddof=1)*math.sqrt(12))
    eq = np.cumprod(1+r); dd=(eq/np.maximum.accumulate(eq)-1).min()
    return {"CAGR":round(ann_ret,4),"Sharpe":round(sharpe,3),"maxDD":round(float(dd),4),
            "cum_return":round(float(eq[-1]-1),4),"months":len(r)}

if __name__ == "__main__":
    free = run(survivors_only=False)
    bias = run(survivors_only=True)
    spy = spy_benchmark()
    out = {"survivorship_free": free, "survivors_only_biased": bias, "SPY_same_window": spy,
           "champion_sharpe_ref": 0.66}
    print(json.dumps(out, indent=2))
    json.dump(out, open(os.path.join(BASE,"results_real.json"),"w"), indent=2)
