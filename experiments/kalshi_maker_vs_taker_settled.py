"""Do Kalshi MAKERS profit? Measured on real executed trades vs real settlements.

THE QUESTION THIS ANSWERS. The taker side is settled science in this repo: crypto 15M has no
taker edge (-$48/6209 trades, code-enforced), and my KXMLBGAME entry/exit pilot measured the
round-trip TAKER cost floor at ~5c mid-range, which forecloses any strategy whose per-trade edge
is smaller. The one honestly-untested lead was the MAKER side: a resting limit order EARNS the
spread instead of paying it, which flips the sign of the dominant cost term. I could not test it
before because it needs trade-direction ground truth, and the Polymarket microstructure result
(arXiv:2604.24366) shows an order-book feed supplies that at only ~59% accuracy.

WHY IT IS TESTABLE NOW, AND WITHOUT SIMULATION. Kalshi's public trade feed publishes `taker_side`
directly. Every executed trade therefore has a KNOWN maker on the opposite side, and every market
here is SETTLED with a known `result`. So realized maker P&L is not modelled — it is arithmetic
over trades that actually happened:

    V = 100c if result == 'yes' else 0c        (settlement value of one YES contract)
    taker_side == 'yes'  ->  the maker SOLD yes at p   ->  maker P&L = p - V
    taker_side == 'no'   ->  the maker SOLD no  at 100-p -> maker P&L = V - p

This is the aggregate realized profit of everyone who provided liquidity, per contract, before
fees. It is the ceiling for any autonomous market-making strategy on these markets, and its sign
is the whole question.

FEES — modelled BOTH ways, because it is the load-bearing uncertainty. Kalshi's published trading
fee is ceil(0.07 * C * P * (1-P)) and there are contexts where maker fills are not charged it.
Reporting gross, taker-fee-charged, and maker-fee-charged separates the finding from the fee
assumption instead of hiding inside it.

PRE-REGISTERED GATES (fixed before the first run):
  G1 (maker edge exists) : mean maker P&L per contract > 0 GROSS, in >= 2 of 3 series.
  G2 (survives fees)     : mean maker P&L per contract > 0 with the FULL maker fee charged,
                           in >= 2 of 3 series.
  G3 (not one market)    : the per-series result holds at the MARKET level too (median
                           per-market maker P&L > 0), so it is not one outlier market.
  KILL: G1 fails -> makers lose gross; providing liquidity is not an edge here, full stop.
        G1 passes but G2 fails -> the edge exists but is smaller than the fee; only viable
        with a fee waiver, and that must be verified before any deployment.

Read-only analysis of already-pulled public data. Places no orders.

Run:  python experiments/kalshi_maker_vs_taker_settled.py
"""

from __future__ import annotations

import json
import math
import os
import statistics as st
from collections import defaultdict

DIR = os.path.join("data", "kalshi", "settled")
OUT = os.path.join("experiments", "results", "kalshi_maker_vs_taker_settled.json")
SERIES = ["KXMLBGAME", "KXBTC15M", "KXHIGHNY"]


def fee_c(price_cents, contracts=1.0):
    """Kalshi trading fee in cents, rounded up: 0.07 * C * P * (1-P)."""
    p = max(0.0, min(1.0, price_cents / 100.0))
    return math.ceil(0.07 * contracts * p * (1 - p) * 100) / max(1.0, contracts) if contracts else 0.0


def fee_per_contract(price_cents):
    p = max(0.0, min(1.0, price_cents / 100.0))
    return 0.07 * p * (1 - p) * 100      # cents per contract, un-rounded (rounding is per-order)


def load_settlements(series):
    """ticker -> settlement value V in cents (100 if yes, 0 if no). Skips voided/unknown."""
    out = {}
    p = os.path.join(DIR, f"{series}.markets.jsonl")
    if not os.path.exists(p):
        return out
    with open(p, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                m = json.loads(line)
            except Exception:
                continue
            r = (m.get("result") or "").lower()
            if r == "yes":
                out[m.get("ticker")] = 100.0
            elif r == "no":
                out[m.get("ticker")] = 0.0
    return out


def analyse(series):
    V = load_settlements(series)
    tp = os.path.join(DIR, f"{series}.trades.jsonl")
    if not V or not os.path.exists(tp):
        return None
    per_market = defaultdict(lambda: {"gross": 0.0, "n": 0.0, "fee": 0.0, "notional": 0.0})
    n_trades = skipped = 0
    with open(tp, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                t = json.loads(line)
            except Exception:
                continue
            tk = t.get("ticker")
            if tk not in V:
                skipped += 1
                continue
            try:
                p = float(t.get("yes_price_dollars")) * 100.0
                c = float(t.get("count_fp", 0) or 0)
            except Exception:
                skipped += 1
                continue
            if c <= 0 or not (0 < p < 100):
                skipped += 1
                continue
            side = (t.get("taker_side") or "").lower()
            if side == "yes":
                maker = p - V[tk]          # maker sold YES at p
            elif side == "no":
                maker = V[tk] - p          # maker sold NO at (100-p)
            else:
                skipped += 1
                continue
            d = per_market[tk]
            d["gross"] += maker * c
            d["n"] += c
            d["fee"] += fee_per_contract(p) * c
            d["notional"] += p * c
            n_trades += 1

    if not per_market:
        return None
    tot_n = sum(d["n"] for d in per_market.values())
    tot_g = sum(d["gross"] for d in per_market.values())
    tot_f = sum(d["fee"] for d in per_market.values())
    per_mkt_gross = [d["gross"] / d["n"] for d in per_market.values() if d["n"] > 0]
    per_mkt_net = [(d["gross"] - d["fee"]) / d["n"] for d in per_market.values() if d["n"] > 0]
    # trade-weighted sd for a t-stat on the per-market means (markets are the independent unit)
    m = st.mean(per_mkt_net)
    sd = st.stdev(per_mkt_net) if len(per_mkt_net) > 1 else 0.0
    return {
        "series": series,
        "markets": len(per_market),
        "trades": n_trades,
        "contracts": round(tot_n, 1),
        "skipped_rows": skipped,
        "maker_gross_cents_per_contract": round(tot_g / tot_n, 4),
        "maker_fee_cents_per_contract": round(tot_f / tot_n, 4),
        "maker_net_if_maker_pays_fee": round((tot_g - tot_f) / tot_n, 4),
        "taker_gross_cents_per_contract": round(-tot_g / tot_n, 4),
        "taker_net_after_fee": round((-tot_g - tot_f) / tot_n, 4),
        "per_market_gross_median": round(st.median(per_mkt_gross), 4),
        "per_market_net_median": round(st.median(per_mkt_net), 4),
        "per_market_net_mean": round(m, 4),
        "per_market_net_sd": round(sd, 4),
        "t_stat_markets": round(m / (sd / len(per_mkt_net) ** 0.5), 2) if sd > 0 else None,
        "pct_markets_maker_profitable_net": round(
            100 * sum(1 for x in per_mkt_net if x > 0) / len(per_mkt_net), 1),
    }


def main():
    res = {"date": "2026-07-25",
           "question": "do Kalshi MAKERS profit? realized, on real trades vs real settlements",
           "method": "every executed trade has a known maker on the opposite side (taker_side is "
                     "published); settlement is known -> maker P&L is arithmetic, not simulation",
           "series": {}}
    for s in SERIES:
        r = analyse(s)
        if r:
            res["series"][s] = r

    rs = list(res["series"].values())
    g1 = sum(1 for r in rs if r["maker_gross_cents_per_contract"] > 0) >= 2
    g2 = sum(1 for r in rs if r["maker_net_if_maker_pays_fee"] > 0) >= 2
    g3 = sum(1 for r in rs if r["per_market_net_median"] > 0) >= 2
    res["gates"] = {
        "G1_maker_edge_gross": {"PASS": bool(g1),
                                "per_series": {r["series"]: r["maker_gross_cents_per_contract"] for r in rs}},
        "G2_survives_maker_fee": {"PASS": bool(g2),
                                  "per_series": {r["series"]: r["maker_net_if_maker_pays_fee"] for r in rs}},
        "G3_market_level_not_outlier": {"PASS": bool(g3),
                                        "per_series_median": {r["series"]: r["per_market_net_median"] for r in rs}},
    }
    res["gates"]["VERDICT"] = (
        "MAKER EDGE — positive gross AND net of the full maker fee, at the market level" if (g1 and g2 and g3)
        else "MAKER EDGE GROSS ONLY — real but smaller than the fee; viable only with a maker-fee waiver, which must be verified" if (g1 and not g2)
        else "NO MAKER EDGE — providing liquidity loses money here")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(res, f, indent=2)

    print("=== Do Kalshi MAKERS profit? (real trades, real settlements) ===\n")
    hdr = f"{'series':12} {'mkts':>5} {'trades':>8} {'contracts':>12} {'maker gross':>12} {'fee':>7} {'maker NET':>10} {'%mkts+':>7} {'t':>6}"
    print(hdr)
    for r in rs:
        print(f"{r['series']:12} {r['markets']:>5} {r['trades']:>8} {r['contracts']:>12,.0f} "
              f"{r['maker_gross_cents_per_contract']:>+11.3f}c {r['maker_fee_cents_per_contract']:>6.3f} "
              f"{r['maker_net_if_maker_pays_fee']:>+9.3f}c {r['pct_markets_maker_profitable_net']:>6.1f}% "
              f"{str(r['t_stat_markets']):>6}")
    print("\n(taker side is the mirror image: taker gross = -maker gross, then taker ALSO pays the fee)")
    for r in rs:
        print(f"  {r['series']:12} taker net after fee: {r['taker_net_after_fee']:+.3f}c/contract")
    print("\nGATES:")
    for k, v in res["gates"].items():
        if k != "VERDICT":
            print(f"  {k}: PASS={v['PASS']}  {list(v.values())[1]}")
    print(f"\nVERDICT: {res['gates']['VERDICT']}")
    print("->", OUT)


if __name__ == "__main__":
    main()
