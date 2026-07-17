"""Streaming-brake evidence: does an HOURLY brake beat the DAILY brake, or does
whipsaw eat the benefit?

Extends the ADR-0028 Phase-2 brake-to-cash overlay (experiments/
leverage_brake_to_cash.py on claude/trader-portfolio-advisor):
    gross in [0, 2x] = clamp(0.35 / vol20, 0, 2)
                       x trendGate(6mo; down -> cash floor 0)
                       x ddBrake(30%; taper 1x -> 0 as dd runs 30% -> 60%)
    cash side EARNS the T-bill rate; borrowing (gross > 1) PAYS T-bill + 150bp;
    2bp per unit turnover.

Three variants over the SAME hourly panel (requested range=730d; Yahoo returns
730 TRADING days ~ 2.9 calendar years — kept, more evidence), $25,000 start,
no deposits,
monthly shrunk-tangency direction from daily closes (identical across variants —
ONLY the brake cadence differs):
  a) daily  — signals + gross recomputed at the last bar of each trading day,
              applied from the first bar of the next day;
  b) hourly — signals + gross recomputed every bar (vol from trailing ~140
              hourly returns annualized x sqrt(252*6.5), trend from the daily
              series, drawdown from live hourly equity), applied next bar;
  c) static — constant 2x, no brake (control).
Same costs for all: funding/cash carry pro-rated per bar, 2bp turnover — the
hourly brake pays its real whipsaw bill.

KNOWN DATA TRAP (repo memory: yahoo-intraday-stale-wick-glitch): Yahoo hourly
equity bars contain corrupt stale wicks. Per-side clamp: an hourly |log return|
> 4x the trailing rolling median absolute hourly move that FULLY REVERTS on the
next bar is repaired to the previous close (counted + printed). Genuine gaps /
crashes do not revert and are left alone.

HONESTY: ~2-3 years is far too short for Sharpe CIs to mean much — Lo-CIs are
printed anyway and they are wide. Conclusions are about MECHANISM (response
latency vs whipsaw cost), not expected returns. Hourly closes are UNADJUSTED (dividends appear as small
overnight drops, identically for all three variants).

Run via a network-capable shell (the Bash sandbox has no egress):
    python experiments/brake_intraday_evidence.py
Optional env: BRAKE_INTRADAY_CACHE=<path.json> (raw fetch cache),
              BRAKE_REFRESH=1 (ignore cache).
"""
import json
import math
import os
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent

UNIVERSE = ["SPY", "QQQ", "IWM", "EFA", "TLT", "GLD", "XMMO", "SPMO"]
START_EQ = 25000.0
RF = 0.03            # flat T-bill base (matches the daily engine's irx_flat)
BORROW_SPREAD = 0.015
TC = 0.0002          # 2bp per unit turnover
MAX_GROSS = 2.0
MIN_GROSS = 0.0      # brake-to-cash: floor is T-bills, not 1x
TV = 0.35            # vol target (ADR-0028 winning aggressive config)
TREND_D = 126        # 6-month trend gate, trading days
BRAKE = 0.30         # drawdown brake threshold
MARGIN_MIN = 2000.0
VOL_D_WIN = 20       # daily-vol lookback (days)
VOL_H_WIN = 140      # hourly-vol lookback (~20 days x 7 bars)
HOURS_PER_YEAR = 252 * 6.5   # annualization for the hourly vol estimator (spec)
WARMUP_DAYS = 130    # trend gate needs 126 trailing daily closes

CACHE = Path(os.environ.get(
    "BRAKE_INTRADAY_CACHE",
    str(Path(tempfile.gettempdir()) / "brake_intraday_cache.json")))


# ── data ────────────────────────────────────────────────────────────────────

def fetch_hourly(sym):
    last_err = None
    for rng in ("730d", "728d", "2y"):
        url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
               f"?interval=1h&range={rng}")
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (UnisonaSim)"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                j = json.load(r)
            res = j["chart"]["result"][0]
            ts = res["timestamp"]
            close = res["indicators"]["quote"][0]["close"]
            pairs = [(t, float(c)) for t, c in zip(ts, close) if c is not None]
            return [p[0] for p in pairs], [p[1] for p in pairs]
        except Exception as e:  # noqa: BLE001 — retry with the next range string
            last_err = e
            time.sleep(1.0)
    raise RuntimeError(f"fetch failed for {sym}: {last_err}")


def load_raw():
    if CACHE.exists() and os.environ.get("BRAKE_REFRESH") != "1":
        print(f"using cached fetch: {CACHE}")
        return json.loads(CACHE.read_text(encoding="utf-8"))
    raw = {}
    for s in UNIVERSE:
        ts, cl = fetch_hourly(s)
        raw[s] = {"ts": ts, "close": cl}
        print(f"  fetched {s}: {len(ts)} hourly bars")
        time.sleep(0.7)
    CACHE.write_text(json.dumps(raw), encoding="utf-8")
    return raw


def repair_wicks(ts, close, med_win=VOL_H_WIN, mult=4.0, revert_frac=0.30):
    """Per-side stale-wick clamp. A bar whose |log return| exceeds mult x the
    trailing rolling median absolute hourly move AND fully reverts next bar
    (two-bar net move < revert_frac of the spike) is repaired to the previous
    close. Genuine gaps/crashes don't revert -> untouched."""
    p = np.array(close, dtype=float)
    absr0 = np.abs(np.diff(np.log(p)))    # original moves, for the robust median
    repairs = []
    for b in range(1, len(p) - 1):        # candidate bar b; needs a next bar
        lo = max(0, b - 1 - med_win)
        if (b - 1) - lo < 30:
            continue
        med = float(np.median(absr0[lo:b - 1]))
        spike = abs(math.log(p[b] / p[b - 1]))   # LIVE spike (repairs cascade-safe)
        if med <= 0 or spike <= mult * med:
            continue
        net = abs(math.log(p[b + 1] / p[b - 1]))  # two-bar net move
        if net < revert_frac * spike:
            repairs.append((ts[b], float(p[b]), float(p[b - 1])))
            p[b] = p[b - 1]               # repair to previous close
    return p, repairs


def day_str(t):
    # UTC-5 date: NYSE regular session never crosses midnight UTC-5 in EST or
    # EDT, so this groups bars into trading days without tzdata.
    return datetime.fromtimestamp(t - 5 * 3600, tz=timezone.utc).strftime("%Y-%m-%d")


def build_panel():
    raw = load_raw()
    repaired, repair_log = {}, {}
    for s in UNIVERSE:
        p, reps = repair_wicks(raw[s]["ts"], raw[s]["close"])
        repaired[s] = dict(zip(raw[s]["ts"], p))
        repair_log[s] = reps
        print(f"  {s}: {len(reps)} stale-wick repairs")
    timeline = raw["SPY"]["ts"]
    n = len(timeline)
    px = np.full((len(UNIVERSE), n), np.nan)
    for k, s in enumerate(UNIVERSE):
        m = repaired[s]
        for i, t in enumerate(timeline):
            if t in m:
                px[k, i] = m[t]
        for i in range(1, n):             # forward-fill missing bars
            if np.isnan(px[k, i]) and not np.isnan(px[k, i - 1]):
                px[k, i] = px[k, i - 1]
    keep = ~np.isnan(px).any(axis=0)      # drop leading bars w/o full coverage
    px = px[:, keep]
    timeline = [t for t, k in zip(timeline, keep) if k]
    days = [day_str(t) for t in timeline]
    return timeline, days, px, repair_log


# ── direction (identical across variants) ───────────────────────────────────

def tangency_dir(mu, cov, n, cap=0.35, cov_shrink=0.35, mu_shrink=0.5):
    c = cov.copy()
    off = ~np.eye(n, dtype=bool)
    c[off] *= (1 - cov_shrink)
    m = mu_shrink * mu.mean() + (1 - mu_shrink) * mu
    try:
        w = np.linalg.solve(c + 1e-10 * np.eye(n), m)
    except np.linalg.LinAlgError:
        w = np.ones(n)
    w = np.clip(w, 0, None)
    if w.sum() <= 0:
        w = np.ones(n)
    w /= w.sum()
    capn = max(cap, 1 / n + 1e-9)
    for _ in range(20):
        over = w > capn + 1e-12
        if not over.any():
            break
        ex = (w[over] - capn).sum()
        w[over] = capn
        un = ~over
        w[un] += ex * (w[un] / w[un].sum() if w[un].sum() > 0 else 1 / max(un.sum(), 1))
    return w / w.sum()


# ── simulation ──────────────────────────────────────────────────────────────

def lo_ci(rets, bars_per_year):
    r = np.asarray(rets, dtype=float)
    T = r.size
    if T < 3 or r.std(ddof=1) <= 0:
        return 0.0, 0.0, 0.0
    srb = r.mean() / r.std(ddof=1)
    se = math.sqrt((1 + 0.5 * srb * srb) / T)     # Lo (2002) iid SE per bar
    f = math.sqrt(bars_per_year)
    return srb * f, (srb - 1.96 * se) * f, (srb + 1.96 * se) * f


def simulate(variant, timeline, days, px, day_keys, day_idx, last_bar_of_day,
             bars_in_day, dir_sched, i_start, daily_px, daily_lr, hourly_lr):
    """variant: 'daily' | 'hourly' | 'static'. Decisions at bar t take effect
    for bar t+1's return (applied next bar / next day)."""
    nsym, nbars = px.shape
    eq, peak_h, peak_dc = START_EQ, START_EQ, START_EQ
    w_dir = np.zeros(nsym)
    g = 0.0
    prev_expo = np.zeros(nsym)
    rets, eq_path, gross_path = [], np.full(nbars, np.nan), np.full(nbars, np.nan)
    turnover_sum = tc_sum = carry_sum = 0.0
    n_gross_changes = 0
    dc_eq = []                                     # daily-close equity marks

    def brake_gross(vol_ann, trend_ok, dd, equity):
        gg = min(MAX_GROSS, max(MIN_GROSS, TV / max(vol_ann, 1e-6)))
        if not trend_ok:
            gg = min(gg, MIN_GROSS)                # trend down -> cash floor
        if dd < -BRAKE:                            # taper 1x -> cash as dd 30->60%
            over = min(1.0, (abs(dd) - BRAKE) / BRAKE)
            gg = min(gg, MIN_GROSS + (1.0 - over) * (1.0 - MIN_GROSS))
        if equity < MARGIN_MIN:
            gg = min(gg, 1.0)
        return gg

    for t in range(i_start, nbars):
        d = days[t]
        j = day_idx[d]
        if t > i_start:
            r_bar = px[:, t] / px[:, t - 1] - 1.0
            port_r = float(prev_expo @ r_bar)
            pg = float(np.abs(prev_expo).sum())
            frac = 1.0 / (252.0 * bars_in_day[d])  # pro-rated per bar
            carry = (-(pg - 1.0) * (RF + BORROW_SPREAD) * frac if pg > 1.0
                     else (1.0 - pg) * RF * frac)
            eq_r = port_r + carry
            carry_sum += carry
            eq = max(eq * (1.0 + eq_r), 0.0)
        else:
            eq_r = 0.0
        peak_h = max(peak_h, eq)
        if t in dir_sched:
            w_dir = dir_sched[t]
        # ── decide next-bar gross ──
        prev_g = g
        if variant == "static":
            g = MAX_GROSS
        elif variant == "hourly":
            seg = hourly_lr[:, max(1, t - VOL_H_WIN + 1):t + 1]
            r_dir = w_dir @ seg
            vol = (float(np.std(r_dir, ddof=1)) * math.sqrt(HOURS_PER_YEAR)
                   if r_dir.size > 30 else TV)
            trend_ok = True
            if j >= TREND_D:
                ref = daily_px[:, j - TREND_D]
                trend_ok = float(w_dir @ (px[:, t] / ref)) >= 1.0
            dd = eq / peak_h - 1.0                 # live hourly equity
            g = brake_gross(vol, trend_ok, dd, eq)
        elif variant == "daily" and (t == last_bar_of_day[d] or t == i_start):
            seg = daily_lr[:, max(1, j - VOL_D_WIN + 1):j + 1]
            r_dir = w_dir @ seg
            vol = (float(np.std(r_dir, ddof=1)) * math.sqrt(252)
                   if r_dir.size > 5 else TV)
            trend_ok = True
            if j >= TREND_D:
                trend_ok = float(w_dir @ (daily_px[:, j] / daily_px[:, j - TREND_D])) >= 1.0
            peak_dc = max(peak_dc, eq)             # daily-close peak only
            dd = eq / peak_dc - 1.0
            g = brake_gross(vol, trend_ok, dd, eq)
        if abs(g - prev_g) > 1e-9:
            n_gross_changes += 1
        expo = w_dir * g
        dtv = float(np.abs(expo - prev_expo).sum())
        if dtv > 1e-12:
            tc = TC * dtv
            turnover_sum += dtv
            tc_sum += tc
            eq = max(eq * (1.0 - tc), 0.0)
            eq_r -= tc
        prev_expo = expo
        if t > i_start:
            rets.append(eq_r)
        eq_path[t] = eq
        gross_path[t] = g
        if t == last_bar_of_day[d]:
            dc_eq.append(eq)

    e = eq_path[i_start:]
    peaks = np.maximum.accumulate(np.maximum(e, 1e-9))
    maxdd_h = float(np.min(e / peaks - 1.0))
    dce = np.array(dc_eq)
    dpk = np.maximum.accumulate(np.maximum(dce, 1e-9))
    maxdd_dc = float(np.min(dce / dpk - 1.0))
    years = (timeline[-1] - timeline[i_start]) / (365.25 * 24 * 3600)
    bpy = len(rets) / years
    sr, lo, hi = lo_ci(rets, bpy)
    gp = gross_path[i_start:]
    return {
        "final": float(eq),
        "sharpe": sr, "sharpe_lo": lo, "sharpe_hi": hi,
        "maxdd_hourly": maxdd_h, "maxdd_dailyclose": maxdd_dc,
        "turnover_sum": turnover_sum, "tc_cost_frac": tc_sum,
        "carry_frac": carry_sum, "n_gross_changes": n_gross_changes,
        "avg_gross": float(np.nanmean(gp)),
        "pct_bars_below_1x": float(np.nanmean(gp < 0.99)),
        "bars_per_year": bpy, "n_bars": len(rets),
        "eq_path": eq_path, "gross_path": gross_path, "rets": np.array(rets),
    }


# ── main ────────────────────────────────────────────────────────────────────

def main():
    timeline, days, px, repair_log = build_panel()
    nsym, nbars = px.shape
    day_keys = sorted(set(days), key=days.index)
    day_idx = {d: j for j, d in enumerate(day_keys)}
    last_bar_of_day, bars_in_day = {}, {}
    for i, d in enumerate(days):
        last_bar_of_day[d] = i
        bars_in_day[d] = bars_in_day.get(d, 0) + 1
    daily_px = np.stack([[px[k, last_bar_of_day[d]] for d in day_keys]
                         for k in range(nsym)])
    daily_lr = np.zeros_like(daily_px)
    daily_lr[:, 1:] = np.diff(np.log(daily_px), axis=1)
    hourly_lr = np.zeros_like(px)
    hourly_lr[:, 1:] = np.diff(np.log(px), axis=1)
    total_repairs = sum(len(v) for v in repair_log.values())
    print(f"panel: {nbars} hourly bars, {len(day_keys)} trading days, "
          f"{days[0]} -> {days[-1]}; {total_repairs} stale-wick repairs")

    # monthly direction schedule from daily closes — identical for all variants
    dir_sched, first_bar_of_month = {}, {}
    for i, d in enumerate(days):
        if d[:7] not in first_bar_of_month:
            first_bar_of_month[d[:7]] = i
    i_start = None
    for mon, i in sorted(first_bar_of_month.items(), key=lambda kv: kv[1]):
        j = day_idx[days[i]]
        if j < 60:
            continue
        lb = max(0, j - 1260)
        R = daily_lr[:, lb + 1:j]                 # daily log rets before today
        mu = R.mean(axis=1) * 21
        cov = np.cov(R) * 21
        dir_sched[i] = tangency_dir(mu, np.atleast_2d(cov), nsym)
        if i_start is None and j >= WARMUP_DAYS:
            i_start = i
    print(f"sim start: {days[i_start]} (warm-up {day_idx[days[i_start]]} trading days); "
          f"{len(dir_sched)} monthly direction updates")

    common = (timeline, days, px, day_keys, day_idx, last_bar_of_day,
              bars_in_day, dir_sched, i_start, daily_px, daily_lr, hourly_lr)
    res = {v: simulate(v, *common) for v in ("daily", "hourly", "static")}

    for v in ("daily", "hourly", "static"):
        r = res[v]
        print(f"{v:>7}: final ${r['final']:,.0f}  sharpe {r['sharpe']:.2f} "
              f"[{r['sharpe_lo']:.2f},{r['sharpe_hi']:.2f}]  "
              f"maxDD(hourly) {r['maxdd_hourly']*100:.1f}%  "
              f"maxDD(daily-close) {r['maxdd_dailyclose']*100:.1f}%  "
              f"turnover {r['turnover_sum']:.1f}x  "
              f"grossChanges {r['n_gross_changes']}  avgGross {r['avg_gross']:.2f}")

    # ── worst single-day episode: response latency, in hours and dollars ────
    j_start = day_idx[days[i_start]]
    w_by_day = {}
    w = np.zeros(nsym)
    for i in range(i_start, nbars):
        if i in dir_sched:
            w = dir_sched[i]
        w_by_day[day_idx[days[i]]] = w.copy()
    worst_j, worst_r = None, 0.0
    for j in range(j_start + 2, len(day_keys)):
        rj = float(w_by_day.get(j, np.zeros(nsym)) @ (daily_px[:, j] / daily_px[:, j - 1] - 1.0))
        if rj < worst_r:
            worst_r, worst_j = rj, j
    W = day_keys[worst_j]
    spy_day = float(daily_px[0, worst_j] / daily_px[0, worst_j - 1] - 1.0)
    bars_W = [i for i, d in enumerate(days) if d == W]
    ga, gb = res["daily"]["gross_path"], res["hourly"]["gross_path"]
    # gross_path[t] is the DECISION made at bar t (in force from bar t+1), so
    # measure each variant against its own in-force gross at W's open, and
    # date the de-lever at the first bar that actually ran at reduced gross.
    i_open = bars_W[0]
    base_a, base_b = float(ga[i_open - 1]), float(gb[i_open - 1])
    cut_h = next((i for i in range(i_open, nbars) if gb[i] < base_b - 0.10), None)
    cut_a = next((i for i in range(i_open, nbars) if ga[i] < base_a - 0.10), None)
    eff_h = timeline[min(cut_h + 1, nbars - 1)] if cut_h is not None else None
    eff_a = timeline[min(cut_a + 1, nbars - 1)] if cut_a is not None else None
    hours_faster = ((eff_a - eff_h) / 3600.0
                    if eff_h is not None and eff_a is not None else None)
    bars_faster = (cut_a - cut_h
                   if cut_h is not None and cut_a is not None else None)
    # dollar difference over close(W-1) -> close(W+1), same starting dollars
    i0 = last_bar_of_day[day_keys[worst_j - 1]]
    i1 = last_bar_of_day[day_keys[min(worst_j + 1, len(day_keys) - 1)]]
    e0a = res["daily"]["eq_path"][i0]
    ra = res["daily"]["eq_path"][i1] / e0a - 1.0
    rb = res["hourly"]["eq_path"][i1] / res["hourly"]["eq_path"][i0] - 1.0
    dollar_diff = float((rb - ra) * e0a)
    print(f"worst day {W}: direction {worst_r*100:.2f}% (SPY {spy_day*100:.2f}%)")
    if hours_faster is not None:
        print(f"  hourly brake de-levered {hours_faster:.0f} wall-clock hours "
              f"({bars_faster} trading bars) before the daily brake; "
              f"episode P&L daily {ra*100:.2f}% vs hourly {rb*100:.2f}% "
              f"-> ${dollar_diff:+,.0f} on ${e0a:,.0f}")
    else:
        print(f"  de-lever timing: hourly cut bar {cut_h}, daily cut bar {cut_a} "
              f"(one side never cut >0.10 on this episode); "
              f"episode P&L daily {ra*100:.2f}% vs hourly {rb*100:.2f}% "
              f"-> ${dollar_diff:+,.0f} on ${e0a:,.0f}")

    # ── regime (measured, not asserted) ─────────────────────────────────────
    spy = daily_px[0, j_start:]
    spy_ret = float(spy[-1] / spy[0] - 1.0)
    spy_lr = np.diff(np.log(spy))
    spy_vol = float(np.std(spy_lr, ddof=1)) * math.sqrt(252)
    spy_pk = np.maximum.accumulate(spy)
    spy_dd = float(np.min(spy / spy_pk - 1.0))
    print(f"regime (sim window {day_keys[j_start]} -> {day_keys[-1]}): SPY "
          f"{spy_ret*100:+.1f}% total, {spy_vol*100:.0f}% ann vol, "
          f"maxDD {spy_dd*100:.1f}% — conclusions are about MECHANISM "
          f"(latency vs whipsaw), not expected returns")

    out = {
        "config": {"universe": UNIVERSE, "start_equity": START_EQ, "rf": RF,
                   "borrow_spread": BORROW_SPREAD, "tc": TC, "tv": TV,
                   "max_gross": MAX_GROSS, "min_gross": MIN_GROSS,
                   "trend_days": TREND_D, "brake": BRAKE,
                   "vol_win_daily": VOL_D_WIN, "vol_win_hourly": VOL_H_WIN,
                   "hourly_vol_annualization": "sqrt(252*6.5)"},
        "panel": {"bars": int(nbars), "trading_days": len(day_keys),
                  "first_day": days[0], "last_day": days[-1],
                  "sim_start_day": days[i_start],
                  "direction_updates": len(dir_sched)},
        "wick_repairs": {s: {"count": len(v),
                             "examples": [{"ts": r[0], "bad": r[1], "fixed": r[2]}
                                          for r in v[:3]]}
                         for s, v in repair_log.items()},
        "wick_repairs_total": total_repairs,
        "variants": {v: {k: r[k] for k in
                         ("final", "sharpe", "sharpe_lo", "sharpe_hi",
                          "maxdd_hourly", "maxdd_dailyclose", "turnover_sum",
                          "tc_cost_frac", "carry_frac", "n_gross_changes",
                          "avg_gross", "pct_bars_below_1x", "bars_per_year",
                          "n_bars")}
                     for v, r in res.items()},
        "worst_day_episode": {
            "day": W, "direction_return": worst_r, "spy_return": spy_day,
            "gross_in_force_at_open": {"daily": base_a, "hourly": base_b},
            "hourly_delever_effective_ts": eff_h,
            "daily_delever_effective_ts": eff_a,
            "hours_faster": hours_faster, "bars_faster": bars_faster,
            "note": "hours_faster is wall-clock and can span a weekend "
                    "(a Friday crash is the worst case FOR the daily brake: "
                    "it reacts at Monday's open); bars_faster counts hourly "
                    "trading bars.",
            "episode_pnl_daily": float(ra), "episode_pnl_hourly": float(rb),
            "dollar_diff_on_common_base": dollar_diff,
            "common_base_dollars": float(e0a)},
        "regime": {"window": [day_keys[j_start], day_keys[-1]],
                   "spy_total_return": spy_ret, "spy_ann_vol": spy_vol,
                   "spy_maxdd": spy_dd},
        "honesty": [
            f"{(timeline[-1] - timeline[i_start]) / (365.25 * 24 * 3600):.1f} "
            "simulated years after warm-up: Lo-CIs on Sharpe are wide and "
            "overlap heavily across variants — no return claim survives them.",
            "Conclusions are about MECHANISM: response latency vs whipsaw "
            "turnover, measured under identical direction and identical costs.",
            "Hourly closes are unadjusted (dividends appear as overnight "
            "drops) — identical treatment across variants.",
            "Exposure is held as a fraction of equity between decisions, i.e. "
            "implicit free intra-period rebalancing to constant weights; this "
            "slightly understates true turnover for ALL variants equally.",
            "The drawdown brake (30%) may never fire in this window; the "
            "vol-target and trend gate do the braking — regime-dependent."],
        "generated": datetime.now(timezone.utc).isoformat(),
    }
    (HERE / "brake_intraday_evidence.json").write_text(
        json.dumps(out, indent=1), encoding="utf-8")
    print("wrote experiments/brake_intraday_evidence.json")


if __name__ == "__main__":
    main()
