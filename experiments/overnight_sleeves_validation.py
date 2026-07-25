"""Independent validation of the shipped overnight sleeve claims (#2940), on real price history.

WHY THIS EXISTS. PR #2940 ships an overnight book with specific quantitative claims:
capitulation longs "+18bp/night, t=3.5 over 30y"; a bear-rally fade "next overnight averages
-13bp (t=-2.1)"; a book at "Sharpe 1.78, max DD -3.1% (23y)". None of those numbers is asserted
by any test in that PR, and neither the cited backtests (oracle ledger `downtrend-decomposition-*`,
`bandits-trader-*`) nor any experiment reproducing them exists anywhere in the repository. So the
claims are currently unreproducible from the repo. This reproduces them from scratch.

THE GATES ARE PORTED VERBATIM from apps/lantern-garage/lib/overnight-trader.js (smaAt, emaAll,
macdLine, rv10At, uptrendGate, capitulationGate, fadeGate) so this is a faithful test of the
shipped logic, not a paraphrase of it. Parameter lock: no tuning, no added filters.

DATA. Yahoo daily OHLC, full history: SPY 8428 bars from 1993 (33.5y), QQQ 6886 from 1999,
IWM 6578 from 2000, GLD 5453 from 2004. The overnight return of a signal fired at the close of
day i is close[i] -> open[i+1], which is exactly what the sleeves hold.

LITERATURE ANCHOR. The overnight/intraday split is one of the most heavily documented anomalies
in equities -- Lou, Polk & Skouras, "A Tug of War: Overnight versus Intraday Expected Returns"
(JFE 2019, CRSP+TAQ 1993-2013) show the overnight and intraday components carry systematically
different premia. So a non-zero overnight effect is expected a priori; the question here is
strictly whether THESE gates earn THESE magnitudes.

PRE-REGISTERED GATES (fixed before running):
  V1 (capitulation replicates): mean overnight return after the capitulation signal is
     POSITIVE with |t| >= 3.0 (the Harvey-Liu bar for a new factor claim under multiple testing).
     The PR claims +18bp and t=3.5, so it should clear this comfortably if real.
  V2 (magnitude): the measured mean is within a factor of 2 of the claimed +18bp
     (i.e. 9bp to 36bp). A correct sign at a tenth the size is not the claimed edge.
  V3 (fade replicates): mean overnight return after the bear-rally signal is NEGATIVE
     (the PR claims -13bp, t=-2.1). Reported against the same |t|>=3.0 bar it does not claim
     to meet, so the comparison is stated, not used to fail it.
  V4 (not one regime): the capitulation sign holds in BOTH halves of the sample split by date.
  KILL: V1 fails -> the shipped capitulation claim does not reproduce on 33 years of real data.

Read-only analysis. Places no orders.
Run:  python experiments/overnight_sleeves_validation.py
"""

from __future__ import annotations

import csv
import json
import math
import os
import statistics as st

D = os.path.join("data", "equities")
OUT = os.path.join("experiments", "results", "overnight_sleeves_validation.json")
CLAIM_CAPITULATION_BP = 18.0
CLAIM_FADE_BP = -13.0


# ---- gate math ported verbatim from lib/overnight-trader.js -------------------
def sma_at(a, n, end):
    if end < n - 1:
        return None
    return sum(a[end - n + 1: end + 1]) / n


def ema_all(a, n):
    if len(a) < n:
        return None
    k = 2 / (n + 1)
    e = a[0]
    for i in range(1, len(a)):
        e = a[i] * k + e * (1 - k)
    return e


def macd_line(closes):
    if len(closes) < 35:
        return 0.0
    t = closes[-35:]
    return ema_all(t, 12) - ema_all(t, 26)


def rv10_at(closes, end):
    if end < 11:
        return None
    r = [closes[i] / closes[i - 1] - 1 for i in range(end - 9, end + 1)]
    m = sum(r) / len(r)
    return math.sqrt(sum((x - m) ** 2 for x in r) / len(r))


def capitulation_gate(closes):
    i = len(closes) - 1
    if i < 70:
        return False
    s50 = sma_at(closes, 50, i)
    mh = macd_line(closes)
    down = (s50 is not None and closes[i] < s50) and mh < 0
    if not down:
        return False
    lo20 = min(closes[i - 19: i + 1])
    return closes[i] <= lo20 * 1.001


def fade_gate(closes):
    i = len(closes) - 1
    if i < 70:
        return False
    s50 = sma_at(closes, 50, i)
    mh = macd_line(closes)
    down = (s50 is not None and closes[i] < s50) and mh < 0
    if not down:
        return False
    return (closes[i] / closes[i - 1] - 1) >= 0.01


def uptrend_gate(closes, vol_mode):
    i = len(closes) - 1
    if i < 70:
        return False
    s50 = sma_at(closes, 50, i)
    mh = macd_line(closes)
    if not ((s50 is None or closes[i] > s50) and mh > 0):
        return False
    v = rv10_at(closes, i)
    if v is None:
        return False
    hist = [x for e in range(max(11, i - 60), i) if (x := rv10_at(closes, e)) is not None]
    if not hist:
        return False
    s = sorted(hist)
    m = len(s) // 2
    vm = s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2
    not_flat = vm is not None and v > vm
    return True if vol_mode == "any" else (not not_flat) if vol_mode == "flat" else not_flat


# ---- data ---------------------------------------------------------------------
def load(sym):
    p = os.path.join(D, f"{sym}.csv")
    if not os.path.exists(p):
        return None
    rows = []
    with open(p, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            try:
                rows.append((r["date"], float(r["open"]), float(r["close"])))
            except Exception:
                continue
    return rows


def tstat(v):
    n = len(v)
    if n < 3:
        return 0.0, float("nan")
    m = st.mean(v)
    sd = st.stdev(v)
    if sd == 0:
        return 0.0, float("nan")
    t = m / (sd / n ** 0.5)
    try:
        from statistics import NormalDist
        p = 2 * (1 - NormalDist().cdf(abs(t)))
    except Exception:
        p = float("nan")
    return t, p


def run_signal(rows, gate, vol_mode=None):
    """Overnight return (close[i] -> open[i+1]) in bp on every day the gate fires."""
    closes = [r[2] for r in rows]
    out = []
    for i in range(70, len(rows) - 1):
        window = closes[: i + 1]
        fired = gate(window, vol_mode) if vol_mode is not None else gate(window)
        if not fired:
            continue
        overnight = (rows[i + 1][1] / rows[i][2] - 1) * 10000  # bp
        out.append((rows[i][0], overnight))
    return out


def summarize(name, sig, claim_bp=None):
    v = [x[1] for x in sig]
    if len(v) < 5:
        return {"signal": name, "n": len(v), "note": "too few firings"}
    m = st.mean(v)
    t, p = tstat(v)
    half = len(sig) // 2
    m1 = st.mean([x[1] for x in sig[:half]])
    m2 = st.mean([x[1] for x in sig[half:]])
    d = {"signal": name, "n": len(v), "mean_bp": round(m, 2), "median_bp": round(st.median(v), 2),
         "sd_bp": round(st.stdev(v), 1), "t": round(t, 2), "p": round(p, 4),
         "win_rate_pct": round(100 * sum(1 for x in v if x > 0) / len(v), 1),
         "first_half_bp": round(m1, 2), "second_half_bp": round(m2, 2),
         "date_range": [sig[0][0], sig[-1][0]]}
    if claim_bp is not None:
        d["claimed_bp"] = claim_bp
        d["ratio_measured_to_claimed"] = round(m / claim_bp, 2) if claim_bp else None
    return d


def main():
    spy = load("SPY")
    if not spy:
        print("no SPY data")
        return
    rep = {"date": "2026-07-25", "data": {}, "signals": {}}
    for s in ("SPY", "QQQ", "IWM", "GLD"):
        r = load(s)
        if r:
            rep["data"][s] = {"bars": len(r), "from": r[0][0], "to": r[-1][0]}

    # baseline: unconditional overnight return, the thing every sleeve must beat
    base = [((spy[i + 1][1] / spy[i][2] - 1) * 10000) for i in range(len(spy) - 1)]
    bt, bp_ = tstat(base)
    rep["baseline_unconditional_overnight_SPY"] = {
        "n": len(base), "mean_bp": round(st.mean(base), 2), "t": round(bt, 2), "p": round(bp_, 4)}

    cap = run_signal(spy, capitulation_gate)
    fade = run_signal(spy, fade_gate)
    rep["signals"]["capitulation_SPY"] = summarize("capitulation_20d_low", cap, CLAIM_CAPITULATION_BP)
    rep["signals"]["bear_rally_fade_SPY"] = summarize("bear_rally_fade", fade, CLAIM_FADE_BP)
    for sym, vm in (("SPY", "notflat"), ("IWM", "notflat"), ("GLD", "notflat"), ("QQQ", "flat")):
        r = load(sym)
        if r:
            sig = run_signal(r, uptrend_gate, vm)
            rep["signals"][f"uptrend_{vm}_{sym}"] = summarize(f"uptrend+{vm} {sym}", sig)

    c = rep["signals"]["capitulation_SPY"]
    f = rep["signals"]["bear_rally_fade_SPY"]
    v1 = bool(c.get("mean_bp", 0) > 0 and abs(c.get("t", 0)) >= 3.0)
    v2 = bool(c.get("mean_bp") is not None and 9.0 <= c.get("mean_bp", 0) <= 36.0)
    v3 = bool(f.get("mean_bp", 1) < 0)
    v4 = bool(c.get("first_half_bp", 0) > 0 and c.get("second_half_bp", 0) > 0)
    rep["gates"] = {
        "V1_capitulation_positive_t3": {"PASS": v1, "mean_bp": c.get("mean_bp"), "t": c.get("t"), "n": c.get("n")},
        "V2_magnitude_within_2x_of_claim": {"PASS": v2, "measured": c.get("mean_bp"), "claimed": CLAIM_CAPITULATION_BP},
        "V3_fade_negative": {"PASS": v3, "measured": f.get("mean_bp"), "claimed": CLAIM_FADE_BP, "t": f.get("t")},
        "V4_both_halves_positive": {"PASS": v4, "first": c.get("first_half_bp"), "second": c.get("second_half_bp")},
    }
    rep["gates"]["VERDICT"] = (
        "CLAIMS REPRODUCE" if (v1 and v2 and v3 and v4) else
        "CAPITULATION REPRODUCES, details differ" if v1 else
        "DOES NOT REPRODUCE — the shipped capitulation claim fails on 33 years of real data")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(rep, fh, indent=2)

    print("=== Independent validation of the shipped overnight sleeves (#2940) ===\n")
    b = rep["baseline_unconditional_overnight_SPY"]
    print(f"BASELINE unconditional SPY overnight: {b['mean_bp']:+.2f}bp  t={b['t']:+.2f}  n={b['n']}")
    print("  (every sleeve must beat THIS, not zero)\n")
    print(f"{'signal':28} {'n':>6} {'mean bp':>9} {'t':>7} {'win%':>6} {'1st half':>9} {'2nd half':>9}")
    for k, v in rep["signals"].items():
        if "mean_bp" not in v:
            print(f"{k:28} {v.get('n',0):>6}  (too few firings)")
            continue
        print(f"{k:28} {v['n']:>6} {v['mean_bp']:>+8.2f} {v['t']:>+6.2f} {v['win_rate_pct']:>5.1f}% "
              f"{v['first_half_bp']:>+8.2f} {v['second_half_bp']:>+8.2f}")
    print(f"\nCLAIMED: capitulation +{CLAIM_CAPITULATION_BP}bp t=3.5 | fade {CLAIM_FADE_BP}bp t=-2.1")
    print("\nGATES:")
    for k, v in rep["gates"].items():
        if k != "VERDICT":
            print(f"  {k:34} {v}")
    print(f"\nVERDICT: {rep['gates']['VERDICT']}")
    print("->", OUT)


if __name__ == "__main__":
    main()
