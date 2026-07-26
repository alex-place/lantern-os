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

## Cross-family extension (same day, second pass) — and a bias it exposed

Extending beyond weather required discovering the real series universe (**10,190 non-parlay
series**) and probing candidates for settled depth rather than collecting blindly. Adding
KXMLBGAME (497 events) produced an apparently spectacular sports result — **+6.78¢, t=21.5** —
which did **not** survive checking:

**C8 truncation guard (the artifact).** The collector capped trades per market. Measured: **88% of
MLB markets hit that cap**, capturing a median of **1.6 hours** of markets that run up to **75
hours**. The captured slice was the *end of the game*, where the losing side genuinely is ~0% — so
the "edge" was a sampling artifact, not a market fact. Capped markets are now excluded from the
analysis (decision-point fractions are meaningless on a tail slice) and the collector paginates
40× deeper and records per-market completeness.

**C9 minimum-n generality gate.** The first cross-family verdict read "CROSS-FAMILY" off a family
with **3 events** (macro). A family now needs ≥30 independent events to count.

**Corrected cross-family picture** (post-guard):

| family | series | events | maker net | t | implied | actual |
|---|---|---|---|---|---|---|
| weather-temp | 10 | 200 | +1.96¢ | 3.09 | 6.4% | 3.9% |
| sports | 1 | 60 | +6.98¢ | 32.7 | 6.8% | 0.0% |
| macro | 2 | 3 | +4.39¢ | 2.64 | 2.9% | — (underpowered, excluded) |

**Verdict: PARTIAL — holds in 2 qualified families.** And the sports figure carries its own
selection caveat: after excluding 88% of MLB markets as truncated, the survivors are precisely the
*quiet* games, so that t=32.7 should be treated as unproven until a full-depth re-collection runs.

## Status

Design 3 moves from *plausible, not internally reproduced* → **reproduced on a corrected,
committed chain: longshot overpricing is robust in weather (200 events, t=3.09) and directionally
present in sports (60 events, selection-caveated); macro remains underpowered (3 events).
Adverse selection runs in the seller's favour. Generality is PARTIAL, not established.** The evidence bar for risking money is
unchanged: cross-family n, a fill model, and correlated-tail sizing must land first.

---

## Fill simulation (the last caveat) — the strategy DOES NOT SURVIVE

The earlier passes counted trades that happened and assumed we could have been the resting maker on
them. That assumption is the most common way a paper edge dies in production. It is now removed,
using **free public data**: Kalshi's `candlesticks` endpoint serves **1-minute yes_bid/yes_ask
OHLC**, which is enough to require that a real buyer existed at our price before we book a fill.

**Method** ([`kalshi_flb_fillmodel.js`](../../experiments/kalshi_flb_fillmodel.js), data via
[`kalshi_collect_candles.js`](../../experiments/kalshi_collect_candles.js), 103 markets / 417k
minute-candles): post a resting offer to sell 1 YES at the quoted ask; it fills **only** if a later
minute's `yes_bid` high reaches that price. Unfilled offers earn nothing and are counted.

| decision point | offers | fills | fill % | mean wait | net/fill | t | actual YES |
|---|---|---|---|---|---|---|---|
| 0.25 | 47 | 24 | 51% | 157 min | **−7.46¢** | −0.91 | 12.5% |
| 0.40 | 48 | 26 | 54% | 106 min | +3.46¢ | 1.32 | 3.8% |
| 0.50 | 50 | 32 | 64% | 125 min | +0.34¢ | 0.09 | 6.3% |
| 0.60 | 54 | 33 | 61% | 71 min | −0.31¢ | −0.05 | 3.0% |
| 0.75 | 59 | 29 | 49% | 140 min | +5.80¢ | 7.68 | **0.0%** |

**Verdict: DOES NOT SURVIVE fill simulation.** Three findings kill it:

1. **Only the latest decision point is positive-and-significant — and its statistic is
   degenerate.** At 0.75 all 29 fills settled NO, so P&L variance collapses and t=7.68 is an
   artifact of price jitter, exactly the C6 trap. With 29 fills a true 6% rate predicts ~1.7
   winners; observing 0 is unremarkable, not significant.
2. **"Works only at the latest observation point" is the same fragility that disqualified
   Design 2 (buy-favourites).** Applying our own standard consistently, it disqualifies this too.
3. **Half the offers never fill, and filled ones wait 1–2.5 hours.** Capital is committed while
   idle, so per-fill edge overstates the business: the `net_c_per_offer` column is roughly half the
   per-fill number even before that.

ForecastEx economics were checked as the friendlier venue (flat 1¢/contract embedded in the spread,
$0 IBKR commission, no maker/taker split — versus Kalshi charging even on resting fills). Its flat
cent removes another cent per fill, which does not rescue any point.

**Honesty limit:** queue priority, partial fills, and our own market impact are all ignored, and
each makes real fills *worse*. These simulated results are an **upper bound** — the true strategy
performs no better than the table above, and the table is already a failure.

---

## The favourite side — the one candidate still standing (underpowered, not proven)

Prompted to search the literature rather than keep grinding our own data, the academic synthesis
([QuantPedia](https://quantpedia.com/systematic-edges-in-prediction-markets/), ~20 studies) ranks
the documented edges by *retail accessibility*: inter-exchange arbitrage needs sub-second execution,
intra-exchange arbitrage is largely closed, and **only longshot bias remains "still live" with "no
special technology needed"** — expressed as **buying favourites**, not selling longshots.

That distinction is decisive against our own week's work: selling longshots is a **maker** trade
(needs someone to lift a resting offer; ~50% never filled), while buying favourites is a **taker**
trade — **fills are structurally certain**. The property that killed the previous candidate is
absent by construction.

**Two sampling corrections, both of which changed the answer** ([`kalshi_favorites_liquid.js`](../../experiments/kalshi_favorites_liquid.js)):

- **Real ask, not traded price** — a taker pays the ask. Measured gap: **+0.60¢**.
- **Liquid minutes only (volume > 0)** — sampling every quoted minute is dominated by stale asks in
  untraded markets, and produced *spurious significant negatives* (50–60¢ t=−2.60, 95–99¢ t=−5.48)
  that vanish once a real trade is required in the same minute. You cannot lift a quote nobody is
  honouring.

**Result** (553 markets, event-clustered, real asks, taker fees, liquid minutes):

| band | obs | events | avg ask | net/contract | t | actual |
|---|---|---|---|---|---|---|
| 50–60¢ | 46,945 | 120 | 54.0 | −3.25¢ | −0.94 | 46.9% |
| 60–75¢ | 21,799 | 120 | 65.9 | −2.99¢ | −0.84 | 59.3% |
| **75–85¢** | 4,259 | 115 | 79.4 | **+1.63¢** | 0.52 | 69.2% |
| **85–95¢** | 4,911 | 116 | 89.6 | **+2.60¢** | 1.40 | 79.9% |
| 95–99¢ | 2,878 | 106 | 96.6 | +0.72¢ | 0.52 | 94.7% |

**Verdict: directionally positive in the favourite bands, NOT statistically significant.** The
75–95¢ range nets +1.6 to +2.6¢/contract with t = 0.5–1.4 on ~115 events — the right sign, matching
both the literature and our own trades-based pass, but short of proof. At the observed variance,
roughly **double the events (~240)** would be needed to reach t≈2.

This is materially different from the eight refuted strategies: it is *underpowered*, not
*refuted* — the first candidate to end that way. It stays unarmed until the event count doubles.

---

## External grounding + the structural argument (why the extremes, and why Kalshi ≠ a bookmaker)

**The serious counter-argument, found and confronted.** [datagolf](https://datagolf.com/fav-longshot-not-a-bias)
argues the favourite–longshot bias is *not* a behavioural bias at all: in **bookmaker** markets it
falls out mechanically because bookmakers allocate roughly **equal absolute margin (~0.8–1% per
side) across all odds** (Pinnacle, 27,150 matches 2012–2020). Every participant is rational,
returns decline at long odds anyway, and — crucially — **all bets stay negative-EV**, favourites
merely less so. On that account the pattern is real but *unexploitable*, and the football evidence
agrees (favourites −3.64%, outsiders −26.08%: both losers).

**Why that critique does not transfer to Kalshi.** Kalshi is an **exchange**, not a bookmaker —
no house sets one-sided odds with an embedded margin — and its fee is `7·P·(1−P)/100` cents, a
**convex curve minimised at the price extremes**. Measured in our own data: **0.43¢ in the 90–97¢
band versus 1.74¢ mid-book — a 4× difference.** A small gross edge can therefore survive net at the
extremes while being eaten alive in the middle. The CEPR study of 300k+ Kalshi contracts reports
exactly the outcome the bookmaker model does *not* predict: high-price contracts yield **"small
positive returns" net of fees** — positive, not merely less negative.

**Decomposition of our own edge** ([`kalshi_fee_curve_decomposition.js`](../../experiments/kalshi_fee_curve_decomposition.js),
liquid minutes, real ask, event-clustered):

| band | events | gross | fee | **net** | t(net) |
|---|---|---|---|---|---|
| **5–15¢** | 119 | −4.26¢ | 0.55 | **−4.82¢** | **−4.18** |
| 15–30¢ | 120 | −0.12¢ | 1.19 | −1.30¢ | −0.52 |
| 30–45¢ | 121 | +0.24¢ | 1.62 | −1.39¢ | −0.50 |
| 45–55¢ | 119 | +3.16¢ | 1.74 | +1.41¢ | 0.49 |
| 55–70¢ | 120 | −1.43¢ | 1.67 | −3.09¢ | −0.86 |
| 70–80¢ | 118 | −0.58¢ | 1.38 | −1.91¢ | −0.55 |
| 80–90¢ | 117 | +2.30¢ | 0.91 | +1.38¢ | 0.52 |
| **90–97¢** | 114 | +3.43¢ | 0.43 | **+3.01¢** | **2.29** |

**Both tails behave as the theory predicts, with opposite signs, and the loser side is strongly
significant:** buying deep longshots loses **−4.82¢ (t=−4.18)**; buying deep favourites gains
**+3.01¢ (t=2.29)** where the fee is cheapest. The middle is noise.

**The caveat applied to ourselves: 8 bands were tested.** A single cell at t=2.29 does **not** clear
the Harvey–Liu |t|>3 bar for a new factor claim under multiple testing (Bonferroni-adjusted
p≈0.19). What is defensible is the *pattern* — a monotone-tailed signature predicted a priori by an
externally documented bias, with the fee curve explaining where it survives — not that one cell.

**Status unchanged: promising, not proven.** The strongest single number in the whole programme is
still the one that says *buying longshots reliably loses* (t=−4.18) — and the profitable mirror of
that requires being a maker, which the fill simulation already killed.
