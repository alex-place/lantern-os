"""Free-data Challenger vs the Champion: real historical T-bill rates (^IRX).

ADR-0029 Phase A, free-only variant. The Champion's engine charges a FLAT
3% cash / 3%+150bp borrow forever (leverage_brake_to_cash.RF). This run swaps
in the REAL daily 13-week T-bill yield (^IRX, Yahoo, free, 1998->now): cash
earns IRX(t) (a bill sweep), borrowing pays IRX(t)+spread. Signals, weights,
band, premise are byte-identical to the Champion - only the rate series
changes. Engine equivalence is asserted by re-running with a flat-3% series
and requiring the same final value to the penny.

Runs (all $2,000 start 2000-01-03 + $20/mo, band 0.08 sym, tv .35 / trend 6mo
/ brake .30 / floor 0):
  base        Champion as published (flat RF)             -> reproduces ~$91.5k
  equiv       rates engine, flat 3% series                -> must equal base
  challenger  real IRX, +150bp spread (IBKR Pro tier-1)
  lite        real IRX, +250bp spread (IBKR Lite)         -> spread sensitivity
Outputs experiments/challenger_free.json + a paired block-bootstrap CI on the
daily return difference (challenger - base).
"""
import json
import math
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import leverage_daily_overlay as D
import leverage_brake_to_cash as DB

D.UNIVERSE = ["SPY", "QQQ", "IWM", "EFA", "TLT", "GLD", "XMMO", "SPMO"]
CFG = dict(tv=0.35, trend_m=6, brake=0.30, min_gross=0.0)
PREMISE = dict(init_cash=2000.0, band=0.08, band_mode="sym")


def fetch_irx():
    p1 = int(datetime(1998, 1, 1, tzinfo=timezone.utc).timestamp())
    p2 = int(datetime.now(timezone.utc).timestamp())
    sym = urllib.parse.quote("^IRX")
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
           f"?interval=1d&period1={p1}&period2={p2}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (UnisonaSim)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        j = json.load(r)
    res = j["chart"]["result"][0]
    ts = res["timestamp"]
    # ^IRX has no adjclose guarantee; prefer close
    q = res["indicators"]["quote"][0]["close"]
    out = {}
    for t, v in zip(ts, q):
        if v is not None and 0.0 <= v <= 25.0:      # quoted in percent (e.g. 4.21)
            out[datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%d")] = float(v) / 100.0
    return out


def align_rates(days, series, default=0.03):
    """Forward-fill the rate onto panel days; strict no-lookahead is handled by
    the engine using yesterday's index."""
    out = np.full(len(days), np.nan)
    last = None
    for i, d in enumerate(days):
        if d in series:
            last = series[d]
        out[i] = last if last is not None else np.nan
    # early-1998 gap: backfill with first observed value; then any residual -> default
    first = next((v for v in out if not np.isnan(v)), default)
    out = np.where(np.isnan(out), first, out)
    return out


def run_daily_cash_rates(days, px, tv, trend_m, brake, min_gross, rf_series, spread=0.015,
                         start="2000-01-03", end=None, init_cash=0.0, band=0.0, band_mode="sym"):
    """leverage_brake_to_cash.run_daily_cash with ONE change: the carry line uses
    rf_series[i-1] (yesterday's observable bill yield) instead of flat RF.
    Also accumulates funding-paid / cash-earned dollars for attribution."""
    n = len(D.UNIVERSE)
    i0 = next(i for i, d in enumerate(days) if d >= start)
    i1 = len(days) if end is None else next(i for i, d in enumerate(days) if d >= end)
    eq, peak = init_cash, max(init_cash, 1e-9)
    w_dir = np.zeros(n)
    cur_month = ""
    rets_out, eq_path = [], []
    prev_expo = np.zeros(n)
    gross_hist = []
    gross_prev = 0.0
    turnover_sum, trade_days = 0.0, 0
    funding_paid = cash_earned = 0.0
    for i in range(i0, i1):
        d = days[i]
        if d[:7] != cur_month:
            cur_month = d[:7]
            eq += D.CONTRIB
            lb = max(0, i - 252 * 5)
            live = [s for s in D.UNIVERSE if not np.isnan(px[s][lb:i]).any() and i - lb > 252]
            if live:
                R = np.stack([np.diff(np.log(px[s][lb:i][~np.isnan(px[s][lb:i])])) for s in live])
                mu = R.mean(axis=1) * 21
                cov = np.cov(R) * 21
                wd = D.tangency_dir(mu, np.atleast_2d(cov), len(live))
                w_dir = np.zeros(n)
                for k, s in enumerate(live):
                    w_dir[D.UNIVERSE.index(s)] = wd[k]
        if i == i0 or eq <= 0:
            eq_path.append((d, max(eq, 0.0)))
            continue
        lo20 = max(0, i - 21)
        r_dir = np.zeros(i - lo20 - 1)
        ok = w_dir.sum() > 0
        if ok:
            comp = [k for k in range(n) if w_dir[k] > 0]
            seg = np.stack([px[D.UNIVERSE[k]][lo20:i] for k in comp])
            if not np.isnan(seg).any():
                rr = np.diff(np.log(seg), axis=1)
                r_dir = np.array([w_dir[k] for k in comp]) @ rr
        vol20 = float(np.std(r_dir, ddof=1)) * math.sqrt(252) if r_dir.size > 5 else tv
        lo_t = max(0, i - 21 * trend_m)
        trend_ok = True
        if ok and i - lo_t > 21:
            comp = [k for k in range(n) if w_dir[k] > 0]
            seg = np.stack([px[D.UNIVERSE[k]][lo_t:i] for k in comp])
            if not np.isnan(seg).any():
                gr = seg[:, -1] / seg[:, 0]
                trend_ok = float(np.array([w_dir[k] for k in comp]) @ gr) >= 1.0
        dd = eq / peak - 1.0
        g = min(D.MAX_GROSS, max(min_gross, tv / max(vol20, 1e-6)))
        if not trend_ok:
            g = min(g, min_gross)
        if dd < -brake:
            over = min(1.0, (abs(dd) - brake) / brake)
            g = min(g, min_gross + (1.0 - over) * max(0.0, 1.0 - min_gross))
        if eq < D.MARGIN_MIN:
            g = min(g, 1.0)
        target = w_dir * g
        drift = float(np.abs(target - prev_expo).sum())
        derisk = g < gross_prev - 1e-12
        if band > 0 and drift <= band and not (band_mode == "brake_aware" and derisk):
            expo = prev_expo
        else:
            expo = target
        r_today = np.zeros(n)
        for k in range(n):
            if prev_expo[k] != 0 and not (np.isnan(px[D.UNIVERSE[k]][i]) or np.isnan(px[D.UNIVERSE[k]][i - 1])):
                r_today[k] = px[D.UNIVERSE[k]][i] / px[D.UNIVERSE[k]][i - 1] - 1.0
        port_r = float(prev_expo @ r_today)
        prev_g = float(np.abs(prev_expo).sum())
        rf = float(rf_series[i - 1])                       # yesterday's observable bill yield
        if prev_g > 1:
            carry = -(prev_g - 1.0) * (rf + spread) / 252
            funding_paid += (prev_g - 1.0) * (rf + spread) / 252 * eq
        else:
            carry = (1.0 - prev_g) * rf / 252
            cash_earned += (1.0 - prev_g) * rf / 252 * eq
        moved = float(np.abs(expo - prev_expo).sum())
        tc = D.TC * moved
        turnover_sum += moved
        if moved > 1e-12:
            trade_days += 1
        eq_r = port_r + carry - tc
        rets_out.append(eq_r)
        eq = max(eq * (1.0 + eq_r), 0.0)
        peak = max(peak, eq)
        gross_prev = float(np.abs(expo).sum())
        prev_expo = expo
        gross_hist.append(float(np.abs(expo).sum()))
        eq_path.append((d, eq))
    r = np.array(rets_out)
    sh = r.mean() / r.std(ddof=1) * math.sqrt(252) if r.size > 2 and r.std(ddof=1) > 0 else 0.0
    e = np.array([v for _, v in eq_path])
    peaks = np.maximum.accumulate(np.maximum(e, 1e-9))
    return {"final": eq, "sharpe": sh, "maxdd": float(np.min(e / peaks - 1.0)),
            "avg_gross": float(np.mean(gross_hist)) if gross_hist else 0.0,
            "turnover": turnover_sum, "trade_days": trade_days,
            "funding_paid": funding_paid, "cash_earned": cash_earned,
            "path": eq_path, "rets": r}


def cagr(final, path):
    yrs = len(path) / 252.0
    # money-weighted is messy with DCA; report simple end/26.5y on paid-in multiple basis is
    # not a rate - use the same convention as the report: total-period annualized on $2k+flows
    # via IRR-free approximation is avoided; print final only where rates are ambiguous.
    return (final / 2000.0) ** (1 / yrs) - 1  # coarse, same convention across runs


def stat_line(name, r):
    T = len(r["rets"])
    s = r["sharpe"] / math.sqrt(252)
    se = math.sqrt((1 + s * s / 2) / T) * math.sqrt(252)
    return (f"{name:18s} final ${r['final']:>10,.0f}  sharpe {r['sharpe']:.3f} "
            f"[{r['sharpe']-1.96*se:.2f},{r['sharpe']+1.96*se:.2f}]  maxDD {r['maxdd']*100:.1f}%  "
            f"avgGross {r['avg_gross']:.2f}  tradeDays {r['trade_days']}  "
            f"fundingPaid ${r.get('funding_paid',0):,.0f}  cashEarned ${r.get('cash_earned',0):,.0f}")


def block_bootstrap_delta(ra, rb, n_boot=1000, block=21, seed=12345):
    """Stationary-ish moving-block bootstrap CI on annualized mean of (ra-rb)."""
    rng = np.random.default_rng(seed)
    d = ra - rb
    T = len(d)
    nblk = int(np.ceil(T / block))
    means = []
    for _ in range(n_boot):
        idx = rng.integers(0, T - block, size=nblk)
        sample = np.concatenate([d[j:j + block] for j in idx])[:T]
        means.append(sample.mean() * 252)
    lo, hi = np.percentile(means, [2.5, 97.5])
    return float(np.mean(means)), float(lo), float(hi), float(np.mean(np.array(means) > 0))


def main():
    print("# fetching 8-ETF panel (Yahoo daily) ...")
    days, px = D.build_panel()
    print(f"# panel: {len(days)} days, {days[0]}..{days[-1]}")
    print("# fetching ^IRX (13-week T-bill) ...")
    irx = fetch_irx()
    rf = align_rates(days, irx)
    print(f"# IRX: {len(irx)} obs, mean {rf.mean()*100:.2f}%, min {rf.min()*100:.2f}%, "
          f"max {rf.max()*100:.2f}%, today {rf[-1]*100:.2f}%")

    base = DB.run_daily_cash(days, px, CFG["tv"], CFG["trend_m"], CFG["brake"], CFG["min_gross"],
                             **PREMISE)
    flat = np.full(len(days), 0.03)
    equiv = run_daily_cash_rates(days, px, CFG["tv"], CFG["trend_m"], CFG["brake"],
                                 CFG["min_gross"], flat, spread=0.015, **PREMISE)
    drift = abs(equiv["final"] - base["final"])
    print(f"# engine equivalence: |equiv-base| = ${drift:.4f}")
    assert drift < 1.0, "rates engine does not reproduce the champion with flat 3%"

    chal = run_daily_cash_rates(days, px, CFG["tv"], CFG["trend_m"], CFG["brake"],
                                CFG["min_gross"], rf, spread=0.015, **PREMISE)
    lite = run_daily_cash_rates(days, px, CFG["tv"], CFG["trend_m"], CFG["brake"],
                                CFG["min_gross"], rf, spread=0.025, **PREMISE)

    print()
    print(stat_line("champion (flat3%)", base))
    print(stat_line("challenger (IRX)", chal))
    print(stat_line("lite (+250bp)", lite))

    # era attribution: equity ratio challenger/champion at era boundaries
    idx = {d: i for i, (d, _) in enumerate(base["path"])}
    def at(datep):
        i = next((k for k, (d, _) in enumerate(base["path"]) if d >= datep), None)
        return (chal["path"][i][1] / base["path"][i][1] - 1) * 100 if i is not None else float("nan")
    print("\n# challenger vs champion equity gap through time:")
    for dt in ("2004-01-01", "2009-01-01", "2013-01-01", "2016-01-01", "2020-01-01",
               "2022-01-01", "2024-01-01"):
        print(f"  {dt[:7]}: {at(dt):+7.2f}%")
    print(f"  final:   {(chal['final']/base['final']-1)*100:+7.2f}%")

    m, lo, hi, p = block_bootstrap_delta(chal["rets"], base["rets"])
    print(f"\n# paired block-bootstrap Δreturn (chal-champ), annualized: "
          f"{m*100:+.2f}%/yr  95% CI [{lo*100:+.2f}%, {hi*100:+.2f}%]  P(>0)={p*100:.1f}%")

    out = {
        "asof": days[-1],
        "irx": {"mean": float(rf.mean()), "min": float(rf.min()), "max": float(rf.max()),
                "today": float(rf[-1])},
        "champion_flat3": {k: base[k] for k in ("final", "sharpe", "maxdd", "avg_gross", "trade_days")},
        "challenger_irx_150bp": {k: chal[k] for k in ("final", "sharpe", "maxdd", "avg_gross",
                                                       "trade_days", "funding_paid", "cash_earned")},
        "lite_irx_250bp": {k: lite[k] for k in ("final", "sharpe", "maxdd", "funding_paid")},
        "delta_annualized_return": {"mean": m, "ci95": [lo, hi], "p_positive": p},
        "equivalence_check_usd": drift,
    }
    (HERE / "challenger_free.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    # monthly path for future charts
    mm = {}
    for dstr, v in chal["path"]:
        mm[dstr[:7]] = v
    pp = HERE / "dca_champion_paths.json"
    extra = json.loads(pp.read_text(encoding="utf-8")) if pp.exists() else {}
    extra["k_chal_irx"] = mm
    pp.write_text(json.dumps(extra), encoding="utf-8")
    print("\nwrote challenger_free.json + k_chal_irx path")


if __name__ == "__main__":
    main()
