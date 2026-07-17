"""PAPER micro-futures trend-following book — the breadth experiment (#2581).

The corpus's only evidenced route to higher Sharpe is futures breadth
(arXiv 2603.01820: Sharpe 2.4 OOS on ~50 futures markets, trend/momentum +
vol-scaled sizing). This measures honestly what a *retail-shaped* trend book
achieves on Yahoo continuous futures. Evidence only — NO product surface,
NO execution code.

Book design (classic time-series momentum, Moskowitz-Ooi-Pedersen shape):
- Monthly rebalance; per-market signal = sign of trailing 12-month return
  (3-month variant also computed).
- Position = signal x vol-parity risk budget: per-market vol target
  = portfolio_target / sqrt(N) using trailing 60-day vol.
- Portfolio vol target grid {0.10, 0.15, 0.20}/yr; gross exposure cap 2x.
- Long and short gross tracked separately (futures are symmetric).
- $20/month deposits like the sibling sims; 2bp transaction drag on turnover.
- Margin/funding: futures don't borrow cash — no funding cost applied, and
  collateral yield forgone ~ 0 (deposits sit as margin; T-bill yield on
  collateral is NOT credited, which is slightly conservative).

Discipline: tune (12m vs 3m, vol target) on TRAIN 2000-2012 Sharpe ONLY;
validate 2013+; report full-period with deposit-stripped Sharpe + Lo 95% CI
and the ADR-0028 verdict vs the Buffett bar (0.79). Compare SPY-only DCA in
the same engine. Crisis stress: 1,000 x 2y block-bootstrap paths from the
four crisis windows, start $25k.

CAVEATS (read before quoting numbers):
- Yahoo continuous-contract series have roll distortions (they are NOT
  consistently back-adjusted) — treat levels with suspicion; returns are
  approximate. Signals and P&L here inherit that noise.
- CME micro futures only exist since 2019; running this book for real needs
  roughly $10-25k of margin capital. Before 2019 a retail account could not
  have traded these sizes at all.
- This is a PAPER book. Execution would be IBKR CPAPI (creds currently stale).
- Data hygiene: isolated misprints (|log return| > 0.5 that fully reverts the
  next day, e.g. 6J=F 2001-12-17 printed 0.0008 vs 0.0079) are repaired to the
  previous price and COUNTED. Genuine crashes (CL Apr-2020) and roll gaps
  (NG quarter-ends +20-38%) are left untouched.
"""
import json
import math
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
OUT = Path(__file__).parent

UNIVERSE = ["ES=F", "NQ=F", "RTY=F", "YM=F",           # equity index
            "ZN=F", "ZB=F", "ZF=F",                    # rates
            "GC=F", "SI=F", "HG=F",                    # metals
            "CL=F", "NG=F",                            # energy
            "ZC=F", "ZS=F", "ZW=F",                    # grains
            "6E=F", "6J=F", "6B=F"]                    # FX
CONTRIB = 20.0
TC = 0.0002          # 2bp per unit turnover
MAX_GROSS = 2.0
MIN_HIST = 252       # a market enters the book once it has >= 252 days of data
VOL_FLOOR = 0.02
BAR = 0.79           # ADR-0028 Buffett bar


def fetch_daily(sym, p1_year=2000):
    p1 = int(datetime(p1_year, 1, 1, tzinfo=timezone.utc).timestamp())
    p2 = int(datetime.now(timezone.utc).timestamp())
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
           f"?interval=1d&period1={p1}&period2={p2}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (UnisonaSim)"})
    last_err = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                j = json.load(r)
            res = j["chart"]["result"][0]
            ts = res["timestamp"]
            ind = res["indicators"]
            closes = (ind.get("adjclose", [{}])[0].get("adjclose")
                      or ind["quote"][0]["close"])
            # keep strictly positive prices only (CL=F printed negative Apr-2020;
            # negative/zero levels break sign+log logic and are roll artifacts)
            return {datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%d"): float(c)
                    for t, c in zip(ts, closes) if c is not None and c > 0}
        except Exception as e:  # noqa: BLE001 — collect and retry
            last_err = e
            time.sleep(2.0 * (attempt + 1))
    raise RuntimeError(f"{sym}: {last_err}")


def build_panel(symbols):
    raw, failed = {}, []
    for s in symbols:
        try:
            series = fetch_daily(s)
            if len(series) < MIN_HIST:
                failed.append((s, f"only {len(series)} days"))
            else:
                raw[s] = series
        except Exception as e:  # noqa: BLE001
            failed.append((s, str(e)[:80]))
        time.sleep(0.4)
    syms = [s for s in symbols if s in raw]
    days = sorted(set().union(*[set(raw[s]) for s in syms]))
    px = {s: np.array([raw[s].get(d, np.nan) for d in days]) for s in syms}
    first, repaired = {}, {}
    for s in syms:
        v = px[s]
        idx = np.where(~np.isnan(v))[0]
        first[s] = int(idx[0])
        # repair isolated misprints: a huge move that fully reverts next obs
        # (e.g. 6J=F 2001-12-17: 0.0079 -> 0.0008 -> 0.0079). Genuine crashes
        # (CL Apr-2020) don't revert and are left alone.
        nrep = 0
        for j in range(1, len(idx) - 1):
            a, b, c = v[idx[j - 1]], v[idx[j]], v[idx[j + 1]]
            g = abs(math.log(b / a))
            if g > 0.5 and abs(math.log(c / a)) < 0.25 * g:
                v[idx[j]] = a
                nrep += 1
        if nrep:
            repaired[s] = nrep
            print(f"  data-hygiene: {s} repaired {nrep} isolated misprint(s)")
        for i in range(idx[0] + 1, len(v)):  # forward-fill once listed
            if np.isnan(v[i]):
                v[i] = v[i - 1]
    return days, px, syms, first, failed, repaired


def run_book(days, px, syms, first, lb_days, tv, start, end=None, deposits=True):
    """Monthly-rebalanced TSMOM book. Returns deposit-stripped daily rets."""
    n = len(syms)
    i0 = next(i for i, d in enumerate(days) if d >= start)
    i1 = len(days) if end is None else next(i for i, d in enumerate(days) if d >= end)
    eq = 0.0
    w = np.zeros(n)
    prev_w = np.zeros(n)
    cur_month = ""
    rets, eq_path = [], []
    lg_sum = sg_sum = n_reb = turn_sum = 0.0
    n_live_sum = 0
    for i in range(i0, i1):
        d = days[i]
        # 1) today's P&L on yesterday's weights
        tc = 0.0
        if i > i0:
            r_today = np.zeros(n)
            for k in range(n):
                if prev_w[k] != 0.0:
                    a, b = px[syms[k]][i - 1], px[syms[k]][i]
                    if not (np.isnan(a) or np.isnan(b)) and a > 0:
                        r_today[k] = b / a - 1.0
            port_r = float(prev_w @ r_today)
        else:
            port_r = 0.0
        # 2) monthly rebalance (uses data through i-1 only)
        if d[:7] != cur_month:
            cur_month = d[:7]
            if deposits:
                eq += CONTRIB
            new_w = np.zeros(n)
            live = [k for k in range(n)
                    if i - 1 - first[syms[k]] >= MIN_HIST and not np.isnan(px[syms[k]][i - 1])]
            if live:
                budget = tv / math.sqrt(len(live))
                for k in live:
                    v = px[syms[k]]
                    j_mom = i - 1 - lb_days
                    if j_mom < first[syms[k]] or np.isnan(v[j_mom]):
                        continue
                    mom = v[i - 1] / v[j_mom] - 1.0
                    seg = v[max(first[syms[k]], i - 61):i]
                    rr = np.diff(np.log(seg))
                    if rr.size < 20:
                        continue
                    sigma = max(float(np.std(rr, ddof=1)) * math.sqrt(252), VOL_FLOOR)
                    new_w[k] = (1.0 if mom >= 0 else -1.0) * budget / sigma
                gross = float(np.abs(new_w).sum())
                if gross > MAX_GROSS:
                    new_w *= MAX_GROSS / gross
            turn = float(np.abs(new_w - w).sum())
            tc = TC * turn
            turn_sum += turn
            w = new_w
            lg_sum += float(new_w[new_w > 0].sum())
            sg_sum += float(-new_w[new_w < 0].sum())
            n_reb += 1
            n_live_sum += len(live)
        # 3) book the day (no funding cost: futures margin, not borrowed cash)
        if i > i0 and eq > 0:
            eq_r = port_r - tc
            rets.append(eq_r)
            eq = max(eq * (1.0 + eq_r), 0.0)
        prev_w = w
        eq_path.append((d, eq))
    r = np.array(rets)
    sh = r.mean() / r.std(ddof=1) * math.sqrt(252) if r.size > 2 and r.std(ddof=1) > 0 else 0.0
    vol = float(r.std(ddof=1) * math.sqrt(252)) if r.size > 2 else 0.0
    e = np.array([v for _, v in eq_path])
    peaks = np.maximum.accumulate(np.maximum(e, 1e-9))
    mdd = float(np.min(e / peaks - 1.0))
    return {"final": eq, "sharpe": sh, "vol": vol, "maxdd": mdd, "rets": r,
            "avg_long_gross": lg_sum / max(n_reb, 1),
            "avg_short_gross": sg_sum / max(n_reb, 1),
            "avg_n_live": n_live_sum / max(n_reb, 1),
            "avg_monthly_turnover": turn_sum / max(n_reb, 1)}


def spy_dca(days, px_spy, start, end=None):
    """SPY-only DCA in the same engine: deposit-stripped Sharpe + final."""
    i0 = next(i for i, d in enumerate(days) if d >= start)
    i1 = len(days) if end is None else next(i for i, d in enumerate(days) if d >= end)
    shares, cur = 0.0, ""
    rets, last_eq = [], 0.0
    final = 0.0
    for i in range(i0, i1):
        p = px_spy[i]
        if np.isnan(p):
            continue
        if days[i][:7] != cur:
            cur = days[i][:7]
            shares += CONTRIB / p
            last_eq = 0.0  # deposit day: skip the jump, restart return chain
        eq = shares * p
        if last_eq > 0:
            rets.append(eq / last_eq - 1.0)
        last_eq = eq
        final = eq
    r = np.array(rets)
    sh = r.mean() / r.std(ddof=1) * math.sqrt(252) if r.size > 2 else 0.0
    return sh, final, r


def ci(sh, T):
    """Lo (2002) 95% CI for an annualized Sharpe from T daily observations."""
    s = sh / math.sqrt(252)
    se = math.sqrt((1 + s * s / 2) / T) * math.sqrt(252)
    return sh - 1.96 * se, sh + 1.96 * se


def verdict(sh, lo):
    if lo >= BAR:
        return "meets_ci"
    if sh >= BAR:
        return "meets_point"
    return "below"


def stress(days, px, syms, first, lb_days, tv, label):
    """1,000 x 2y block-bootstrap paths from the four crisis windows, $25k."""
    crises = [("2000-03-01", "2003-03-31"), ("2007-10-01", "2009-03-31"),
              ("2020-02-14", "2020-04-30"), ("2022-01-01", "2022-10-31")]
    cidx = [i for i, d in enumerate(days) if any(a <= d <= b for a, b in crises) and i > 0]
    # markets present for (almost) all crisis days, so the joint pool is dense
    pool = [s for s in syms
            if np.mean([not np.isnan(px[s][i - 1]) and not np.isnan(px[s][i])
                        for i in cidx]) >= 0.90]
    rmat = []
    for i in cidx:
        col, bad = [], False
        for s in pool:
            a, b = px[s][i - 1], px[s][i]
            if np.isnan(a) or np.isnan(b) or a <= 0:
                bad = True
                break
            col.append(b / a - 1.0)
        if not bad:
            rmat.append(col)
    rmat = np.array(rmat)
    m = len(pool)
    print(f"crisis pool: {rmat.shape[0]} joint days x {m} markets "
          f"({', '.join(pool)})")
    rng = np.random.default_rng(20260715)
    T, NB = 504, 1000
    finals = []
    for _b in range(NB):
        rows = []
        while len(rows) < T:
            st = rng.integers(0, rmat.shape[0])
            ln = min(int(rng.geometric(1 / 21)), T - len(rows), rmat.shape[0] - st)
            rows.extend(range(st, st + max(ln, 1)))
        path = rmat[rows[:T]]
        eq = 25000.0
        w = np.zeros(m)
        prev_w = np.zeros(m)
        for t in range(T):
            port_r = float(prev_w @ path[t])
            tc = 0.0
            if t % 21 == 0:  # monthly rebalance on synthetic history
                if t >= 63:
                    lb = min(lb_days, t)
                    hist = path[:t]
                    mom = np.prod(1 + hist[t - lb:t], axis=0) - 1.0
                    vol = np.maximum(hist[-60:].std(axis=0, ddof=1) * math.sqrt(252),
                                     VOL_FLOOR)
                    new_w = np.sign(mom + 1e-12) * (tv / math.sqrt(m)) / vol
                    gross = float(np.abs(new_w).sum())
                    if gross > MAX_GROSS:
                        new_w *= MAX_GROSS / gross
                else:
                    new_w = np.zeros(m)  # not enough synthetic history: flat
                tc = TC * float(np.abs(new_w - w).sum())
                w = new_w
            eq = max(eq * (1.0 + port_r - tc), 0.0)
            prev_w = w
        finals.append(eq)
    finals = np.array(finals)
    res = {"p_below_10k": float(np.mean(finals < 10000)),
           "median": float(np.median(finals)),
           "p5": float(np.percentile(finals, 5)),
           "worst": float(finals.min()),
           "pool_markets": pool, "pool_days": int(rmat.shape[0])}
    print(f"STRESS {label}: P(final<$10k) {res['p_below_10k']*100:.1f}% | "
          f"median ${res['median']:,.0f} | p5 ${res['p5']:,.0f} | worst ${res['worst']:,.0f}")
    return res


def main():
    days, px, syms, first, failed, repaired = build_panel(UNIVERSE)
    print(f"panel: {len(days)} days {days[0]} -> {days[-1]}")
    print(f"usable markets: {len(syms)}/{len(UNIVERSE)}")
    for s in syms:
        print(f"  {s:6s} data from {days[first[s]]}  "
              f"(book entry after {MIN_HIST}d ~ {days[min(first[s] + MIN_HIST, len(days) - 1)]})")
    if failed:
        print("EXCLUDED (fetch failed or too short):")
        for s, why in failed:
            print(f"  {s}: {why}")

    spy_px = None
    try:
        spy_raw = fetch_daily("SPY", p1_year=2000)
        spy_px = np.array([spy_raw.get(d, np.nan) for d in days])
        for i in range(1, len(spy_px)):
            if np.isnan(spy_px[i]) and not np.isnan(spy_px[i - 1]):
                spy_px[i] = spy_px[i - 1]
    except Exception as e:  # noqa: BLE001
        print(f"SPY fetch failed ({e}); benchmark comparison skipped")

    # ── train 2000-2012 ONLY: pick (lookback, vol target) on train Sharpe ────
    grid = [(lb, tv) for lb in (252, 63) for tv in (0.10, 0.15, 0.20)]
    rows = []
    for lb, tv in grid:
        tr = run_book(days, px, syms, first, lb, tv, "2000-01-03", "2013-01-01")
        rows.append(((lb, tv), tr["sharpe"], tr["final"]))
        print(f"  train lb={'12m' if lb == 252 else '3m':3s} tv={tv:.2f}: "
              f"sharpe {tr['sharpe']:5.2f} final ${tr['final']:,.0f}")
    rows.sort(key=lambda x: -x[1])
    best = rows[0][0]
    lb, tv = best
    lbl = "12m" if lb == 252 else "3m"
    print(f"BEST train config: lookback {lbl}, vol target {tv:.0%} "
          f"(train sharpe {rows[0][1]:.2f})")

    va = run_book(days, px, syms, first, lb, tv, "2013-01-02")
    fu = run_book(days, px, syms, first, lb, tv, "2000-01-03")
    va_lo, va_hi = ci(va["sharpe"], len(va["rets"]))
    fu_lo, fu_hi = ci(fu["sharpe"], len(fu["rets"]))

    spy = {}
    if spy_px is not None:
        s_sh_va, s_fin_va, s_r_va = spy_dca(days, spy_px, "2013-01-02")
        s_sh_fu, s_fin_fu, s_r_fu = spy_dca(days, spy_px, "2000-01-03")
        s_lo_fu, _ = ci(s_sh_fu, len(s_r_fu))
        spy = {"validation": {"sharpe": s_sh_va, "final": s_fin_va},
               "full": {"sharpe": s_sh_fu, "lo": s_lo_fu, "final": s_fin_fu,
                        "verdict": verdict(s_sh_fu, s_lo_fu)}}
        print(f"SPY DCA: validation sharpe {s_sh_va:.2f} final ${s_fin_va:,.0f} | "
              f"full sharpe {s_sh_fu:.2f} [{s_lo_fu:.2f},] final ${s_fin_fu:,.0f} "
              f"-> {verdict(s_sh_fu, s_lo_fu)}")

    print(f"TREND BOOK ({lbl}, tv {tv:.0%}):")
    print(f"  validation 2013+: sharpe {va['sharpe']:.2f} [{va_lo:.2f},{va_hi:.2f}] "
          f"-> {verdict(va['sharpe'], va_lo)} | final ${va['final']:,.0f} "
          f"maxDD {va['maxdd']*100:.0f}% realized vol {va['vol']:.1%}")
    print(f"  full 2000+:       sharpe {fu['sharpe']:.2f} [{fu_lo:.2f},{fu_hi:.2f}] "
          f"-> {verdict(fu['sharpe'], fu_lo)} | final ${fu['final']:,.0f} "
          f"maxDD {fu['maxdd']*100:.0f}% realized vol {fu['vol']:.1%}")
    print(f"  avg gross: long {fu['avg_long_gross']:.2f}x short {fu['avg_short_gross']:.2f}x "
          f"| avg live markets {fu['avg_n_live']:.1f} "
          f"| avg monthly turnover {fu['avg_monthly_turnover']:.2f}x")

    st = stress(days, px, syms, first, lb, tv, f"trend book ({lbl}, tv {tv:.0%})")

    print("CAVEATS: Yahoo continuous futures have roll distortions (not "
          "consistently back-adjusted) — levels suspect, returns approximate; "
          "CME micros only exist since 2019 and need ~$10-25k real scale; this "
          "is a paper book; execution would be IBKR CPAPI (creds stale).")

    json.dump({
        "issue": 2581, "bar": BAR,
        "universe_requested": UNIVERSE,
        "universe_usable": syms,
        "excluded": [{"symbol": s, "why": why} for s, why in failed],
        "misprints_repaired": repaired,
        "entry_dates": {s: days[first[s]] for s in syms},
        "best": {"lookback_days": lb, "lookback": lbl, "vol_target": tv},
        "train_grid": [{"lookback_days": c[0], "vol_target": c[1],
                        "train_sharpe": s, "train_final": f}
                       for c, s, f in rows],
        "validation": {"sharpe": va["sharpe"], "lo": va_lo, "hi": va_hi,
                       "final": va["final"], "maxdd": va["maxdd"],
                       "realized_vol": va["vol"],
                       "verdict": verdict(va["sharpe"], va_lo)},
        "full": {"sharpe": fu["sharpe"], "lo": fu_lo, "hi": fu_hi,
                 "final": fu["final"], "maxdd": fu["maxdd"],
                 "realized_vol": fu["vol"],
                 "avg_long_gross": fu["avg_long_gross"],
                 "avg_short_gross": fu["avg_short_gross"],
                 "avg_n_live": fu["avg_n_live"],
                 "avg_monthly_turnover": fu["avg_monthly_turnover"],
                 "verdict": verdict(fu["sharpe"], fu_lo)},
        "spy_dca": spy,
        "stress": st,
        "caveats": [
            "Yahoo continuous-contract series have roll distortions (not "
            "back-adjusted consistently) — treat levels with suspicion; "
            "returns are approximate.",
            "CME micro futures only exist since 2019; real execution at this "
            "shape needs ~$10-25k margin capital.",
            "Paper book only — no product surface, no execution code.",
            "Execution path would be IBKR CPAPI (creds currently stale).",
            "No funding cost applied (futures margin, not borrowed cash); "
            "collateral yield forgone ~ 0 — T-bill yield on margin is NOT "
            "credited, slightly conservative.",
            "Isolated misprints (huge move fully reverting next day) repaired "
            "to previous price and counted in misprints_repaired; genuine "
            "crashes and roll gaps left untouched.",
        ],
        "generated": datetime.now(timezone.utc).isoformat(),
    }, open(OUT / "microfutures_trend_book.json", "w"), indent=1)
    print(f"wrote {OUT / 'microfutures_trend_book.json'}")


if __name__ == "__main__":
    main()
