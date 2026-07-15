"""
$20/month walk-forward DCA simulation, 2000-01 -> now.

Strategy = the unisona Advisor's math, run historically with NO look-ahead:
each month, compute the long-only capped shrunk-tangency target (w ~ S^-1 mu,
cov off-diag x0.65, mu 50% toward cross-sectional mean, cap 35%) from the
TRAILING <=60 monthly returns available at that date, then route that month's
$20 buy-only toward the most-underweight holdings (deficit fill), fractional
shares at the month's adjusted close. Universe: 6 liquid ETFs that ENTER the
sim only once they have >=36 months of history (SPY 1993, QQQ 1999, IWM 2000,
EFA 2001, TLT 2002, GLD 2004) -- no survivorship shortcut, the early years are
SPY-only because that's all that verifiably existed with history.

Benchmark: the same $20/month into SPY only.
Data: Yahoo monthly adjusted closes (dividends reinvested). $0 commissions,
fractional shares (IBKR-Lite-like). No taxes/slippage. Simulation != advice.
"""
import json
import math
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
OUT = Path(__file__).parent

UNIVERSE = ["SPY", "QQQ", "IWM", "EFA", "TLT", "GLD"]
START = "2000-01"
CONTRIB = 20.0
WINDOW = 60          # trailing months for mu/cov
MIN_OBS = 36         # months of history before an asset enters
MAX_W = 0.35
COV_SHRINK = 0.35
MU_SHRINK = 0.5


def fetch_monthly(sym):
    p1 = int(datetime(1993, 1, 1, tzinfo=timezone.utc).timestamp())
    p2 = int(datetime.now(timezone.utc).timestamp())
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
           f"?interval=1mo&period1={p1}&period2={p2}")
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
        ym = datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m")
        out[ym] = float(a)  # last obs per month wins (current partial month = latest)
    return out


def _project_capped_simplex(v, cap, n):
    """Euclidean projection onto {w: sum w = 1, 0 <= w_i <= cap} via tau-bisection."""
    lo, hi = v.min() - 1.0, v.max()
    for _ in range(60):
        tau = (lo + hi) / 2
        s = np.clip(v - tau, 0, cap).sum()
        if s > 1:
            lo = tau
        else:
            hi = tau
    return np.clip(v - (lo + hi) / 2, 0, cap)


def max_return(mu, cov, n, max_vol_monthly):
    """Maximize w.mu s.t. vol(w) <= cap, long-only, w_i <= MAX_W.

    Deterministic lambda-bisected projected gradient on the mean-variance
    family max w.mu - lam * w'Sigma w — traces the long-only efficient
    frontier; picks the lambda whose solution sits at the vol ceiling.
    Same shrinkage as tangency() so the two objectives share inputs.
    """
    cap = max(MAX_W, 1.0 / n + 1e-9)
    c = cov.copy()
    off = ~np.eye(n, dtype=bool)
    c[off] *= (1.0 - COV_SHRINK)
    m = MU_SHRINK * mu.mean() + (1.0 - MU_SHRINK) * mu

    def solve(lam):
        w = np.full(n, 1.0 / n)
        step = 0.5 / (1.0 + 2.0 * lam * np.abs(c).max() * n)
        for _ in range(400):
            w = _project_capped_simplex(w + step * (m - 2.0 * lam * (c @ w)), cap, n)
        return w

    def vol(w):
        return math.sqrt(max(w @ c @ w, 0.0))

    w0 = solve(0.0)                      # max-return corner (caps filled by mu rank)
    if vol(w0) <= max_vol_monthly:
        return w0
    lo, hi = 0.0, 1.0
    while vol(solve(hi)) > max_vol_monthly and hi < 1e6:
        hi *= 10
    for _ in range(30):
        mid = (lo + hi) / 2
        if vol(solve(mid)) > max_vol_monthly:
            lo = mid
        else:
            hi = mid
    return solve(hi)


def leveraged_max_return(mu, cov, n, max_vol_m, max_gross, pos_cap=0.75):
    """Max w.mu with shorts + leverage: two-fund separation — the optimal risky
    DIRECTION is the signed shrunk tangency S^-1 mu (box-clipped at +-pos_cap of
    gross); scale it until the vol ceiling or the gross-leverage cap binds.
    Returns weights of EQUITY (gross may exceed 1)."""
    c = cov.copy()
    off = ~np.eye(n, dtype=bool)
    c[off] *= (1.0 - COV_SHRINK)
    m = MU_SHRINK * mu.mean() + (1.0 - MU_SHRINK) * mu
    try:
        d = np.linalg.solve(c + 1e-10 * np.eye(n), m)
    except np.linalg.LinAlgError:
        d = np.ones(n)
    if np.abs(d).sum() <= 0 or d @ m <= 0:
        d = np.ones(n)
    d = d / np.abs(d).sum()                     # gross 1 direction
    d = np.clip(d, -pos_cap, pos_cap)           # per-book box
    g = np.abs(d).sum()
    d = d / g if g > 0 else np.ones(n) / n
    vol = math.sqrt(max(d @ c @ d, 1e-18))
    s = min(max_vol_m / vol, max_gross)          # lever to the binding constraint
    return d * s


def tangency(mu, cov, n):
    cap = max(MAX_W, 1.0 / n + 1e-9)
    c = cov.copy()
    off = ~np.eye(n, dtype=bool)
    c[off] *= (1.0 - COV_SHRINK)
    m = MU_SHRINK * mu.mean() + (1.0 - MU_SHRINK) * mu
    try:
        w = np.linalg.solve(c + 1e-10 * np.eye(n), m)
    except np.linalg.LinAlgError:
        w = np.ones(n)
    w = np.clip(w, 0, None)
    if w.sum() <= 0:
        w = np.ones(n)  # degenerate trailing window -> equal weight
    w = w / w.sum()
    for _ in range(20):  # iterative cap + renormalize (same shape as lib capWeights)
        over = w > cap + 1e-12
        if not over.any():
            break
        excess = (w[over] - cap).sum()
        w[over] = cap
        under = ~over
        if w[under].sum() > 0:
            w[under] += excess * w[under] / w[under].sum()
        else:
            w += excess / n
    return w / w.sum()


def main():
    series = {}
    for s in UNIVERSE:
        series[s] = fetch_monthly(s)
        print(f"fetched {s}: {len(series[s])} months ({min(series[s])} -> {max(series[s])})")

    try:  # 3-mo T-bill yield for margin funding (monthly, %); flat 4% if unavailable
        irx = fetch_monthly("^IRX")
    except Exception:
        irx = {}
    months = sorted(m for m in series["SPY"] if m >= START)
    MAX_VOL_M = 0.25 / math.sqrt(12)   # 25%/yr vol ceiling for the max-return books
    MAX_GROSS = 2.0                    # Reg-T overnight gross cap
    MARGIN_MIN = 2000.0                # Reg-T margin-account minimum equity
    BORROW_FEE_A = 0.005               # stock-loan fee on short notional (liquid ETFs)
    book_t = {s: 0.0 for s in UNIVERSE}   # tangency (max Sharpe)
    book_r = {s: 0.0 for s in UNIVERSE}   # max target return @ vol cap, long-only
    equity_l = 0.0                        # leveraged/short book (return-accounted)
    w_lev_prev, live_prev = None, []
    spy_shares = 0.0
    rows = []
    contributed = 0.0

    def buy_toward(book, w, live, px):
        value = sum(book[s] * px.get(s, 0) for s in live)
        new_total = value + CONTRIB
        deficit = {s: max(0.0, w[i] * new_total - book[s] * px[s]) for i, s in enumerate(live)}
        dsum = sum(deficit.values())
        if dsum >= CONTRIB:
            alloc = {s: CONTRIB * deficit[s] / dsum for s in live}
        else:
            alloc = {s: deficit[s] + (CONTRIB - dsum) * w[i] for i, s in enumerate(live)}
        for s, d in alloc.items():
            book[s] += d / px[s]

    for t in months:
        live, hist = [], []
        for s in UNIVERSE:
            if t not in series[s]:
                continue
            past = [m for m in sorted(series[s]) if m <= t]
            if len(past) >= MIN_OBS + 1:
                live.append(s)
                px_hist = [series[s][m] for m in past[-(WINDOW + 1):]]
                hist.append(np.diff(np.log(px_hist)))
        if not live:
            continue
        L = min(len(h) for h in hist)
        R = np.stack([h[-L:] for h in hist])
        mu = R.mean(axis=1)
        cov = np.atleast_2d(np.cov(R) if len(live) > 1 else np.array([[R.var()]]))
        px = {s: series[s][t] for s in live}

        buy_toward(book_t, tangency(mu, cov, len(live)), live, px)
        buy_toward(book_r, max_return(mu, cov, len(live), MAX_VOL_M), live, px)

        # ── leveraged book: settle last month, then set this month's weights ──
        if w_lev_prev is not None and equity_l > 0:
            r_real, ok = [], True
            for s in live_prev:
                past = [m for m in sorted(series[s]) if m <= t]
                if len(past) < 2 or past[-1] != t:
                    ok = False
                    break
                r_real.append(series[s][past[-1]] / series[s][past[-2]] - 1.0)
            if ok and len(r_real) == len(w_lev_prev):
                w = np.array(w_lev_prev)
                gross = np.abs(w).sum()
                short_gross = -w[w < 0].sum()
                fund_a = (irx.get(t, 4.0) / 100.0) + 0.015
                cost = max(0.0, gross - 1.0) * fund_a / 12 + short_gross * BORROW_FEE_A / 12
                equity_l *= 1.0 + float(w @ np.array(r_real)) - cost
                equity_l = max(0.0, equity_l)  # liquidation gate: wiped is wiped
        equity_l += CONTRIB
        if equity_l >= MARGIN_MIN:
            w_lev = leveraged_max_return(mu, cov, len(live), MAX_VOL_M, MAX_GROSS)
        else:  # below the margin minimum: no shorts, no leverage — long-only book
            w_lev = max_return(mu, cov, len(live), MAX_VOL_M)
        w_lev_prev, live_prev = list(w_lev), list(live)

        contributed += CONTRIB
        spy_shares += CONTRIB / series["SPY"][t]

        val_t = sum(book_t[s] * series[s][t] for s in UNIVERSE if t in series[s])
        val_r = sum(book_r[s] * series[s][t] for s in UNIVERSE if t in series[s])
        wts = {s: book_r[s] * series[s].get(t, 0) / val_r if val_r > 0 else 0 for s in UNIVERSE}
        rows.append({"m": t, "value": val_t, "maxret": val_r, "lev": equity_l,
                     "gross": float(np.abs(np.array(w_lev)).sum()),
                     "short": float(-np.array(w_lev)[np.array(w_lev) < 0].sum()),
                     "spy": spy_shares * series["SPY"][t],
                     "contrib": contributed, "w": wts})

    # ---- stats ------------------------------------------------------------
    def stats(vals, contribs):
        v = np.array(vals)
        rets = np.diff(v) / v[:-1] - np.diff(contribs) / v[:-1]  # strip the deposit
        sh = rets.mean() / rets.std(ddof=1) * math.sqrt(12) if rets.std(ddof=1) > 0 else 0
        eq, peak, mdd = 1.0, 1.0, 0.0
        for r in rets:
            eq *= 1 + r
            peak = max(peak, eq)
            mdd = min(mdd, eq / peak - 1)
        return sh, mdd

    def xirr(vals, n_months, final):
        # monthly IRR of -20 each month + final value, bisected, annualized
        lo, hi = -0.05, 0.05
        def npv(r):
            return sum(-CONTRIB * (1 + r) ** (n_months - i) for i in range(n_months)) + final
        for _ in range(200):
            mid = (lo + hi) / 2
            # npv is decreasing in r: positive npv means the root is above mid
            if npv(mid) > 0:
                lo = mid
            else:
                hi = mid
        return (1 + (lo + hi) / 2) ** 12 - 1

    contribs = np.array([r["contrib"] for r in rows])
    strat_sh, strat_dd = stats([r["value"] for r in rows], contribs)
    mr_sh, mr_dd = stats([r["maxret"] for r in rows], contribs)
    lev_sh, lev_dd = stats([r["lev"] for r in rows], contribs)
    spy_sh, spy_dd = stats([r["spy"] for r in rows], contribs)
    n = len(rows)
    result = {
        "months": n,
        "contributed": rows[-1]["contrib"],
        "final_strategy": rows[-1]["value"],
        "final_maxret": rows[-1]["maxret"],
        "final_lev": rows[-1]["lev"],
        "final_spy": rows[-1]["spy"],
        "xirr_strategy": xirr([r["value"] for r in rows], n, rows[-1]["value"]),
        "xirr_maxret": xirr([r["maxret"] for r in rows], n, rows[-1]["maxret"]),
        "xirr_lev": xirr([r["lev"] for r in rows], n, rows[-1]["lev"]),
        "xirr_spy": xirr([r["spy"] for r in rows], n, rows[-1]["spy"]),
        "sharpe_strategy": strat_sh, "sharpe_maxret": mr_sh,
        "sharpe_lev": lev_sh, "sharpe_spy": spy_sh,
        "maxdd_strategy": strat_dd, "maxdd_maxret": mr_dd,
        "maxdd_lev": lev_dd, "maxdd_spy": spy_dd,
        "first": rows[0]["m"], "last": rows[-1]["m"],
    }
    (OUT / "sim_result.json").write_text(json.dumps(
        {"summary": result, "rows": rows}, indent=1), encoding="utf-8")
    for k, v in result.items():
        print(f"{k}: {v if isinstance(v, str) else round(v, 4)}")


if __name__ == "__main__":
    main()
