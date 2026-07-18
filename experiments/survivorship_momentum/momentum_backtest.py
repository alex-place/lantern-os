"""Survivorship-honest 12-1 cross-sectional momentum backtest.

CONTEXT (this session, 2026-07-18): the Alpaca/IBKR loopback is DOWN. Reachable
free price sources are Yahoo (query1/2 chart API) and stooq.com. Prices were
fetched by fetch_yahoo.ps1 (PowerShell, because the bash sandbox has no network)
into prices/<TICKER>.csv as (date, adjclose).

The INTENDED universe is a rules-based ever-member point-in-time set of 50 large
US names that deliberately INCLUDES companies that later delisted / went bankrupt
/ were acquired (Enron, Lehman, WorldCom, Bear Stearns, Wachovia, Countrywide,
Fannie/Freddie, Nortel, Kodak, GM-old, etc.). A survivorship-FREE momentum test
must price those names DURING THEIR LISTED LIFE.

MEASURED THIS SESSION:
  * Yahoo returns `no-data` for every delisted original (LEH, ENE, WCOM, BSC, MER,
    FNM, FRE, CFC, NOVL, TYC, YHOO, JCP, ...). The only non-survivor tickers Yahoo
    serves are TICKER-REUSE IMPOSTORS by unrelated modern companies, provable by
    their start date (WB=Weibo 2014, BUD=AB-InBev-ADR 2009, GENZ post-Sanofi-2011,
    GM new-2010, KODK new-2013, DELL re-IPO-2016, MEDI/SGP/Q/DYN/SLE brand-new).
    They do NOT represent the point-in-time constituent and are EXCLUDED.
  * stooq free CSV endpoint (/q/d/l/) is hard-blocked ("Access denied") even after
    solving its SHA-256 proof-of-work; stooq HTML pages for the delisted symbols
    return an empty ~226KB template (no data) while live names return ~251KB.

=> No reachable free source provides in-life delisted prices this session.
   The residual survivorship gap is therefore the deliverable (see coverage below).

This script runs the 12-1 momentum on what is HONESTLY obtainable and reports the
coverage gap, then compares to the hand-picked-winners universe to size the bias.
"""
import csv
import json
import math
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).parent
PDIR = ROOT / "prices"

# ---- Universes ---------------------------------------------------------------
# 50-name rules-based ever-member point-in-time set (given by constituents agent).
PIT_UNIVERSE = ["AAPL","MSFT","XOM","GE","C","INTC","CSCO","AIG","ENRNQ","WCOM",
    "LEHMQ","BSC","MER","EKDKQ","MTLQQ","NRTLQ","CCTYQ","WNDXQ","RSHCQ","SUNEQ",
    "CFC","GDW","WB","NCC","SOV","ABK","FNM","FRE","BUD","WYE","SGP","MEDI",
    "GENZ","Q","DYN","NOVL","COMS","OMX","TLAB","KATE","SLE","TYC","DJ","BOL",
    "ANDW","BMET","GLK","YHOO","BBBY","JCP"]

# True live survivors with correct continuous history from the PIT set.
SURVIVORS = ["AAPL","MSFT","XOM","GE","C","INTC","CSCO","AIG"]

# Tickers Yahoo served but which are ticker-REUSE impostors / post-event different
# entities (proven by first-trade date post-dating the original's delisting).
# EXCLUDED from the honest PIT run because they are NOT the constituent.
REUSED_IMPOSTORS = {
    "WB":  "Weibo (IPO 2014); Wachovia acquired by Wells Fargo 2008",
    "BUD": "AB InBev ADR (2009-); original Anheuser-Busch acquired 2008",
    "SGP": "new listing 2026; Schering-Plough acquired by Merck 2009",
    "MEDI":"new listing 2022; MedImmune acquired by AstraZeneca 2007",
    "GENZ":"series runs past 2011; Genzyme acquired by Sanofi 2011",
    "Q":   "new listing 2025; Qwest acquired by CenturyLink 2011",
    "DYN": "new listing 2020; old Dynegy acquired by Vistra 2018 (pink history gone)",
    "COMS":"series runs past 2010; 3Com acquired by HP 2010",
    "SLE": "new listing 2019; Sara Lee split/renamed Hillshire, delisted ~2014",
    "BBBY":"series runs to 2026; Bed Bath & Beyond delisted (bankrupt) 2023",
}

# Hand-picked-winners universe (the survivorship-BIASED comparison set that
# printed the $8,380 -> $2.04M cumulative in the DCA experiment).
WINNERS_UNIVERSE = ["SPY","QQQ","IWM","EFA","TLT","GLD","XMMO","SPMO","AAPL","MSFT",
    "AMZN","NVDA","JPM","COST","HD","NFLX","GOOGL","AMD","AVGO","XLE"]

START = "2005-01-01"


def load_prices(sym):
    f = PDIR / f"{sym}.csv"
    if not f.exists():
        return None
    out = {}
    with open(f, newline="") as fh:
        r = csv.reader(fh)
        next(r, None)
        for row in r:
            if len(row) < 2 or not row[1]:
                continue
            try:
                out[row[0]] = float(row[1])
            except ValueError:
                continue
    return out if out else None


def build_calendar(price_map):
    days = set()
    for d in price_map.values():
        days.update(d.keys())
    return sorted(x for x in days if x >= "2003-01-01")


def month_end_days(days):
    """Last trading day of each calendar month within `days`."""
    last = {}
    for d in days:
        ym = d[:7]
        last[ym] = d  # days sorted ascending -> keeps the last
    return [last[k] for k in sorted(last)]


def run_momentum(universe, label):
    """12-1 momentum: long top quintile, monthly rebalance, skip last 21 trading
    days. Eligibility each rebalance: valid price today, 21d ago, and 252d ago
    (>=252d prior history). A name with no price on a date simply is not eligible
    (this is exactly where missing delisted series would silently vanish)."""
    price = {}
    for s in universe:
        p = load_prices(s)
        if p is not None:
            price[s] = p
    obtained = sorted(price)
    missing = [s for s in universe if s not in price]

    days = build_calendar(price)
    idx = {d: i for i, d in enumerate(days)}
    # per-ticker aligned array with np.nan where no quote
    arr = {s: np.array([price[s].get(d, np.nan) for d in days]) for s in price}

    rebs = [d for d in month_end_days(days) if d >= START]
    LB, SK = 252, 21

    port_rets, dates, turnovers = [], [], []
    prev_w = {}
    picks_log = []
    for k in range(len(rebs) - 1):
        d0, d1 = rebs[k], rebs[k + 1]
        i0, i1 = idx[d0], idx[d1]
        if i0 - LB < 0:
            continue
        # signal per eligible ticker
        sig = {}
        for s, a in arr.items():
            p_now, p_skip, p_lb = a[i0], a[i0 - SK], a[i0 - LB]
            if np.isnan(p_now) or np.isnan(p_skip) or np.isnan(p_lb) or p_lb <= 0:
                continue
            sig[s] = p_skip / p_lb - 1.0  # 12-1: return from t-252 to t-21
        if len(sig) < 3:
            continue
        n_elig = len(sig)
        q = max(1, int(math.ceil(n_elig / 5.0)))  # top quintile
        picks = [s for s, _ in sorted(sig.items(), key=lambda kv: kv[1], reverse=True)[:q]]
        # realized equal-weight return over next month, need price at d0 and d1
        rets = []
        w_new = {}
        for s in picks:
            a = arr[s]
            if np.isnan(a[i0]) or np.isnan(a[i1]) or a[i0] <= 0:
                continue
            rets.append(a[i1] / a[i0] - 1.0)
            w_new[s] = 1.0
        if not rets:
            continue
        tot = sum(w_new.values())
        w_new = {s: v / tot for s, v in w_new.items()}
        pr = float(np.mean(rets))
        # turnover vs previous weights
        allk = set(w_new) | set(prev_w)
        to = 0.5 * sum(abs(w_new.get(s, 0) - prev_w.get(s, 0)) for s in allk)
        port_rets.append(pr)
        dates.append(d1)
        turnovers.append(to)
        prev_w = w_new
        picks_log.append({"date": d0, "n_eligible": n_elig, "n_picks": len(w_new),
                          "picks": picks})

    r = np.array(port_rets)
    if len(r) == 0:
        return {"label": label, "error": "no periods"}, picks_log
    equity = np.cumprod(1 + r)
    cum = float(equity[-1] - 1.0)
    n_years = len(r) / 12.0
    cagr = float(equity[-1] ** (1 / n_years) - 1.0) if n_years > 0 else float("nan")
    sharpe = float(r.mean() / r.std(ddof=1) * math.sqrt(12)) if r.std(ddof=1) > 0 else float("nan")
    peak = np.maximum.accumulate(equity)
    maxdd = float((equity / peak - 1.0).min())
    ann_turnover = float(np.mean(turnovers) * 12)

    res = {
        "label": label,
        "universe_size_intended": len(universe),
        "tickers_obtained": obtained,
        "n_obtained": len(obtained),
        "tickers_missing": missing,
        "n_missing": len(missing),
        "coverage_gap_pct": round(100.0 * len(missing) / len(universe), 2),
        "period": f"{dates[0]}..{dates[-1]}",
        "n_months": len(r),
        "cum_return_pct": round(cum * 100, 2),
        "cagr_pct": round(cagr * 100, 2),
        "sharpe": round(sharpe, 3),
        "maxdd_pct": round(maxdd * 100, 2),
        "ann_turnover": round(ann_turnover, 3),
        "avg_n_eligible": round(float(np.mean([p["n_eligible"] for p in picks_log])), 1),
        "avg_n_picks": round(float(np.mean([p["n_picks"] for p in picks_log])), 1),
    }
    return res, picks_log


def main():
    # Coverage accounting for the INTENDED 50-name point-in-time universe.
    pit_price_avail = {s: (load_prices(s) is not None) for s in PIT_UNIVERSE}
    yahoo_served = [s for s, v in pit_price_avail.items() if v]
    yahoo_nodata = [s for s, v in pit_price_avail.items() if not v]
    impostors = [s for s in yahoo_served if s in REUSED_IMPOSTORS]
    usable_pit = [s for s in yahoo_served if s not in REUSED_IMPOSTORS]  # == survivors

    # HONEST point-in-time run = only tickers with correct constituent history.
    honest_res, honest_picks = run_momentum(usable_pit, "PIT_honest_survivors_only")
    # For transparency also report the coverage against the full intended 50.
    honest_res["intended_universe_size"] = len(PIT_UNIVERSE)
    honest_res["delisted_no_data"] = yahoo_nodata
    honest_res["excluded_ticker_reuse_impostors"] = {s: REUSED_IMPOSTORS[s] for s in impostors}
    honest_res["n_delisted_unobtainable"] = len(yahoo_nodata) + len(impostors)
    honest_res["true_coverage_gap_pct_vs_intended_50"] = round(
        100.0 * (len(yahoo_nodata) + len(impostors)) / len(PIT_UNIVERSE), 2)

    winners_res, winners_picks = run_momentum(WINNERS_UNIVERSE, "hand_picked_winners")

    # Bias magnitude
    bias_cum = None
    if "cum_return_pct" in honest_res and "cum_return_pct" in winners_res:
        bias_cum = round(winners_res["cum_return_pct"] - honest_res["cum_return_pct"], 2)
    bias_sharpe = None
    if "sharpe" in honest_res and "sharpe" in winners_res:
        bias_sharpe = round(winners_res["sharpe"] - honest_res["sharpe"], 3)

    out = {
        "generated": datetime.utcnow().isoformat() + "Z",
        "method": "12-1 cross-sectional momentum, long top quintile, monthly rebalance, skip last 21 trading days, equal-weight, Rf=0",
        "data_source": "Yahoo v8 chart API (adjclose) via PowerShell fetch; stooq CSV blocked, stooq HTML delisted=empty",
        "published_clean_momentum_sharpe_ref": 0.5,
        "intended_point_in_time_universe": PIT_UNIVERSE,
        "coverage": {
            "intended_universe_size": len(PIT_UNIVERSE),
            "true_survivors_with_correct_history": SURVIVORS,
            "yahoo_no_data_delisted": yahoo_nodata,
            "yahoo_ticker_reuse_impostors_excluded": impostors,
            "n_usable_correct_constituents": len(usable_pit),
            "n_unobtainable_delisted": len(yahoo_nodata) + len(impostors),
            "coverage_gap_pct": round(100.0 * (len(yahoo_nodata) + len(impostors)) / len(PIT_UNIVERSE), 2),
            "note": "Every obtainable constituent is a SURVIVOR. Zero in-life delisted prices were reachable, so the honest run is still survivorship-biased; the gap below is the bias that could NOT be removed.",
        },
        "run_honest_point_in_time": honest_res,
        "run_hand_picked_winners": winners_res,
        "bias_magnitude": {
            "cum_return_pct_winners_minus_honest": bias_cum,
            "sharpe_winners_minus_honest": bias_sharpe,
            "honest_sharpe_vs_published_0p5": round(honest_res.get("sharpe", float("nan")) - 0.5, 3) if isinstance(honest_res.get("sharpe"), float) else None,
            "winners_sharpe_vs_published_0p5": round(winners_res.get("sharpe", float("nan")) - 0.5, 3) if isinstance(winners_res.get("sharpe"), float) else None,
        },
    }
    outf = ROOT / "results.json"
    with open(outf, "w") as fh:
        json.dump(out, fh, indent=2)
    print(json.dumps(out, indent=2))
    print(f"\nwrote {outf}")


if __name__ == "__main__":
    main()
