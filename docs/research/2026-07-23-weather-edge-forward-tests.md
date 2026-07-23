# Weather-edge forward tests — day-ahead FAILS, day-of breakeven, cross-venue lead (2026-07-23)

Three read-only backtests run against live venue data (no orders placed). Harnesses promoted to
`experiments/weather_*.js` — each is rerunnable as-is (network required; IEM + venue public data).
These are the first **oracle-vs-market** tests in the program; every prior weather backtest
(38.6%/30% RPS gains, n=723/730) was oracle-vs-*default-model*, a strictly easier bar.

## Grounded records

1. **[claim] The day-ahead MOS-only oracle does NOT beat the venue's own day-ahead close
   (UHLGA/ForecastEx) — certification FAILS; `certified:false` stands.**
   [evidence] `experiments/weather_forward_verify_uhlga.js`, 7 clean post-fit days (Jul 15–22
   2026, traded thresholds only): RPS oracle 0.2530 vs board 0.1774; hypothetical ≥5¢-edge
   trades −$1.68/unit gross. Two 5–6°F MOS regime misses (Jul 21/22) dominate — the market
   watches more models than NBS. [confidence] high (measured, executable-side, small n stated)
   [source] the run, 2026-07-23.
2. **[claim] The day-of nowcast (max-so-far ⊕ N(μ_day-of, σ_nowcast)) is FAIR-VALUE-grade but
   not an edge: breakeven against Kalshi executable prices, and the market absorbs the
   max-so-far ratchet by ~1pm ET.** [evidence]
   `experiments/weather_dayof_nowcast_kxhighny.js`, 14 settled KXHIGHNY days: 38 trades net of
   fees +$0.32 total; edge triggers 34@11am → 4@1pm → 0@3pm/5pm. Robust on the 5–6°F miss days
   where day-ahead blew up (+0.82/−0.10 vs −1.89/−1.99). [confidence] high for the efficiency
   finding; the ±0 P&L is consistent with zero edge [source] the run, 2026-07-23.
3. **[claim] Overnight information flow between venues is real and worth ~25¢/trade on overlap
   days — but the measured +$6.63 (7/7 days positive) Kalshi→ForecastEx result contains
   LOOK-AHEAD (fills at D-1 EOD close using morning-of Kalshi quotes) and is NOT an edge
   until re-run at same-time alignment with live FEX quotes.** [evidence]
   `experiments/weather_cross_venue_basis.js`: K→F +$6.63/26 trades, F→K −$1.09/18 — the
   fresh-info side wins, the stale side loses, symmetric = information flow, not mispricing.
   Realized station basis (each venue's own settle rule) Jun 1–Jul 22: **+1.48°F, σ=1.70°F,
   n=52**. [confidence] high for the structure; the exploitability is `experiment_required`,
   blocked on live UHLGA quotes (IBKR EC entitlement — operator action) [source] the run,
   2026-07-23.
4. **[claim] No live weather-trade ledger exists in git history — the remembered "14/14" is
   the settlement-formula verification (WU ≡ round(max METAR tmpf), 14/14 settled flips), not
   a trade record.** [evidence] `git log --all -S "KXHIGHNY" -- data/*` finds only docs/
   consolidation commits; the 14/14 provenance is
   `docs/research/2026-07-10-forecastex-uhlga-settlement-and-klga-fit.md`. [confidence] high
   [source] repo history search, 2026-07-23.

## Program state after these runs

| Strategy family | Verdict |
|---|---|
| Day-ahead board fading (any station) | dead — loses to the venue close |
| Day-of broad brackets | breakeven net of fees; market efficient by ~1pm ET |
| Day-of ≥100°F ceiling fade (original claim) | untested in isolation — needs an August heat window (one candidate day, Jul 15, netted −0.27 on generic brackets) |
| Cross-venue morning staleness (K→F) | the surviving lead — certify only with same-time live FEX quotes |
| Fitted oracle (KNYC/KLGA params) | repurposed: fair-value/risk layer (sizing, veto, alerting), demonstrably robust on regime-miss days |

## The lesson that transfers beyond weather

**Beating a default model ≠ beating the market.** Certification of any trading edge must be
market-relative at executable prices with fees — and where two data streams differ in freshness,
the "edge" must first be tested for look-ahead, because information flow masquerades as alpha.
The station-expansion leads (24 Kalshi temperature series, KXLOWT*, KXCPIGAS, KXFRM, KXAQICITY)
all keep their refit step, but inherit this market-relative certification bar.
