"""Could the 2x book avoid a margin call / the 2022 damage?

Static 2x (the ADR sim's book) vs a RISK-MANAGED 2x:
  - vol-targeted leverage: gross = min(2, 25%/yr / realized vol of the chosen
    direction over the trailing 6 months)
  - 10-month trend filter on the direction portfolio: negative -> gross capped at 1
  - same $2,000 margin-minimum gate, funding + borrow costs as the main sim

Outputs: full-period stats for both, then a DAILY 2022 drill-down — month-start
weights held within each month, exact intra-month equity path, and the Reg-T
maintenance cushion (equity - 25% long value - 30% short value).
"""
import json
import math
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import dca_walkforward_sim as S

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
OUT = Path(__file__).parent

TARGET_VOL_A = 0.25
MAX_GROSS = 2.0
MARGIN_MIN = 2000.0
BORROW_FEE_A = 0.005


def fetch_daily(sym, p1, p2):
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
           f"?interval=1d&period1={p1}&period2={p2}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (UnisonaSim)"})
    with urllib.request.urlopen(req, timeout=45) as r:
        j = json.load(r)
    res = j["chart"]["result"][0]
    ts = res["timestamp"]
    adj = res["indicators"]["adjclose"][0]["adjclose"]
    out = {}
    for t, a in zip(ts, adj):
        if a is None:
            continue
        out[datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%d")] = float(a)
    return out


def run_books():
    series = {s: S.fetch_monthly(s) for s in S.UNIVERSE}
    irx = {}
    try:
        irx = S.fetch_monthly("^IRX")
    except Exception:
        pass
    months = sorted(m for m in series["SPY"] if m >= S.START)
    max_vol_m = TARGET_VOL_A / math.sqrt(12)

    books = {"static": {"eq": 0.0, "w": None, "live": []},
             "managed": {"eq": 0.0, "w": None, "live": []}}
    contributed = 0.0
    log_rows = []

    for t in months:
        live, hist = [], []
        for s in S.UNIVERSE:
            if t not in series[s]:
                continue
            past = [m for m in sorted(series[s]) if m <= t]
            if len(past) >= S.MIN_OBS + 1:
                live.append(s)
                px_hist = [series[s][m] for m in past[-(S.WINDOW + 1):]]
                hist.append(np.diff(np.log(px_hist)))
        if not live:
            continue
        L = min(len(h) for h in hist)
        R = np.stack([h[-L:] for h in hist])
        mu = R.mean(axis=1)
        cov = np.atleast_2d(np.cov(R) if len(live) > 1 else np.array([[R.var()]]))

        # settle both books on last month's weights
        for name, bk in books.items():
            if bk["w"] is not None and bk["eq"] > 0:
                r_real, ok = [], True
                for s in bk["live"]:
                    past = [m for m in sorted(series[s]) if m <= t]
                    if len(past) < 2 or past[-1] != t:
                        ok = False
                        break
                    r_real.append(series[s][past[-1]] / series[s][past[-2]] - 1.0)
                if ok and len(r_real) == len(bk["w"]):
                    w = np.array(bk["w"])
                    gross = np.abs(w).sum()
                    short_gross = -w[w < 0].sum()
                    fund_a = (irx.get(t, 4.0) / 100.0) + 0.015
                    cost = max(0.0, gross - 1.0) * fund_a / 12 + short_gross * BORROW_FEE_A / 12
                    bk["eq"] *= 1.0 + float(w @ np.array(r_real)) - cost
                    bk["eq"] = max(0.0, bk["eq"])
            bk["eq"] += S.CONTRIB
        contributed += S.CONTRIB

        # choose next month's weights
        n = len(live)
        # direction at gross 1 (vol cap huge, gross cap 1)
        d = S.leveraged_max_return(mu, cov, n, max_vol_m=1e9, max_gross=1.0)
        d = np.array(d)
        # static book: same rule as the main sim
        if books["static"]["eq"] >= MARGIN_MIN:
            w_static = S.leveraged_max_return(mu, cov, n, max_vol_m, MAX_GROSS)
        else:
            w_static = S.max_return(mu, cov, n, max_vol_m)
        # managed book: vol-target + trend filter
        recent = R[:, -6:] if R.shape[1] >= 6 else R
        vol_hat = float(np.std(d @ recent, ddof=1)) * math.sqrt(12) if recent.shape[1] >= 3 else TARGET_VOL_A
        s_vol = min(MAX_GROSS, TARGET_VOL_A / max(vol_hat, 1e-6))
        trail = R[:, -10:] if R.shape[1] >= 10 else R
        trend = float(np.prod(1.0 + d @ trail)) - 1.0
        s_trend = MAX_GROSS if trend > 0 else 1.0
        gross_m = min(s_vol, s_trend)
        if books["managed"]["eq"] >= MARGIN_MIN:
            w_managed = list(d * gross_m)
        else:
            w_managed = S.max_return(mu, cov, n, max_vol_m)
        books["static"]["w"], books["static"]["live"] = list(w_static), list(live)
        books["managed"]["w"], books["managed"]["live"] = list(w_managed), list(live)

        log_rows.append({
            "m": t, "live": list(live), "contrib": contributed,
            "static_eq": books["static"]["eq"], "managed_eq": books["managed"]["eq"],
            "static_w": list(map(float, w_static)), "managed_w": list(map(float, w_managed)),
            "managed_gross": float(np.abs(np.array(w_managed)).sum()),
        })

    (OUT / "risk2022_books.json").write_text(json.dumps(log_rows), encoding="utf-8")
    return log_rows


def stats(vals, contribs):
    v = np.array(vals)
    rets = []
    for i in range(1, len(v)):
        if v[i-1] > 0:
            rets.append((v[i]-v[i-1])/v[i-1] - (contribs[i]-contribs[i-1])/v[i-1])
    rets = np.array(rets)
    sh = rets.mean()/rets.std(ddof=1)*math.sqrt(12)
    eq, peak, mdd = 1.0, 1.0, 0.0
    for r in rets:
        eq *= 1+r
        peak = max(peak, eq)
        mdd = min(mdd, eq/peak-1)
    return sh, mdd


def daily_2022(log_rows):
    p1 = int(datetime(2021, 11, 1, tzinfo=timezone.utc).timestamp())
    p2 = int(datetime(2023, 2, 1, tzinfo=timezone.utc).timestamp())
    daily = {s: fetch_daily(s, p1, p2) for s in S.UNIVERSE}
    months22 = [r for r in log_rows if "2021-12" <= r["m"] <= "2022-12"]
    out = {}
    for name, wkey in [("static", "static_w"), ("managed", "managed_w")]:
        min_cushion, worst_day, path = 1e9, 0.0, []
        for idx in range(len(months22) - 1):
            r0, r1 = months22[idx], months22[idx + 1]
            live, w = r0["live"], np.array(r0[wkey])
            days = sorted(dd for dd in daily["SPY"] if r0["m"] < dd[:7] <= r1["m"])
            start_px = {}
            for s in live:
                sd = [dd for dd in sorted(daily[s]) if dd[:7] == (r0["m"] if False else r0["m"])]
                # month-start price = last close of the weight-setting month
                sd = [dd for dd in sorted(daily[s]) if dd[:7] <= r0["m"]]
                start_px[s] = daily[s][sd[-1]] if sd else None
            if any(start_px[s] is None for s in live):
                continue
            for dd in days:
                if any(dd not in daily[s] for s in live):
                    continue
                R = np.array([daily[s][dd] / start_px[s] for s in live])
                eq_rel = 1.0 + float(w @ (R - 1.0))                       # equity / E0
                longv = float(np.sum(np.where(w > 0, w, 0) * R))          # / E0
                shortv = float(-np.sum(np.where(w < 0, w, 0) * R))        # / E0
                cushion = eq_rel - 0.25 * longv - 0.30 * shortv           # Reg-T maint.
                cushion_pct = cushion / max(longv + shortv, 1e-9)
                min_cushion = min(min_cushion, cushion_pct)
                worst_day = min(worst_day, eq_rel - 1.0)
                path.append((dd, eq_rel, cushion_pct))
        out[name] = {"min_cushion_pct": min_cushion, "worst_intramonth_equity_move": worst_day, "path": path}
    return out


def main():
    log_rows = run_books()
    contribs = [r["contrib"] for r in log_rows]
    for name in ("static", "managed"):
        sh, mdd = stats([r[f"{name}_eq"] for r in log_rows], contribs)
        final = log_rows[-1][f"{name}_eq"]
        print(f"{name:8} final ${final:,.0f}  sharpe {sh:.2f}  maxDD {mdd*100:.1f}%")
    y22 = [r for r in log_rows if r["m"].startswith("2022")]
    y21 = [r for r in log_rows if r["m"] == "2021-12"][0]
    for name in ("static", "managed"):
        v0 = y21[f"{name}_eq"]
        vals = [r[f"{name}_eq"] for r in y22]
        dep = 20 * len(vals)
        print(f"{name:8} 2022: start ${v0:,.0f} -> end ${vals[-1]:,.0f} (+${dep} deposits) "
              f"calendar change {100*(vals[-1]-dep-v0)/v0:.1f}%  trough ${min(vals):,.0f}")
    gr = [r["managed_gross"] for r in y22]
    print(f"managed gross through 2022: {', '.join(f'{g:.2f}' for g in gr)}")

    d22 = daily_2022(log_rows)
    for name in ("static", "managed"):
        r = d22[name]
        print(f"{name:8} 2022 daily: worst intra-month equity move {r['worst_intramonth_equity_move']*100:.1f}%  "
              f"min Reg-T maintenance cushion {r['min_cushion_pct']*100:.1f}% of gross (call if < 0)")
    (OUT / "risk2022_daily.json").write_text(json.dumps(
        {k: {"min_cushion_pct": v["min_cushion_pct"],
             "worst": v["worst_intramonth_equity_move"],
             "path": v["path"]} for k, v in d22.items()}), encoding="utf-8")


if __name__ == "__main__":
    main()
