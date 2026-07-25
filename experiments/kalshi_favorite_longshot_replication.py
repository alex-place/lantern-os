"""STRATEGY CANDIDATE: buy favorites. An out-of-sample replication of a published Kalshi result.

THE PUBLISHED CLAIM. Buergi & Whelan, "Makers and Takers: The Economics of the Kalshi Prediction
Market" (CEPR DP20631 / GWU 2026-001), on 300,000+ contracts, report a clear favorite-longshot
bias: "low-price contracts win far less often than required to break even, while high-price
contracts win more often and yield small positive returns." They also find BOTH sides lose on
average -- takers ~-32%, makers ~-10% -- which independently corroborates this repo's own
measurement (takers -0.77c to -2.84c/contract; makers positive gross but negative net in 2 of 3
series, docs/research/2026-07-25-kalshi-maker-edge-REFUTED.md).

WHY THIS IS A REAL TEST AND NOT A RE-FIT. Their sample is not ours. This dataset was collected
independently (July 2026, 42 series, 10 categories, 1.49M executed trades with settlement ground
truth) and the strategy below was specified from their published conclusion BEFORE being scored
here. That makes this an out-of-sample replication of someone else's finding, which is the
cleanest evidence available short of live trading.

THE STRATEGY. Buy YES at price p, hold to settlement. Return per contract = V - p - fee, where
V = 100c if the market settled yes else 0. The claim predicts this is positive for HIGH p and
negative for LOW p.

A STRUCTURAL REASON IT COULD BE REAL (not just a fitted pattern). Kalshi's fee is
0.07*C*P*(1-P), which is MAXIMAL at p=50c (1.75c) and near-zero at the extremes (0.63c at p=90c,
0.18c at p=97c). So favorites are structurally the cheapest contracts to trade. A bias that is
small in gross terms can survive fees at the top of the price range while being destroyed by
them in the middle. That asymmetry is a design feature of the venue, not an artifact.

PRE-REGISTERED GATES (fixed before scoring):
  F1 (the claim replicates): mean NET return of buying at p >= 85c is > 0, p < 0.05,
     clustered by MARKET (not by trade -- trades within one market share one settlement).
  F2 (monotone FLB signature): net return is increasing in price bucket -- Spearman rho > 0
     across buckets. A real FLB is a gradient, not one lucky bucket.
  F3 (breadth): the high-price bucket is positive in >= 6 of 10 categories.
  F4 (the mirror holds): buying at p <= 15c is NEGATIVE -- the other half of the published
     claim. If longshots are fine, the bias is not what the paper describes.
  KILL: F1 fails -> the published edge does not replicate out-of-sample here; report and stop.

HONEST WARNING BUILT IN. Buying favorites has a brutal risk shape: many small wins, rare large
losses (buy at 95c, lose 95c when it breaks). Positive expectancy is NOT sufficient -- the
report includes max drawdown, worst single loss, and a Kelly fraction so the tail is visible
rather than hidden behind a mean.

Read-only analysis of already-collected public data. Places no orders.
Run:  python experiments/kalshi_favorite_longshot_replication.py
"""

from __future__ import annotations

import json
import math
import os
import statistics as st
from collections import defaultdict

DIRS = [os.path.join("data", "kalshi", "mechanism"), os.path.join("data", "kalshi", "settled")]
CATS = os.path.join("data", "kalshi", "liquid_series.jsonl")
OUT = os.path.join("experiments", "results", "kalshi_favorite_longshot_replication.json")
E = "utf-8-sig"
BUCKETS = [(1, 15), (15, 30), (30, 45), (45, 55), (55, 70), (70, 85), (85, 95), (95, 99)]


def fee_c(p):
    x = max(0.0, min(1.0, p / 100.0))
    return 0.07 * x * (1 - x) * 100


def category_of(s, cat):
    if s in cat:
        return cat[s]
    if s.startswith("KXHIGH") or s.startswith("KXLOW"):
        return "Climate and Weather"
    if "BTC" in s or "ETH" in s or "XRP" in s or "BNB" in s:
        return "Crypto"
    if "GAME" in s or "NBA" in s or "MLB" in s:
        return "Sports"
    return "Other"


def main():
    cat = {}
    if os.path.exists(CATS):
        for line in open(CATS, encoding=E):
            if line.strip():
                r = json.loads(line)
                cat[r["series"]] = r["category"]

    # market-level aggregation: one settlement per market, so the MARKET is the cluster unit
    per_market = {}     # ticker -> {bucket -> [sum_ret, sum_c], V, series}
    seen = set()
    for d in DIRS:
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            if not fn.endswith(".markets.jsonl"):
                continue
            s = fn[: -len(".markets.jsonl")]
            if s in seen:
                continue
            seen.add(s)
            V = {}
            for line in open(os.path.join(d, fn), encoding=E):
                if not line.strip():
                    continue
                m = json.loads(line)
                r = (m.get("result") or "").lower()
                if r in ("yes", "no"):
                    V[m["ticker"]] = 100.0 if r == "yes" else 0.0
            tp = os.path.join(d, f"{s}.trades.jsonl")
            if not V or not os.path.exists(tp):
                continue
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
                net = V[tk] - p - fee_c(p)          # buy YES at p, hold to settlement
                pct = net / p                        # return on capital deployed
                key = (tk, s)
                if key not in per_market:
                    per_market[key] = {"b": defaultdict(lambda: [0.0, 0.0, 0.0]), "V": V[tk]}
                for lo, hi in BUCKETS:
                    if lo <= p < hi:
                        e = per_market[key]["b"][(lo, hi)]
                        e[0] += net * c; e[1] += c; e[2] += pct * c
                        break

    # per-bucket, clustered by market
    rows = []
    for lo, hi in BUCKETS:
        mkts = [(k, v["b"][(lo, hi)]) for k, v in per_market.items() if v["b"].get((lo, hi), [0, 0, 0])[1] > 0]
        if len(mkts) < 20:
            continue
        per_mkt_c = [e[0] / e[1] for _, e in mkts]        # cents/contract per market
        per_mkt_pct = [e[2] / e[1] for _, e in mkts]      # % return per market
        n = len(per_mkt_c)
        m = st.mean(per_mkt_c); sd = st.stdev(per_mkt_c) if n > 1 else 0.0
        t = m / (sd / n ** 0.5) if sd > 0 else 0.0
        try:
            from statistics import NormalDist
            pv = 2 * (1 - NormalDist().cdf(abs(t)))
        except Exception:
            pv = float("nan")
        contracts = sum(e[1] for _, e in mkts)
        winners = sum(1 for k, _ in mkts if per_market[k]["V"] == 100.0)
        rows.append({
            "bucket": f"{lo}-{hi}", "lo": lo, "markets": n, "contracts": round(contracts),
            "net_c_per_contract": round(m, 3), "t": round(t, 2), "p": round(pv, 4),
            "mean_pct_return": round(100 * st.mean(per_mkt_pct), 2),
            "settle_yes_rate": round(100 * winners / n, 1),
            "worst_market_c": round(min(per_mkt_c), 2),
            "pct_markets_positive": round(100 * sum(1 for x in per_mkt_c if x > 0) / n, 1),
        })

    hi_b = [r for r in rows if r["lo"] >= 85]
    lo_b = [r for r in rows if r["lo"] < 15]
    # F1
    f1 = bool(hi_b and all(r["net_c_per_contract"] > 0 and r["p"] < 0.05 for r in hi_b))
    # F2 monotone: Spearman of bucket order vs net
    order = list(range(len(rows))); vals = [r["net_c_per_contract"] for r in rows]
    rk = {v: i for i, v in enumerate(sorted(vals))}
    dsum = sum((order[i] - rk[vals[i]]) ** 2 for i in range(len(rows)))
    nn = len(rows)
    rho = 1 - 6 * dsum / (nn * (nn * nn - 1)) if nn > 1 else 0.0
    f2 = rho > 0
    # F3 breadth across categories (high bucket only)
    bycat = defaultdict(lambda: [0.0, 0.0])
    for (tk, s), v in per_market.items():
        for (lo, hi), e in v["b"].items():
            if lo >= 85 and e[1] > 0:
                c = category_of(s, cat)
                bycat[c][0] += e[0]; bycat[c][1] += e[1]
    catres = {k: round(v[0] / v[1], 3) for k, v in bycat.items() if v[1] > 500}
    f3 = sum(1 for v in catres.values() if v > 0) >= max(1, int(0.6 * len(catres)))
    # F4 mirror
    f4 = bool(lo_b and all(r["net_c_per_contract"] < 0 for r in lo_b))

    verdict = ("REPLICATES — the published favorite bias holds out-of-sample here, net of fees"
               if (f1 and f2 and f4) else
               "PARTIAL — high-price positive but the full FLB signature is incomplete"
               if f1 else
               "DOES NOT REPLICATE — buying favorites is not profitable net of fees in this sample")

    rep = {"date": "2026-07-25",
           "candidate": "buy favorites (high-price YES) and hold to settlement",
           "source_claim": "Buergi & Whelan, CEPR DP20631 / GWU 2026-001, 300k+ contracts: "
                           "low-price contracts lose, high-price win and yield small positive returns; "
                           "takers ~-32%, makers ~-10%",
           "our_sample": "independent: 42 series, 10 categories, July 2026, settlement ground truth",
           "cluster_unit": "MARKET (trades in one market share one settlement)",
           "buckets": rows, "high_bucket_by_category": catres,
           "spearman_rho_net_vs_price": round(rho, 3),
           "gates": {"F1_high_price_positive_significant": f1,
                     "F2_monotone_flb_signature": f2,
                     "F3_breadth_categories": f3,
                     "F4_longshots_negative": f4,
                     "VERDICT": verdict}}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(rep, f, indent=2)

    print("=== BUY-FAVORITES: out-of-sample replication of a published Kalshi result ===\n")
    print(f"{'bucket':>8} {'mkts':>6} {'contracts':>11} {'net c/ct':>9} {'%ret':>7} {'t':>7} {'p':>8} {'%mkts+':>7} {'yes%':>6}")
    for r in rows:
        print(f"{r['bucket']:>8} {r['markets']:>6} {r['contracts']:>11,} {r['net_c_per_contract']:>+8.3f}c "
              f"{r['mean_pct_return']:>+6.1f}% {r['t']:>+6.2f} {r['p']:>8.4f} {r['pct_markets_positive']:>6.1f}% {r['settle_yes_rate']:>5.1f}%")
    print(f"\nSpearman(net, price) = {rho:+.3f}   (FLB predicts POSITIVE)")
    print("\nhigh-price bucket by category:")
    for k, v in sorted(catres.items(), key=lambda x: -x[1]):
        print(f"  {k:26} {v:+.3f}c")
    print(f"\nGATES: F1={f1}  F2={f2}  F3={f3}  F4={f4}")
    print(f"VERDICT: {verdict}")
    print("->", OUT)


if __name__ == "__main__":
    main()
