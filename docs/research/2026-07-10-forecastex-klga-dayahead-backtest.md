# ForecastEx UHLGA: day-ahead backtest of the KLGA oracle + forward paper-verification (#2217)

**Date:** 2026-07-10 · **Method:** retrospective DAY-AHEAD replay of the venue's public
board history + a wired nightly forward paper-verification job. Follows
[2026-07-10-forecastex-uhlga-settlement-and-klga-fit.md](2026-07-10-forecastex-uhlga-settlement-and-klga-fit.md)
§5 (the "forward verification" and "retrospective day-ahead backtest first" steps).

Evidence run on a GitHub Actions runner (the sandbox has no egress to the venue / IEM):
workflow `forecastex-backtest.yml`, results committed to `data/eval/` on the branch.

## TL;DR — the honest negative holds

1. **No robust edge is certified. `certified` stays `false`.** The apparent day-ahead P&L
   (+64.41 net over 224 settled cards) is a **liquidity artifact**: **92% of it (+59.93 over
   207 cards) comes from cards whose day-ahead close sat at a degenerate 0.00 or 1.00** — stale
   EOD prints on thin, deep-ITM/OTM winter contracts that are **not fillable at that price**.
   Fading them "wins" on paper but can't be executed.
2. **What survives the fill filter is 17 tradeable-ask cards (+4.48, 82% hit)** — encouraging in
   direction but **below the n≥20 certification floor, out-of-season, and still priced at EOD
   closes**. Not evidence of a tradeable edge.
3. **The window is entirely out-of-season for a summer-fit model.** The only day-ahead boards the
   venue published are **2026-02-12 → 2026-04-20** (68 days; settled highs **32–87 °F**). The
   KLGA oracle was fit on **summer (Jun–Aug)** KLGA data. No summer day-ahead boards were
   available to score, so the fit's own season is untested here.
4. **The ≥100 °F ceiling question remains completely untested** — the window never approached
   100 °F (max 87). Consistent with `ceilingSupport: []`; there is still nothing to certify a
   ceiling fade on for LGA.
5. **The oracle's DISTRIBUTION is nonetheless well-calibrated, even out-of-season.** On 55
   clean-settled days its day-ahead ladder RPS is **0.153 vs climatology 0.168** (positive skill),
   PIT χ²ᵣ **1.79** (calibrated), and it beats the venue's own board distribution on **39/55**
   days. The model produces sane distributions; it is the *tradeable-edge* claim that fails.

## 1. Method — the day-ahead protocol (avoids the same-day trap)

The venue publishes **EOD closes**, and a same-day close already knows the outcome (the §4 trap
in the fit note: "the robust edges it prints against EOD closes are artifacts"). So every contract
date **D** is scored with information available the **night before**:

- **Board:** the cumulative threshold board for D read from the **D-1** prices file (EOD closes on
  D-1) → a full-ℝ ladder (open-bottom, 1°F interior buckets folding across listing gaps, open-top)
  and its per-bucket YES price via cumulative differences (`lib/forecastex-dayahead.js`).
- **Forecast:** the **D-1** NBS MOS run (lead 1), station KLGA, rounded °F — identical to the live
  serve path (`lib/kalshi-mos.getForecastHighs("UHLGA")`).
- **Oracle:** the KLGA-fitted params via `loadVenueParams()` (σ/bias fitted; **NO_CEILING** stays
  non-binding because the fit carries no ceiling — verified in-run, `hasFittedCeiling=false`).
- **Settlement truth:** the venue's **own** published settlement flips (`settledHighs`). A clean
  flip (`minNo == maxYes+1`) pins the high exactly; unclean days grade only the buckets their
  bounds decide and are never guessed.
- **Scoring:** RPS/PIT (`lib/kalshi-weather-verify`) of the oracle vs (a) the **market's own**
  day-ahead board distribution on the same ladder — the baseline an information edge must beat —
  and (b) flat climatology; plus per-card realized P&L net of the flat 1¢ fee
  (`lib/forecastex-fees`).

One implementation is shared by the backtest and the nightly forward job, so they grade
identically (fit == serve).

## 2. Coverage

| | value |
|---|---|
| calendar days in range (Feb 3 – Jul 9) | 157 |
| price files present / missing | 159 / 0 |
| **day-ahead boards available** | **68 (all 2026-02-12 → 2026-04-20)** |
| settled dates / clean-settled (scored) | 68 / 55 |
| lead-1 MOS forecasts | 157 |
| settled-high range | 32–87 °F |

The venue listed day-ahead UHLGA boards only for a **~10-week late-winter/spring window**. After
2026-04-20 the D-1 files stop carrying the next day's board (thin/again-unlisted), so there is no
summer day-ahead history to replay. **This is the single most important caveat: the backtest is an
out-of-season stress of a summer model, not a test on its own turf.**

## 3. Calibration (n = 55 clean-settled days)

| metric | oracle | market (venue board) | climatology |
|---|---|---|---|
| mean ladder RPS | **0.153** | 0.360 | 0.168 |
| PIT χ²ᵣ | **1.79** (calibrated) | 22.15 (mis-calibrated) | — |
| oracle beats market (per-day RPS) | **39 / 55** | — | — |

The oracle is **better calibrated than the venue's own EOD board** and beats flat climatology —
even applied out-of-season. The market's PIT χ²ᵣ of 22 is itself a symptom of the degenerate
0/1 closes (see §4): those aren't real probabilities.

> **Caveat on the fixed-grid number.** The 70–110 °F integer-grid RPS (0.461) reported in the
> summary is **not comparable** to the fit's OOS reference (0.0356 fitted / 0.0508 default). Winter
> highs (32–55 °F) fall **below the 70 °F grid floor**, producing degenerate all-below-floor
> vectors that inflate RPS. Only the **per-day ladder RPS (0.153)** — scored on each day's actual
> board range — is meaningful across this out-of-season window.

## 4. Edges & P&L — the artifact, exposed

Cards are actionable only if the band-robust `robustEdgeReport` gate clears (side consistent across
the whole calibration band, worst-case net ≥ 5¢ after the 1¢ fee). Filled **at the D-1 EOD close**
(no spread/slippage/size — the only public price; this **overstates** fillable P&L).

| slice | cards | net P&L | hit rate |
|---|---|---|---|
| **all settled** | 224 | **+64.41** | 0.34 |
| degenerate ask (≤0.02 or ≥0.98) — **not fillable** | 207 | **+59.93** | 0.30 |
| **tradeable ask (0.02–0.98)** | **17** | **+4.48** | 0.82 |
| mid-band (0.10–0.90) | 15 | +3.63 | 0.87 |

**92% of the raw P&L is non-fillable.** Worked example (2026-02-12, forecast 35, settled 36): the
`<=32` bucket closed at **YES = 1.00** — the board implying "high > 32 °F is impossible" on a day
it settled 36. The oracle correctly faded it (fair 7.5%), NO side, "+99¢". But you cannot buy NO at
a 1.00 close on a thin deep-ITM winter contract; that print is stale, not an offer. The side split
makes the mechanism plain: **70 NO cards at ask≈1.00 → 90% hit, +53.01**; **154 YES cards at
ask≈0.00 → 8% hit, +11.40**. The "edge" is fading degenerate closes, not information.

Stripping them leaves **17 tradeable cards (+4.48, 82% hit)** — the right direction, but the sample
is (a) **below the n≥20 floor**, (b) **out-of-season**, and (c) **still fill-at-close**, not against
live executable quotes.

## 5. Verdict (External Reality Rule)

> **Does ANY robust edge survive forward, given there is no fitted ≥100 ceiling for LGA?**
> **No — not certifiably.** The headline P&L is a liquidity/staleness artifact of degenerate EOD
> closes on thin, **out-of-season** winter contracts; the fillable remainder (n=17) is too small,
> out-of-season, and still non-live. The ceiling is untested (max high 87 °F). **`certified`
> stays `false`.**

What IS established (kept, not overclaimed):
- The KLGA oracle emits **well-calibrated day-ahead distributions** even out of its fit season
  (ladder RPS 0.153 < climatology 0.168, PIT χ²ᵣ 1.79, beats the board 39/55). The Reason leg works.
- The full Observe→Reason→Verify pipe composes end-to-end on real venue history.

What this run forced into the code (Verify hardening):
- **Certification is degenerate-price-proof.** `forecastex-paper-verify` now certifies on
  **tradeable** cards only (ask strictly inside (0.02, 0.98)); a 0/1-close artifact can never trip
  `certifiedEdge`, no matter how positive the raw P&L looks. The backtest summary reports the same
  `tradeable` split. Regression test: 40 settled days of a +99¢ non-fillable card → `certifiedEdge:
  false`.

## 6. What remains before any UHLGA trade (updated)

1. **In-season forward evidence.** The nightly job (`FORECASTEX_PAPER_VERIFY=1`,
   `lib/forecastex-paper-verify.js`) must accrue **summer** settled days — the fit's own season —
   to n≥20 **tradeable** band-robust cards with positive tradeable P&L. The retrospective window
   never touched summer, so nothing here counts toward that.
2. **Live/executable prices.** Even in-season, EOD closes overstate fills. A real edge claim needs
   intraday quotes (the EC entitlement, #2216) or at minimum a fill model that rejects the
   degenerate closes this run exposed.
3. **Ceiling still open.** No ≥100 °F days in the record; the KNYC fade does not transfer as fitted
   and remains unmeasurable on LGA.
4. **Act path** stays absent (ADR-0019): no order code on this venue.

## Evidence classes

- **MEASURED:** coverage (68 boards, Feb 12–Apr 20); calibration (oracle RPS 0.153 / PIT 1.79 /
  39-55 vs market); P&L decomposition (92% non-fillable; 17 tradeable cards +4.48).
- **PROVEN (by construction):** day-ahead protocol (D-1 board + D-1 MOS); settlement from the
  venue's own flips; degenerate-price guard (unit-tested).
- **HONEST NEGATIVE:** no certifiable forward edge; ceiling untested; window is out-of-season.
- **UNIMPLEMENTED:** in-season forward accrual (job wired, not yet run through a summer); live
  quotes; any order path.
