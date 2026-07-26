# Favorite–longshot bias: the corrected backtest — signature REPLICATES, adverse selection is favourable, generality UNPROVEN

**Date:** 2026-07-25 · **Type:** rebuilt backtest (#2954). **Read-only; no orders placed.**
**Data:** regenerated from the Kalshi API — **1,228 single-event settled markets, 1,216,347 trades**,
12 series (10 weather + CPI + Fed), ~203 distinct events.
**Artifacts:** [`kalshi_collect_single_event.js`](../../experiments/kalshi_collect_single_event.js)
(collector, committed) · [`kalshi_flb_corrected.js`](../../experiments/kalshi_flb_corrected.js)
(analysis) · [`results/kalshi_flb_corrected.json`](../../experiments/results/kalshi_flb_corrected.json).
Raw data archived to `F:/lantern-os-archive/2026-07-25/kalshi-settled-single` (350 MB, gitignored).

## Why this exists

The 2026-07-25 strategy-designs doc claimed Design 3 "survives every robustness check" on
decision-point tables whose **code was never committed and whose source data is gone**, while the
committed script's own verdict was `DOES NOT REPLICATE`. This rebuild replaces both with a
reproducible chain and applies every correction the review demanded.

| # | Correction | Why it mattered |
|---|---|---|
| C1 | **Decision-point conditioning** | The old whole-life bucketing conditions on *ever traded cheap*; eventual winners nearly always pass through cheap prices → biased **for** longshots. It reported the low bucket at **+5.56¢ for the buyer** (wrong sign). |
| C2 | **Event-level clustering** | One event (e.g. `KXHIGHNY-26JUL27`) has ~12 bracket markets sharing ONE outcome. Clustering by market double-counts mirrors and inflates *t*. |
| C3 | **Maker-seller accounting** | The trade is to *sell* the cheap YES. We can only be filled as a maker when a **taker buys** — so only `taker_side=yes` trades are executable evidence. Maker fee ≈ 0 at these sizes (2026-07 schedule). |
| C4 | **No parlays** | `KXMVE*` are venue-constructed with designed margin and correlated legs — a different population. Excluded by allowlist **and** asserted per market. |
| C5 | **Adverse selection measured** | The load-bearing unknown: are the takers who buy longshots informed? |
| C6 | **Wilson CIs + degeneracy flags** | When every market in a bucket settles the same way, the P&L *t* explodes (t>30) on price jitter alone. That is an artifact; the honest statistic is the binomial CI. |

## Result 1 — the FLB signature replicates (and the old sign flip was the bug)

Buyer net per contract, event-clustered, taker fees, single-event only:

| bucket | events | trades | buyer net | t | settle YES |
|---|---|---|---|---|---|
| 1–5¢ | 203 | 191,784 | **−1.13¢** | −3.84 | 1.0% |
| 5–10¢ | 202 | 128,372 | **−1.72¢** | −2.25 | 4.6% |
| 10–15¢ | 202 | 90,241 | **−2.40¢** | −2.02 | 10.0% |
| 25–40¢ | 201 | 222,435 | −3.76¢ | −2.55 | 29.9% |
| 40–60¢ | 202 | 216,560 | +1.03¢ | 0.58 | 47.5% |
| 60–75¢ | 202 | 87,456 | +3.13¢ | 1.36 | 63.3% |
| 75–85¢ | 202 | 37,645 | +3.81¢ | 1.79 | 75.6% |
| 85–95¢ | 202 | 46,297 | +1.38¢ | 0.89 | 88.0% |
| 95–99¢ | 203 | 25,432 | +0.44¢ | 0.49 | 98.2% |

Both pre-registered gates pass: **longshot buyers lose, favourite buyers win** — the CEPR DP20631
(Bürgi, Deng & Whelan) signature, reproduced out-of-sample on our own data. Note the low bucket is
**−1.13¢** here versus **+5.56¢** under the old whole-life method: the correction flipped the sign,
confirming selection-on-ever-touching was the defect.

## Result 2 — the missing decision-point analysis, rebuilt

Selling cheap YES as a maker at a fixed fraction of each market's trade life, held to settlement:

| point | 1–5¢ | 5–10¢ | 10–15¢ |
|---|---|---|---|
| 0.25 | +1.6¢ | +3.8¢ (t 2.54) | −1.9¢ |
| 0.40 | +2.1¢ | +5.9¢ (t 6.58) | +10.0¢ (t 7.92) |
| 0.50 | +2.0¢ | +5.2¢ (t 4.94) | +9.0¢ (t 5.16) |
| 0.60 | +1.8¢ | +5.2¢ (t 6.70) | +8.6¢ (t 4.55) |
| 0.75 | +1.7¢ | +5.5¢ (t 6.31) | +8.9¢ (t 5.35) |

Positive at **every** decision point except 10–15¢ at 0.25 — i.e. it does *not* depend on a single
observation point, which is exactly the fragility that killed Design 2 (buy-favourites). The
overpricing is direct: at 0.75, the 1–5¢ bucket implies 1.8% but settles **0.0%, Wilson CI
[0.0, 0.7]** — the CI's upper bound sits below the implied probability.
**The 1–5¢ *t*-statistics are flagged `deg`** (degenerate): every market settled NO, so the CI, not
the *t*, carries the evidence.

## Result 3 — adverse selection runs *in our favour* (the reconciliation)

| who initiated | trades | maker net | t | implied | actual |
|---|---|---|---|---|---|
| **taker BUYS cheap YES** (we sell) | 222,484 | **+1.77¢** | 2.81 | 6.2% | **4.1%** |
| taker SELLS cheap YES (we buy) | 206,273 | +0.80¢ | 1.41 | 6.0% | 5.1% |

Takers who *buy* longshots are **more wrong than average** — the side we would be filled on is the
uninformed one. This reconciles the apparent contradiction with our own maker refutation: that
result was about **day-ahead weather fading**, a different trade, in a band where the fee peaks and
the informed flow is forecast-driven. Being the maker is not uniformly bad; it is bad *there* and
good *here*.

## What is NOT established

- **Generality is unproven.** 10 of 12 series are weather. KXCPI contributes **2 events**,
  KXFEDDECISION **1**. Any cross-family claim is unsupported.
- **Per-series, it is not uniform:** 9 of 12 positive, but only KXHIGHLAX (t 2.55), KXHIGHCHI
  (t 2.78), KXHIGHDEN (t 2.40) and KXCPI (t 4.74, n=2 events) clear t>2 — and **KXHIGHTATL
  (−0.60¢) and KXHIGHTDC (−0.67¢) are negative.**
- **Effective n is ~203 events**, not 1.2M trades. Weather brackets are ~12 markets per event and
  ~20 events per series; the trade count is not independent evidence.
- **Fills are assumed, not simulated.** We count trades that happened and assume we could have been
  the resting maker. Queue position and partial fills are unmodelled — the live probe
  (`kalshi_longshot_probe.js`) exists to measure exactly that, and remains unarmed.
- **Recent period only** (~last 10–20 trading days per series). No regime variation.

## Status

Design 3 moves from *plausible, not internally reproduced* → **reproduced on a corrected,
committed chain for weather markets in a recent window, with favourable adverse selection; not
established beyond that family, and not fill-validated.** The evidence bar for risking money is
unchanged: cross-family n, a fill model, and correlated-tail sizing must land first.
