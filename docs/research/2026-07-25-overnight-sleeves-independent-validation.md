# Independent validation of the overnight sleeve book: 2 sleeves are real, 4 are redundant

**Date:** 2026-07-25 · **Type:** Independent reproduction of shipped trading claims (#2940), on
real price history. **Read-only; no orders.**
**Artifact:** [`overnight_sleeves_validation.py`](../../experiments/overnight_sleeves_validation.py)
→ [`results`](../../experiments/results/overnight_sleeves_validation.json)
**Data:** Yahoo daily OHLC, full history — SPY 8,428 bars from 1993 (33.5y), QQQ 6,886 from 1999,
IWM 6,578 from 2000, GLD 5,453 from 2004.

## Why this was needed

PR #2940 ships an overnight book with specific quantitative claims — capitulation "+18bp/night,
t=3.5 over 30y", a bear-rally fade "−13bp (t=−2.1)", a book at "Sharpe 1.78, max DD −3.1%".
**No test in that PR asserts any of those numbers**, and neither the cited backtests (oracle ledger
`downtrend-decomposition-*`, `bandits-trader-*`) nor any experiment reproducing them exists
anywhere in the repository. The claims were unreproducible from the repo. This reproduces them
from scratch, with the gate math **ported verbatim** from `lib/overnight-trader.js` (parameter
lock: no tuning, no added filters).

## The baseline nearly everyone forgets

**Unconditional SPY overnight return: +3.27bp, t = 4.49, n = 8,427.**

This is the well-documented overnight anomaly — the equity premium accrues disproportionately
outside trading hours (Lou, Polk & Skouras, *A Tug of War: Overnight versus Intraday Expected
Returns*, JFE 2019, CRSP+TAQ). Our 33-year measurement independently confirms it exists.

**Every sleeve must beat +3.27bp, not zero.** A sleeve that returns +5bp overnight has not found
an edge; it has found a complicated way to be long at night.

## Result: excess return over simply holding overnight

| sleeve | raw bp | its baseline | **excess bp** | t | p |
|---|---|---|---|---|---|
| **capitulation SPY** | +13.59 | +2.47 | **+11.12** | +2.40 | 0.017 |
| **bear-rally fade SPY** | −8.64 | +3.92 | **−12.56** | **−2.11** | 0.035 |
| uptrend notflat SPY | +5.00 | +2.81 | +2.18 | +1.44 | 0.15 |
| uptrend notflat IWM | +5.40 | +4.41 | +0.99 | +0.42 | 0.67 |
| uptrend notflat GLD | +4.37 | +4.55 | **−0.18** | −0.07 | 0.95 |
| uptrend flat QQQ | +4.35 | +5.50 | **−1.15** | −0.57 | 0.57 |

### The two conditional sleeves are real signal

Both survive the correct baseline. The fade is the striking one: measured **t = −2.11** against a
claimed **t = −2.1** — the PR's own number, reproduced to two significant figures on independent
data. Capitulation reproduces at +13.6bp against a claimed +18bp (76% of claim, same sign, same
order of magnitude), and it is **not decaying**: first half +8.19bp, second half +18.98bp.

### The four uptrend sleeves add nothing

All four excesses are statistically indistinguishable from zero, and two are *negative*. GLD is
−0.18bp — literally nothing. These sleeves are an elaborate mechanism for capturing the
unconditional overnight premium that a plain "hold overnight" captures for free.

They are not *harmful* — they do earn +4 to +5bp — but the trend and vol-regime gating buys no
measurable improvement over holding. With `allocPct` spread across whichever sleeves fire, four
sleeves that add nothing **dilute allocation away from the two that do**.

## Honest limits on the positive result

- **Neither real sleeve clears the multiple-testing bar.** Harvey–Liu require |t| > 3.0 for a new
  factor claim; capitulation excess is t = 2.40 and the fade is t = −2.11. Against a *pre-specified*
  hypothesis those are respectable; as two of six tested sleeves they are not decisive.
- **The book's headline is still unreproduced.** Nothing here validates "Sharpe 1.78, max DD −3.1%".
  That requires a full portfolio backtest with position sizing and costs, which does not exist in
  the repo.
- **Costs are not modelled here.** These are gross overnight returns. A +11bp excess is real but
  thin — commissions, spread at the open auction, and slippage are unmodelled and could consume a
  large share of it. The published guidance that transaction costs commonly eat 20–40% of a
  backtested edge applies directly.
- **Yahoo daily data**, not survivorship-adjusted CRSP. Fine for index ETFs (no survivorship issue)
  but the open prints are as-reported, not audited.

## What follows

1. **The `edgeMinN` change in [#2947](https://github.com/alex-place/lantern-os/pull/2947) is
   corroborated.** The fade at t = −2.11 sits below the |t| > 3.0 bar — exactly the reasoning for
   raising its live-evidence requirement to ~330 nights.
2. **The uptrend sleeves should be justified or dropped.** They need to demonstrate excess over
   holding overnight, which on 33 years they do not. That is a proposal, not a change made here.
3. **Cost modelling is the next blocking measurement** for the two real sleeves — an 11bp gross
   edge may or may not survive the open auction.
