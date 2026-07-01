"""
Σ₀ PROFITABLE-ONLY strategy for Kalshi KXHIGHNY (NYC daily-high) markets.

This is the gate the trader was missing: it turns the LIVE order book into cards,
and emits a card ONLY when a band-robust, net-of-fees, externally-grounded edge
survives — otherwise it emits NOTHING. An empty deck is the correct output on an
efficient day; that emptiness is the whole product (it is what separates a
disciplined book from the losing crowd).

The ONE defensible edge on this series is structural, not a bucket-vs-bucket σ
guess: the >=100 F CEILING. Central Park has not reached 100 F since 2012-07-18
(the 2019/2022/2025 heat waves all stalled at 99), so on an EXTREME-forecast day
(NWS high >= 100) a naive market over-prices ">=100" and we FADE it. On routine
days the liquid market is efficient and we stand down (verified: the engine now
returns "no certified edge" on the live routine board after the σ-band fix).

Input : markets.json  (live KXHIGHNY order book, pulled via the authenticated
        Kalshi client — apps/lantern-garage/lib/kalshi-api.js getMarkets()).
Output: profitable-only cards (JSON) + a per-day audit line. Zero cards is a
        valid, honest result.

Run:    node scratch/pull_all.js         # refresh markets.json (live asks)
        python experiments/kalshi_live_strategy.py markets.json
"""
from __future__ import annotations

import json
import re
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kalshi_weather_edge as w  # the calibrated model + robust net-of-fees gate

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# NWS gridpoint OKX 34,45 daytime highs, pulled 2026-06-30 (see research note).
# The strategy is only as live as this line — wire it to a live NWS pull before
# trusting it unattended (the open Observe handoff).
NWS_HIGH_F = {(7, 1): 96, (7, 2): 101, (7, 3): 102, (7, 4): 99, (7, 5): 91}
TODAY = date(2026, 6, 30)     # box date; lead_days is measured from here
MONTHS = {"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
          "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12}
MIN_EDGE_CENTS = 5.0
GROUNDING = ("NWS OKX gridpoint forecast + NWS Daily Climatological Report (KNYC) "
             "settlement + NWS 100-Degree-Days record (last 100F 2012-07-18)")


def parse_band(sub: str):
    """'100° or above' -> (100,None); '91° or below' -> (None,91); '94° to 95°' -> (94,95)."""
    s = sub.replace("°", " ").strip()
    m = re.search(r"(\d+)\s*(?:or above|and above|\+|or more)", s, re.I)
    if m:
        return (int(m.group(1)), None)
    m = re.search(r"(\d+)\s*or below", s, re.I)
    if m:
        return (None, int(m.group(1)))
    m = re.search(r"(\d+)\s*(?:to|-|–)\s*(\d+)", s)
    if m:
        return (int(m.group(1)), int(m.group(2)))
    return None


def high_date_from_ticker(ticker: str):
    m = re.search(r"KXHIGHNY-(\d{2})([A-Z]{3})(\d{2})", ticker)
    if not m:
        return None
    yy, mon, dd = int(m.group(1)), MONTHS.get(m.group(2)), int(m.group(3))
    if not mon:
        return None
    return date(2000 + yy, mon, dd)


def analyze(markets):
    by_day = {}
    for m in markets:
        d = high_date_from_ticker(m.get("ticker", ""))
        if d:
            by_day.setdefault(d, []).append(m)

    cards, audit = [], []
    for d in sorted(by_day):
        fc = NWS_HIGH_F.get((d.month, d.day))
        lead = (d - TODAY).days
        if fc is None:
            audit.append(f"{d} lead={lead}: no NWS forecast on record — SKIP (settling / out of range)")
            continue
        ladder, ask = [], {}
        for m in by_day[d]:
            band = parse_band(m.get("yes_sub_title") or m.get("subtitle") or "")
            ya = m.get("yes_ask")
            if band is None or ya is None:
                continue
            lbl = m["ticker"]
            ladder.append((lbl, band[0], band[1]))
            ask[lbl] = ya / 100.0
        if not ladder:
            audit.append(f"{d}: no parseable buckets — SKIP")
            continue
        rep = w.robust_edge_report(fc, lead, ladder, ask, d.month, d.day, MIN_EDGE_CENTS)
        audit.append(f"{d} lead={lead} NWS={fc}F σ={w.sigma_for_lead(lead):.2f} -> {rep['verdict']}")
        for r in rep["actionable"]:
            mk = next(m for m in by_day[d] if m["ticker"] == r["bucket"])
            cards.append({
                "date": str(d), "ticker": r["bucket"],
                "bucket": mk.get("yes_sub_title") or mk.get("subtitle"),
                "side": r["side"].upper(), "entry_price_c": r["ask_c"] if r["side"] == "yes" else round(100 - r["ask_c"], 1),
                "fair_pct": r["fair_pct"], "worst_net_edge_c": r["worst_c"], "best_net_edge_c": r["best_c"],
                "forecast_high_f": fc, "grounding": GROUNDING,
                "thesis": f"Fade >=100F ceiling: NWS {fc}F headline but calibrated fair {r['fair_pct']}%; "
                          f"Central Park last hit 100F on 2012-07-18.",
            })
    return cards, audit


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "markets.json"
    if not path.exists():
        print(f"markets.json not found at {path} — run scratch/pull_all.js first.")
        return 2
    markets = json.loads(path.read_text(encoding="utf-8"))
    cards, audit = analyze(markets)
    print("=== per-day audit ===")
    for a in audit:
        print("  " + a)
    print(f"\n=== PROFITABLE-ONLY DECK: {len(cards)} card(s) ===")
    if not cards:
        print("  (empty — no band-robust net-of-fees grounded edge is live. Correct: stand down.)")
    else:
        print(json.dumps(cards, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
