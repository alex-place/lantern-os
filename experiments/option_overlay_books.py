"""Option-overlay books for the $20/mo walk-forward DCA harness (#2578).

Extends experiments/dca_walkforward_sim.py with books that hold REAL
option-strategy price histories -- no synthetic option pricing:

  * tangency_put  : put-write proxy    ^PUT (CBOE S&P 500 PutWrite total-return
      index, 1996-09+ -- live from the sim's very first month). MEASURED
      SUBSTITUTION: the intended ETF proxy PUTW (WisdomTree, listed 2016)
      currently returns ZERO history from Yahoo (meta firstTradeDate is reset
      to 2026-07-15 under every query form), so the underlying CBOE index is
      the only real put-write monthly history retrievable. It is pre-fee and
      perfectly tracked, so this book is slightly optimistic vs an investable
      wrapper -- the PBP book below is the investable check.
  * tangency_pbp  : buy-write ETF      PBP (Invesco S&P 500 BuyWrite, 2008+),
      the investable put-call-parity cousin of put-write (BXM vs PUT).
  * tangency_qyld : covered-call proxy QYLD (Global X Nasdaq-100 Covered Call, 2013+)
  * tangency_jepi : covered-call proxy JEPI (JPMorgan Equity Premium Income, 2020+)
      each folded into the max-Sharpe tangency optimisation universe via the
      SAME universe-entry mechanism as the base sim (asset enters only once
      >= 36 months of its own history has accrued -- no look-ahead).
  * collarish     : the base tangency mix with a FIXED 20% option-income
      sleeve, equal-split across whichever of the INVESTABLE overlay ETFs
      (PBP/QYLD/JEPI) are listed, folded in from each ETF's listing date (a
      fixed sleeve needs no trailing estimation window, so listing-date entry
      is honest). "Collar-ish" only loosely: the sleeve caps the return
      distribution with short-option income; a true collar also BUYS
      protective puts, and no liquid protective-put ETF has a comparable
      history.

Benchmarks: SPY-only DCA and the base 6-ETF tangency book, run through the
identical engine. Metrics per book: final value, deposit-stripped Sharpe with
Lo (2002) 95% CI, max drawdown, and the ADR-0028 mandate verdict vs target
0.79 ("Buffett bar"): meets_ci if CI lower bound >= 0.79, meets_point if the
point estimate >= 0.79, else below.

Because the overlay ETFs list late, every overlay book is IDENTICAL to the
base tangency book until its overlay enters, so full-period final-value deltas
are entirely attributable to the overlay; post-entry overlapping windows are
ALSO reported apples-to-apples (same dates for book / tangency / SPY), plus
each overlay ETF standalone vs SPY on its own full listed window.

Corpus grounding: arXiv 2508.18868 (option overlays hedge the estimation risk
of Kelly-style sizing), arXiv 2508.16598 (Kelly-sized VIX put-writing harvests
the variance risk premium), arXiv 2606.17032 (skew-aware option Sharpe
maximisation -- short-vol overlays shift the attainable Sharpe frontier).

Data: Yahoo monthly adjusted closes (dividends reinvested), $0 commissions,
fractional shares, no taxes/slippage. Simulation != advice.
"""
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import dca_walkforward_sim as W

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
OUT = Path(__file__).parent / "results"
BAR = 0.79            # ADR-0028 mandate target (Buffett bar)
SLEEVE = 0.20         # fixed option-income sleeve for the collar-ish book
BASE = list(W.UNIVERSE)
OVERLAYS = ["^PUT", "PBP", "QYLD", "JEPI"]   # ^PUT = CBOE PutWrite TR index
SLEEVE_SYMS = ["PBP", "QYLD", "JEPI"]        # investable ETFs only in the sleeve


def lo_ci(sh_ann, T, periods=12):
    """Lo (2002) IID-case 95% CI for an annualized Sharpe from T periodic obs."""
    s = sh_ann / math.sqrt(periods)
    se = math.sqrt((1 + s * s / 2) / T) * math.sqrt(periods)
    return sh_ann - 1.96 * se, sh_ann + 1.96 * se


def verdict(sh, lo):
    if lo >= BAR:
        return "meets_ci"
    if sh >= BAR:
        return "meets_point"
    return "below"


def strip_rets(values, contribs):
    """Monthly returns with the $20 deposit stripped (same as base sim stats)."""
    v = np.array(values, dtype=float)
    c = np.array(contribs, dtype=float)
    return np.diff(v) / v[:-1] - np.diff(c) / v[:-1]


def ret_stats(rets):
    r = np.asarray(rets, dtype=float)
    if r.size < 3 or r.std(ddof=1) == 0:
        return {"sharpe": 0.0, "ci": [0.0, 0.0], "verdict": "below",
                "maxdd": 0.0, "n": int(r.size)}
    sh = float(r.mean() / r.std(ddof=1) * math.sqrt(12))
    lo, hi = lo_ci(sh, r.size)
    eq, peak, mdd = 1.0, 1.0, 0.0
    for x in r:
        eq *= 1 + x
        peak = max(peak, eq)
        mdd = min(mdd, eq / peak - 1)
    return {"sharpe": sh, "ci": [float(lo), float(hi)],
            "verdict": verdict(sh, lo), "maxdd": float(mdd), "n": int(r.size)}


def last_px(series_s, t):
    if t in series_s:
        return series_s[t]
    past = [m for m in series_s if m <= t]
    return series_s[max(past)] if past else 0.0


def run_book(series, months, opt_universe, sleeve_syms=(), sleeve_frac=0.0):
    """One $20/mo walk-forward book.

    opt_universe: symbols in the tangency optimisation, entering via the base
                  sim's mechanism (>= MIN_OBS months of own history, trailing
                  <= WINDOW months for mu/cov -- no look-ahead).
    sleeve_syms:  symbols held as a FIXED equal-split sleeve of sleeve_frac,
                  from each symbol's first listed price month.
    """
    book = {s: 0.0 for s in list(opt_universe) + list(sleeve_syms)}
    rows, entries, contributed = [], {}, 0.0
    for t in months:
        live, hist = [], []
        for s in opt_universe:
            if t not in series[s]:
                continue
            past = [m for m in sorted(series[s]) if m <= t]
            if len(past) >= W.MIN_OBS + 1:
                live.append(s)
                px_hist = [series[s][m] for m in past[-(W.WINDOW + 1):]]
                hist.append(np.diff(np.log(px_hist)))
        if not live:
            continue
        L = min(len(h) for h in hist)
        R = np.stack([h[-L:] for h in hist])
        mu = R.mean(axis=1)
        cov = np.atleast_2d(np.cov(R) if len(live) > 1 else np.array([[R.var()]]))
        w = W.tangency(mu, cov, len(live))

        sl_live = [s for s in sleeve_syms if t in series[s]]
        if sl_live:
            syms = live + sl_live
            wts = np.concatenate([w * (1.0 - sleeve_frac),
                                  np.full(len(sl_live), sleeve_frac / len(sl_live))])
        else:
            syms, wts = live, w
        for s in syms:
            entries.setdefault(s, t)

        px = {s: series[s][t] for s in syms}
        value = sum(book[s] * px[s] for s in syms)
        new_total = value + W.CONTRIB
        deficit = {s: max(0.0, wts[i] * new_total - book[s] * px[s])
                   for i, s in enumerate(syms)}
        dsum = sum(deficit.values())
        if dsum >= W.CONTRIB:
            alloc = {s: W.CONTRIB * deficit[s] / dsum for s in syms}
        else:
            alloc = {s: deficit[s] + (W.CONTRIB - dsum) * wts[i]
                     for i, s in enumerate(syms)}
        for s, d in alloc.items():
            book[s] += d / px[s]
        contributed += W.CONTRIB
        val = sum(book[s] * last_px(series[s], t) for s in book if book[s] > 0)
        rows.append({"m": t, "value": val, "contrib": contributed})
    return rows, entries


def standalone(series, sym):
    """Overlay ETF on its own full listed window vs SPY on the SAME months."""
    ms = [m for m in sorted(series[sym]) if m in series["SPY"]]
    p = np.array([series[sym][m] for m in ms])
    q = np.array([series["SPY"][m] for m in ms])
    yrs = (len(ms) - 1) / 12.0

    def side(px):
        st = ret_stats(px[1:] / px[:-1] - 1.0)
        st["cagr"] = float((px[-1] / px[0]) ** (1.0 / yrs) - 1.0)
        return st

    return {"window": f"{ms[0]}..{ms[-1]}", "months": len(ms),
            "etf": side(p), "spy_same_window": side(q)}


def fmt(st):
    return (f"sharpe {st['sharpe']:5.2f} [{st['ci'][0]:5.2f},{st['ci'][1]:5.2f}] "
            f"-> {st['verdict']:<11} maxDD {st['maxdd'] * 100:5.1f}%")


def main():
    series = {}
    for s in BASE + OVERLAYS:
        series[s] = W.fetch_monthly(s)
        print(f"fetched {s}: {len(series[s])} months "
              f"({min(series[s])} -> {max(series[s])})")
    months = sorted(m for m in series["SPY"] if m >= W.START)

    specs = {
        "spy": (["SPY"], (), 0.0),
        "tangency": (BASE, (), 0.0),
        "tangency_put": (BASE + ["^PUT"], (), 0.0),
        "tangency_pbp": (BASE + ["PBP"], (), 0.0),
        "tangency_qyld": (BASE + ["QYLD"], (), 0.0),
        "tangency_jepi": (BASE + ["JEPI"], (), 0.0),
        "collarish": (BASE, tuple(SLEEVE_SYMS), SLEEVE),
    }
    rows, entries = {}, {}
    for name, (uni, sl, sf) in specs.items():
        rows[name], entries[name] = run_book(series, months, uni, sl, sf)
    n = len(rows["spy"])
    assert all(len(r) == n and all(a["m"] == b["m"] for a, b in zip(r, rows["spy"]))
               for r in rows.values()), "books must share the month grid"

    contribs = [r["contrib"] for r in rows["spy"]]
    rets = {k: strip_rets([r["value"] for r in v], contribs) for k, v in rows.items()}
    books = {}
    print(f"\n=== full period {rows['spy'][0]['m']}..{rows['spy'][-1]['m']} "
          f"({n} months, ${contribs[-1]:,.0f} contributed, bar {BAR}) ===")
    for k in specs:
        st = ret_stats(rets[k])
        books[k] = {"final": float(rows[k][-1]["value"]),
                    "contributed": float(contribs[-1]), **st}
        print(f"{k:<14} final ${books[k]['final']:10,.0f}  {fmt(st)}")

    # post-entry overlapping windows: same dates for book / tangency / SPY
    overlay_of = {"tangency_put": "^PUT", "tangency_pbp": "PBP",
                  "tangency_qyld": "QYLD", "tangency_jepi": "JEPI",
                  "collarish": "PBP"}
    month_idx = {r["m"]: i for i, r in enumerate(rows["spy"])}
    print("\n=== post-entry overlapping windows (apples-to-apples dates) ===")
    for k, sym in overlay_of.items():
        entry = entries[k].get(sym)
        if entry is None:
            books[k]["overlay_entry"] = None
            continue
        e = month_idx[entry]
        window = f"{entry}..{rows['spy'][-1]['m']}"
        ov = {"window": window,
              "book": ret_stats(rets[k][e:]),
              "tangency": ret_stats(rets["tangency"][e:]),
              "spy": ret_stats(rets["spy"][e:]),
              "final_delta_vs_tangency":
                  books[k]["final"] - books["tangency"]["final"],
              "final_delta_vs_spy": books[k]["final"] - books["spy"]["final"]}
        books[k]["overlay_entry"] = entry
        books[k]["overlap"] = ov
        print(f"{k} ({sym} enters {entry}, window {window}, "
              f"delta vs tangency ${ov['final_delta_vs_tangency']:+,.0f}):")
        for side in ("book", "tangency", "spy"):
            print(f"  {side:<9} {fmt(ov[side])}")
    books["collarish"]["sleeve"] = SLEEVE
    books["collarish"]["sleeve_entries"] = {
        s: entries["collarish"].get(s) for s in SLEEVE_SYMS}

    print("\n=== overlay ETFs standalone vs SPY on the same window ===")
    stand = {}
    for sym in OVERLAYS:
        stand[sym] = standalone(series, sym)
        print(f"{sym} {stand[sym]['window']} ({stand[sym]['months']} months):")
        for side in ("etf", "spy_same_window"):
            st = stand[sym][side]
            print(f"  {side:<15} cagr {st['cagr'] * 100:6.2f}%  {fmt(st)}")

    OUT.mkdir(exist_ok=True)
    (OUT / "option_overlay_books.json").write_text(json.dumps({
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "issue": 2578,
        "bar": BAR,
        "config": {"contrib": W.CONTRIB, "window": W.WINDOW, "min_obs": W.MIN_OBS,
                   "max_w": W.MAX_W, "cov_shrink": W.COV_SHRINK,
                   "mu_shrink": W.MU_SHRINK, "base_universe": BASE,
                   "overlays": OVERLAYS, "sleeve_syms": SLEEVE_SYMS,
                   "collarish_sleeve": SLEEVE, "start": W.START, "months": n,
                   "putw_note": "PUTW returns zero Yahoo history (meta "
                                "firstTradeDate reset to 2026-07-15); ^PUT "
                                "(CBOE PutWrite TR index) substituted as the "
                                "put-write proxy, PBP as the investable check"},
        "books": books,
        "standalone": stand,
        "grounding": [
            "arXiv:2508.18868 -- option overlays hedge Kelly-sizing estimation risk",
            "arXiv:2508.16598 -- Kelly-sized VIX put-writing (variance risk premium)",
            "arXiv:2606.17032 -- skew-aware option Sharpe maximisation",
        ],
    }, indent=1), encoding="utf-8")
    print(f"\nwrote {OUT / 'option_overlay_books.json'}")


if __name__ == "__main__":
    main()
