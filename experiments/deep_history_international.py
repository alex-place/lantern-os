"""Iteration 16 (Σ₀, LOOP 3) — the survivorship-bias test: does the brake work OUTSIDE the US?

Every prior iteration used the S&P/Nasdaq — markets that ALWAYS recovered. That is US
survivorship bias: a drawdown brake looks good partly because US equities eventually bounce.
The hardest external-reality test is a market that DID NOT recover for a generation:

  ^N225  Nikkei 225 (Japan) — 1980+, peaked ~38,900 on 1989-12-29, did not durably reclaim
         it until 2024 (a ~34-year round trip). Buy&hold there was a disaster.

Also FTSE / DAX / Hang Seng / CAC / All-Ords for breadth. For each: buy&hold vs the shipped
no-margin Conservative overlay (band0.30/brake0.20/12mo-trend, ≤1×). Then a focused Japan
"from the 1989 peak" run — if the brake is real risk management (not US-bounce luck), it must
have gone to cash through the long bear and vastly outperformed a Japanese buy&hold investor.
Honest if it fails anywhere. Measured from Yahoo adjclose; nothing synthesised.
"""
import json
import sys
from pathlib import Path

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).parent
import deep_history_cache as C
import deep_history_overlay as O

MARKETS = {
    "^N225": "Nikkei (Japan)",
    "^FTSE": "FTSE 100 (UK)",
    "^GDAXI": "DAX (Germany)",
    "^HSI": "Hang Seng (HK)",
    "^FCHI": "CAC 40 (France)",
    "^AORD": "All Ords (Australia)",
}
NR = dict(tv=0.20, trend_m=12, brake=0.20, min_gross=0.0, max_gross=1.0, band=0.30)
BH = dict(tv=0.0, trend_m=6, brake=9.9, min_gross=1.0, max_gross=1.0, band=0.0)


def load(sym):
    s = C.fetch_series(sym, 1980)
    days = sorted(s)
    px = np.array([s[d] for d in days], dtype=float)
    for i in range(1, len(px)):
        if np.isnan(px[i]):
            px[i] = px[i - 1]
    return days, px


def main():
    out = {}
    print(f"{'market':<22}{'window':<22}{'B&H Sh':>8}{'B&H DD':>8}{'nm Sh':>8}{'nm DD':>8}{'nm tr/yr':>9}")
    for sym, name in MARKETS.items():
        try:
            days, px = load(sym)
        except Exception as e:
            print(f"  {name}: FETCH FAIL {type(e).__name__}"); continue
        bh = O.run_overlay(days, px, **BH)
        nm = O.run_overlay(days, px, **NR)
        print(f"{name:<22}{days[0]+'..'+days[-1]:<22}{bh['sharpe']:>8.2f}{bh['maxdd']*100:>7.0f}%"
              f"{nm['sharpe']:>8.2f}{nm['maxdd']*100:>7.0f}%{nm['trade_days_per_yr']:>9.1f}")
        out[sym] = {"name": name, "range": [days[0], days[-1]],
                    "buyhold": {k: bh[k] for k in ("sharpe", "maxdd", "cagr", "final")},
                    "no_margin": {k: nm[k] for k in ("sharpe", "maxdd", "cagr", "final", "trade_days_per_yr")}}

    # Focused Japan: invest at/near the 1989 bubble peak (the survivorship-bias killer).
    days, px = load("^N225")
    peak_start = "1989-12-01"
    bh = O.run_overlay(days, px, start=peak_start, **BH)
    nm = O.run_overlay(days, px, start=peak_start, **NR)
    # also a "to 2010" window (before any recovery) to isolate the lost decades
    bh10 = O.run_overlay(days, px, start=peak_start, end="2010-01-01", **BH)
    nm10 = O.run_overlay(days, px, start=peak_start, end="2010-01-01", **NR)
    print(f"\n# JAPAN from the 1989 bubble peak ({peak_start})")
    print(f"  full to 2026:  buy&hold final ${bh['final']:,.0f} (CAGR {bh['cagr']*100:.1f}%, maxDD {bh['maxdd']*100:.0f}%)"
          f"  |  no_margin ${nm['final']:,.0f} (CAGR {nm['cagr']*100:.1f}%, maxDD {nm['maxdd']*100:.0f}%, {nm['trade_days_per_yr']:.1f} tr/yr)")
    print(f"  peak..2010 (lost decades): buy&hold final ${bh10['final']:,.0f} (maxDD {bh10['maxdd']*100:.0f}%)"
          f"  |  no_margin ${nm10['final']:,.0f} (maxDD {nm10['maxdd']*100:.0f}%)")
    out["japan_from_1989_peak"] = {
        "full": {"buyhold": {k: bh[k] for k in ("final", "cagr", "maxdd")},
                 "no_margin": {k: nm[k] for k in ("final", "cagr", "maxdd", "trade_days_per_yr")}},
        "to_2010": {"buyhold": {k: bh10[k] for k in ("final", "maxdd")},
                    "no_margin": {k: nm10[k] for k in ("final", "maxdd")}}}

    (HERE / "deep_international.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("\nwrote deep_international.json")


if __name__ == "__main__":
    main()
