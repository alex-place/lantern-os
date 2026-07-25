# Market-data source picks — historical, live, and options (cheap-first)

**Date:** 2026-07-25 · **Status:** adopted (operator-requested /bandits pull) · **Total cost: $0/mo**

The trader's data needs, the source picked for each, and why — verified empirically this
session, not from vendor marketing. Upgrade paths listed for when a need outgrows free.

| Need | Pick | Cost | Verified how | Limits |
|---|---|---|---|---|
| **Underlying: historical + live bars** (stocks/ETFs) | **Yahoo (keyless)** — `lib/market-data-yahoo.js`, already integrated everywhere | $0 | powers every backtest in this arc (10y daily, ~1–2mo 15m) | intraday capped ~30–60d; occasional bad wicks (ADR-0029) |
| **Options: live chain + quotes** (shadow trader, UI) | **Alpaca indicative feed** (free tier of the existing broker keys) — chain snapshots + latest quotes | $0 | live probe: full SPY 5-leg ladder + penny strike with real bid/asks | indicative (estimated NBBO), 200 calls/min, no OPRA depth |
| **Options: HISTORICAL** (backtests) | **Alpaca historical option bars** (same free keys) — full OHLCV for any listed/expired contract since **2024-02** | $0 | pulled real 2025 SPY contract bars (o/h/l/c/volume, 3 days) on free keys; `scripts/options-hist-backtest.js` runs the overnight ladder/penny strategy on ~2.4y of real prices | bars only (no historical quotes/greeks on free); floor 2024-02; entry proxied by last trade of day |

## Rejected / deferred

- **DoltHub community options DB** (`post-no-preference/options`, free SQL API, 2019+):
  verified live — schema is good (bid/ask + greeks EOD) **but SPY carries only 2–6-week
  expirations; no next-day contracts**, so it cannot price the overnight 0–1DTE
  strategies. Kept in mind for longer-dated strategy research.
- **optionsDX** (free EOD chains, 2013+): real, but signup + manual quarterly ZIP
  downloads — not automatable by the trader. Backup if we ever need pre-2024 depth.
- **MarketData.app** (free tier: 1y history, greeks, 100 credits/day): credible, but
  requires an account/token and the credit budget is tiny for chain work. Candidate
  first paid step at $30/mo if greeks history becomes necessary.
- **ThetaData $80/mo · Alpaca Algo Trader Plus $99/mo (OPRA) · Polygon/Massive
  real-time $2.5k/mo · Intrinio $1k+/mo**: the upgrade ladder, in order, once a
  measured edge justifies paying — per the loop's rule, spend follows evidence.

## The rule this encodes

Every data need is served free until a **measured** edge demands better: quotes-level
historical fidelity (ThetaData) only if the bars-level backtest shows a real edge worth
refining; real-time OPRA ($99) only when a proven strategy actually trades options live.
