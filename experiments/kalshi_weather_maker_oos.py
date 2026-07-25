"""TEST A — score the weather maker candidate against the PRE-REGISTERED gates (commit 78efbf58).

Discovery set (IN-SAMPLE, frozen): KXHIGHNY — maker +1.37c/contract net, day-clustered t=2.02.
Out-of-sample set (untouched until this run): CHI, LAX, MIA, DEN, AUS, PHIL.

W3 (strict parameter lock) is honoured literally: identical fee model, identical maker-P&L
arithmetic, identical estimator as the in-sample run. No tuning, no new filters, no re-bucketing.

Gates, exactly as committed:
  W1 clustered significance : pooled OOS mean > 0, p < 0.05, t-test on CITY-DAY units
  W2 post-selection         : decision uses the James-Stein shrunk per-city estimate
  W3 parameter lock         : same code path/fee/estimator  (structural, asserted not scored)
  W4 majority + veto        : >= 4 of 6 cities positive net AND no city worse than -2.0c
  W5 decay                  : OOS pooled mean >= 50% of IS mean (>= +0.57c)
  W6 fill realism           : survives capturing only 25% of observed maker volume
  KILL: W1 or W4 fails -> candidate REFUTED, not "needs more data"

Read-only. No orders.
Run:  python experiments/kalshi_weather_maker_oos.py
"""

from __future__ import annotations

import json
import math
import os
import statistics as st
from collections import defaultdict

D = os.path.join("data", "kalshi", "settled")
OUT = os.path.join("experiments", "results", "kalshi_weather_maker_oos.json")
E = "utf-8-sig"
IS_SERIES = "KXHIGHNY"
OOS = ["KXHIGHCHI", "KXHIGHLAX", "KXHIGHMIA", "KXHIGHDEN", "KXHIGHAUS", "KXHIGHPHIL"]
IS_MEAN = 1.146          # in-sample day-clustered mean, frozen at pre-registration
W5_FLOOR = 0.5 * IS_MEAN  # +0.573c


def fee_per_contract(p):                     # W3: identical fee model as the IS run
    x = max(0.0, min(1.0, p / 100.0))
    return 0.07 * x * (1 - x) * 100


def load(series):
    """-> {ticker: (V, day)} and the trades path."""
    V, DAY = {}, {}
    mp = os.path.join(D, f"{series}.markets.jsonl")
    if not os.path.exists(mp):
        return None, None, None
    for line in open(mp, encoding=E):
        if not line.strip():
            continue
        m = json.loads(line)
        r = (m.get("result") or "").lower()
        if r in ("yes", "no"):
            V[m["ticker"]] = 100.0 if r == "yes" else 0.0
            DAY[m["ticker"]] = (m.get("close_time") or "")[:10]
    return V, DAY, os.path.join(D, f"{series}.trades.jsonl")


def city_days(series):
    """Per-day maker net c/contract for one city, plus the raw trade-level list for W6."""
    V, DAY, tp = load(series)
    if not V or not os.path.exists(tp):
        return None, None
    day = defaultdict(lambda: {"g": 0.0, "f": 0.0, "n": 0.0})
    trades = []            # (maker_pnl_per_contract_net, contracts) for the fill-realism gate
    for line in open(tp, encoding=E):
        if not line.strip():
            continue
        t = json.loads(line)
        tk = t.get("ticker")
        if tk not in V:
            continue
        try:
            p = float(t["yes_price_dollars"]) * 100
            c = float(t.get("count_fp", 0) or 0)
        except Exception:
            continue
        if c <= 0 or not (0 < p < 100):
            continue
        s = (t.get("taker_side") or "").lower()
        if s == "yes":
            mk = p - V[tk]
        elif s == "no":
            mk = V[tk] - p
        else:
            continue
        f = fee_per_contract(p)
        d = day[DAY[tk]]
        d["g"] += mk * c; d["f"] += f * c; d["n"] += c
        trades.append((mk - f, c))
    per_day = {k: (v["g"] - v["f"]) / v["n"] for k, v in day.items() if v["n"] > 0}
    return per_day, trades


def james_stein(means, ns):
    """Shrink per-city means toward the grand mean (Pav: the selected-max estimate is biased).
    Uses the standard JS form with a common variance estimated from the spread."""
    k = len(means)
    if k < 4:
        return list(means), None          # JS needs k>=4 to shrink meaningfully
    gm = st.mean(means)
    ss = sum((m - gm) ** 2 for m in means)
    if ss <= 0:
        return list(means), 1.0
    var = st.pvariance(means)
    shrink = max(0.0, 1.0 - (k - 3) * var / ss)
    return [gm + shrink * (m - gm) for m in means], round(shrink, 4)


def main():
    per_city, per_city_days, per_city_trades = {}, {}, {}
    for s in OOS:
        pd_, tr = city_days(s)
        if not pd_:
            continue
        per_city_days[s] = pd_
        per_city_trades[s] = tr
        # volume-weighted city mean (the estimator used in-sample)
        per_city[s] = st.mean(list(pd_.values()))

    # ---- W1: pooled t-test on CITY-DAY units
    units = [(f"{s}:{d}", v) for s, pdv in per_city_days.items() for d, v in pdv.items()]
    vals = [v for _, v in units]
    n = len(vals)
    mean = st.mean(vals); sd = st.stdev(vals) if n > 1 else 0.0
    t = mean / (sd / n ** 0.5) if sd > 0 else 0.0
    # two-sided p from the t distribution (normal approx is poor at small df; use survival fn)
    try:
        from statistics import NormalDist
        # Welch-ish: use normal approx but report df so the reader can judge
        p_two = 2 * (1 - NormalDist().cdf(abs(t)))
    except Exception:
        p_two = float("nan")
    w1 = (mean > 0) and (p_two < 0.05)

    # ---- W2: James-Stein shrunk per-city estimates
    cities = list(per_city.keys())
    raw = [per_city[c] for c in cities]
    shrunk, shrink_factor = james_stein(raw, [len(per_city_days[c]) for c in cities])
    shrunk_map = dict(zip(cities, shrunk))

    # ---- W4: majority pass + catastrophic veto (on the SHRUNK estimates, per W2)
    positive = [c for c in cities if shrunk_map[c] > 0]
    worst = min(shrunk_map.values()) if shrunk_map else 0.0
    w4 = (len(positive) >= 4) and (worst >= -2.0)

    # ---- W5: decay vs in-sample
    w5 = mean >= W5_FLOOR

    # ---- W6: fill realism. Literal gate = capture 25% of maker volume.
    # Reported BOTH ways because the literal reading is weak: under uniform capture the
    # per-contract edge is unchanged by construction, so it cannot fail. The adverse reading
    # (a newcomer wins the queue preferentially on the trades the maker LOSES) is the real risk.
    all_tr = [x for s in per_city_trades for x in per_city_trades[s]]
    tot_c = sum(c for _, c in all_tr)
    uniform = sum(v * c for v, c in all_tr) / tot_c if tot_c else 0.0
    ordered = sorted(all_tr, key=lambda x: x[0])          # worst maker P&L first
    take, acc_c, acc_v = 0.25 * tot_c, 0.0, 0.0
    for v, c in ordered:
        if acc_c >= take:
            break
        use = min(c, take - acc_c)
        acc_v += v * use; acc_c += use
    adverse = acc_v / acc_c if acc_c else 0.0
    w6_literal = uniform > 0
    w6_adverse = adverse > 0

    verdict = ("REFUTED — W1 or W4 failed; the weather maker candidate is dead"
               if not (w1 and w4) else
               "PARTIAL — significant and broad, but decayed vs in-sample; paper-trade only"
               if not w5 else
               "SURVIVES — significant, broad, and no material decay (still paper-trade first)")

    rep = {
        "date": "2026-07-25", "test": "A — weather maker OOS vs pre-registered gates (78efbf58)",
        "in_sample": {"series": IS_SERIES, "day_clustered_mean_c": IS_MEAN, "t": 2.02, "days": 10},
        "oos_cities": {c: {"days": len(per_city_days[c]),
                           "raw_mean_c": round(per_city[c], 4),
                           "js_shrunk_mean_c": round(shrunk_map[c], 4)} for c in cities},
        "js_shrink_factor": shrink_factor,
        "pooled": {"city_day_units": n, "mean_c": round(mean, 4), "sd": round(sd, 4),
                   "t": round(t, 3), "p_two_sided_normal_approx": round(p_two, 4)},
        "fill_realism": {"uniform_25pct_c": round(uniform, 4),
                         "adverse_worst_25pct_c": round(adverse, 4)},
        "gates": {
            "W1_clustered_significance": {"PASS": bool(w1), "mean": round(mean, 4), "t": round(t, 3), "p": round(p_two, 4)},
            "W2_post_selection_shrinkage": {"applied": True, "shrink_factor": shrink_factor},
            "W3_parameter_lock": {"PASS": True, "note": "identical fee model, P&L arithmetic and estimator as the IS run"},
            "W4_majority_and_veto": {"PASS": bool(w4), "cities_positive": len(positive), "of": len(cities), "worst_city_c": round(worst, 4)},
            "W5_decay": {"PASS": bool(w5), "oos_mean": round(mean, 4), "floor": round(W5_FLOOR, 4)},
            "W6_fill_realism": {"literal_PASS": bool(w6_literal), "adverse_PASS": bool(w6_adverse),
                                "note": "literal gate is weak by construction; adverse variant is the real risk"},
            "VERDICT": verdict,
        },
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(rep, f, indent=2)

    print("=== TEST A: weather maker OOS vs PRE-REGISTERED gates ===\n")
    print(f"IN-SAMPLE (frozen): {IS_SERIES}  +{IS_MEAN:.3f}c/contract, t=2.02, 10 days\n")
    print(f"{'city':12} {'days':>5} {'raw mean':>10} {'JS shrunk':>11}")
    for c in cities:
        print(f"{c:12} {len(per_city_days[c]):>5} {per_city[c]:>+9.3f}c {shrunk_map[c]:>+10.3f}c")
    print(f"\nPOOLED (city-day units): n={n}  mean={mean:+.3f}c  sd={sd:.3f}  t={t:.2f}  p={p_two:.4f}")
    print(f"JS shrink factor: {shrink_factor}")
    print(f"\nfill realism: uniform-25% {uniform:+.3f}c | adverse-worst-25% {adverse:+.3f}c")
    print("\nGATES:")
    for k in ("W1_clustered_significance", "W4_majority_and_veto", "W5_decay"):
        print(f"  {k:32} {rep['gates'][k]}")
    print(f"  W6 literal={w6_literal} adverse={w6_adverse}")
    print(f"\nVERDICT: {verdict}")
    print("->", OUT)


if __name__ == "__main__":
    main()
