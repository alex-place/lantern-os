"""Stress-test the brake overlay on DEEP history (S&P 1927+, Nasdaq 1971+).

The live overlay was tuned/validated on 2000-2026 ETF data — only ~2 US equity
bear markets in the tuning window. This ports the SAME overlay math to index
proxies that reach back to 1927, so the drawdown brake + trend gate + no-trade
band are exercised across 1929, 1937, 1973-74, 1987, 2000, 2008, 2020, 2022.

Overlay (per trading day), single risky asset + cash:
  gross_target = clamp(target_vol / realized_vol_20d, [min_gross, max_gross])
  if 6-mo trend of the asset < 0  -> gross = min_gross            (trend gate)
  if drawdown worse than `brake`  -> taper gross toward min_gross (brake-to-cash)
  no-trade band: hold yesterday's gross unless |target-prev| > band, EXCEPT a
     de-risking (gross-reducing) move is always honored (brake never delayed).
  cash (1-gross) earns RF/252; borrow (gross>1) pays (RF+1.5%)/252; 2bp/turnover.

Three books, all on the same path:
  buyhold      : always 100% invested (gross=1, no timing)
  leveraged    : max_gross=2.0  (the current live style — can borrow)
  no_margin    : max_gross=1.0  (NEVER borrows — only de-risks to cash; the
                 "non-risky" variant: zero margin risk by construction)

Honest accounting: turnover, trade_days (days the book actually rebalanced),
year-by-year worst drawdown, and per-crisis peak-to-trough. No deposits here —
lump-sum $25k at the start so books are comparable dollar-for-dollar. Nothing is
synthesised: prices come straight from deep_history.json (Yahoo adjclose).
"""
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
import deep_history_cache as C

RF = 0.03            # flat cash/funding base (matches the live overlay's irx_flat)
BORROW_SPREAD = 0.015
TC = 0.0002          # 2bp per unit turnover
INIT = 25000.0

# Named crises (peak-ish start -> trough-ish end) for per-regime attribution.
CRISES = [
    ("1929 Crash",      "1929-09-01", "1932-06-30"),
    ("1937 Recession",  "1937-03-01", "1938-03-31"),
    ("1973-74 Bear",    "1973-01-01", "1974-12-31"),
    ("1987 Black Mon",  "1987-08-01", "1987-12-31"),
    ("2000 Dot-com",    "2000-03-01", "2002-10-31"),
    ("2008 GFC",        "2007-10-01", "2009-03-31"),
    ("2020 COVID",      "2020-02-01", "2020-04-30"),
    ("2022 Rate shock", "2022-01-01", "2022-12-31"),
]


def load_asset(sym):
    data = C.build_cache()
    s = data["series"][sym]
    days = sorted(s)
    px = np.array([s[d] for d in days], dtype=float)
    return days, px


def run_overlay(days, px, tv, trend_m, brake, min_gross, max_gross, band,
                start=None, end=None):
    i0 = 0 if start is None else next(i for i, d in enumerate(days) if d >= start)
    i1 = len(days) if end is None else next((i for i, d in enumerate(days) if d >= end), len(days))
    eq, peak = INIT, INIT
    prev_g = 0.0
    rets, eq_path = [], []
    turnover_sum, trade_days = 0.0, 0
    gross_hist = []
    for i in range(i0, i1):
        d = days[i]
        if i == i0:
            eq_path.append((d, eq)); continue
        # realized 20d vol (annualized) of the asset
        lo = max(0, i - 21)
        seg = px[lo:i]
        r20 = np.diff(np.log(seg)) if seg.size > 2 else np.array([0.0])
        vol20 = float(np.std(r20, ddof=1)) * math.sqrt(252) if r20.size > 5 and np.std(r20) > 0 else tv
        # 6-mo trend gate
        lo_t = max(0, i - 21 * trend_m)
        trend_ok = px[i - 1] / px[lo_t] >= 1.0 if i - lo_t > 21 else True
        dd = eq / peak - 1.0
        g = min(max_gross, max(min_gross, tv / max(vol20, 1e-6)))
        if not trend_ok:
            g = min(g, min_gross)
        if dd < -brake:
            over = min(1.0, (abs(dd) - brake) / brake)
            g = min(g, min_gross + (1.0 - over) * max(0.0, 1.0 - min_gross))
        # no-trade band; always honor a de-risking move
        derisk = g < prev_g - 1e-12
        if band > 0 and abs(g - prev_g) <= band and not derisk:
            g = prev_g
        # today's P&L uses YESTERDAY's exposure (prev_g), set at prior close
        asset_r = px[i] / px[i - 1] - 1.0
        if prev_g > 1:
            carry = -(prev_g - 1.0) * (RF + BORROW_SPREAD) / 252
        else:
            carry = (1.0 - prev_g) * RF / 252
        moved = abs(g - prev_g)
        tc = TC * moved
        turnover_sum += moved
        if moved > 1e-12:
            trade_days += 1
        eq_r = prev_g * asset_r + carry - tc
        rets.append(eq_r)
        eq = max(eq * (1.0 + eq_r), 0.0)
        peak = max(peak, eq)
        prev_g = g
        gross_hist.append(g)
        eq_path.append((d, eq))
    r = np.array(rets)
    e = np.array([v for _, v in eq_path])
    peaks = np.maximum.accumulate(np.maximum(e, 1e-9))
    yrs = max((len(r)) / 252.0, 1e-9)
    sh = r.mean() / r.std(ddof=1) * math.sqrt(252) if r.size > 2 and r.std(ddof=1) > 0 else 0.0
    return {
        "final": eq, "cagr": (eq / INIT) ** (1 / yrs) - 1 if eq > 0 else -1.0,
        "sharpe": sh, "maxdd": float(np.min(e / peaks - 1.0)),
        "avg_gross": float(np.mean(gross_hist)) if gross_hist else 0.0,
        "pct_derisked": float(np.mean(np.array(gross_hist) < 0.99)) if gross_hist else 0.0,
        "turnover_per_yr": turnover_sum / yrs, "trade_days": trade_days,
        "trade_days_per_yr": trade_days / yrs, "years": yrs,
        "path": eq_path,
    }


def buyhold(days, px, start=None, end=None):
    return run_overlay(days, px, tv=0.0, trend_m=6, brake=9.9, min_gross=1.0,
                       max_gross=1.0, band=0.0, start=start, end=end)


def crisis_drawdown(days, px, book_fn, start, end):
    """peak-to-trough of the book's equity within [start,end]."""
    r = book_fn(start, end)
    e = np.array([v for _, v in r["path"]])
    if e.size < 2:
        return None
    peaks = np.maximum.accumulate(e)
    return float(np.min(e / peaks - 1.0))


def main():
    sym = sys.argv[1] if len(sys.argv) > 1 else "^GSPC"
    days, px = load_asset(sym)
    print(f"# {sym}: {days[0]} to {days[-1]}  ({len(days)} days)\n")

    # Config mirrors the live overlay's validated spec (tv .20, trend 6mo, brake 15%).
    tv, trend_m, brake, band = 0.20, 6, 0.15, 0.10
    books = {
        "buyhold":   dict(tv=0.0, min_gross=1.0, max_gross=1.0, band=0.0, brake=9.9),
        "leveraged": dict(tv=tv, min_gross=0.0, max_gross=2.0, band=band, brake=brake),
        "no_margin": dict(tv=tv, min_gross=0.0, max_gross=1.0, band=band, brake=brake),
    }
    results = {}
    print(f"{'book':<12}{'final':>14}{'cagr':>8}{'sharpe':>8}{'maxdd':>8}{'avgGross':>9}{'trades/yr':>10}")
    for name, cfg in books.items():
        r = run_overlay(days, px, trend_m=trend_m, **cfg)
        results[name] = {k: v for k, v in r.items() if k != "path"}
        print(f"{name:<12}{r['final']:>14,.0f}{r['cagr']*100:>7.1f}%{r['sharpe']:>8.2f}"
              f"{r['maxdd']*100:>7.0f}%{r['avg_gross']:>9.2f}{r['trade_days_per_yr']:>10.1f}")

    # Per-crisis peak-to-trough, each book.
    print(f"\n{'crisis':<18}{'buyhold':>10}{'leveraged':>11}{'no_margin':>11}")
    crisis_rows = {}
    for cname, cs, ce in CRISES:
        if days[0] > cs:
            continue
        row = {}
        for name, cfg in books.items():
            fn = lambda s, e, cfg=cfg: run_overlay(days, px, trend_m=trend_m, start=s, end=e, **cfg)
            dd = crisis_drawdown(days, px, fn, cs, ce)
            row[name] = dd
        crisis_rows[cname] = row
        print(f"{cname:<18}{row['buyhold']*100:>9.0f}%{row['leveraged']*100:>10.0f}%{row['no_margin']*100:>10.0f}%")

    out = {"symbol": sym, "range": [days[0], days[-1]], "n_days": len(days),
           "config": {"tv": tv, "trend_m": trend_m, "brake": brake, "band": band},
           "books": results, "crises": crisis_rows}
    (HERE / f"deep_overlay_{sym.strip('^=F').lower()}.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"\nwrote deep_overlay_{sym.strip('^=F').lower()}.json")


if __name__ == "__main__":
    main()
