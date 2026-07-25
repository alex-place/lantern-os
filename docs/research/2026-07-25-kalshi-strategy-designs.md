# Strategy designs from the literature, tested on our own settled data — one survives, two die

**Date:** 2026-07-25 · **Type:** Strategy design + out-of-sample tests. **Read-only; no orders.**
**Data:** 42 series, 10 categories, July 2026, 1.49M executed trades, settlement ground truth.
**Artifact:** [`kalshi_favorite_longshot_replication.py`](../../experiments/kalshi_favorite_longshot_replication.py)

## Where the designs came from

Web + corpus search for *documented* prediction-market edges surfaced one directly relevant
academic result: **Bürgi & Whelan, "Makers and Takers: The Economics of the Kalshi Prediction
Market"** ([CEPR DP20631](https://cepr.org/publications/dp20631) / GWU 2026-001), on 300,000+
contracts. Two claims, both testable on our independent sample:

1. **Both sides lose.** "Takers lose almost 32% on average, while makers have an average loss of
   about 10%."
2. **Favorite–longshot bias.** "Low-price contracts win far less often than required to break
   even, while high-price contracts win more often and yield small positive returns."

## Design 1 — passive liquidity provision (be the maker): **REFUTED, and now corroborated**

Already measured and killed earlier today: 0 of 6 out-of-sample weather cities positive, pooled
−1.61¢/contract, t = −3.92, Walk-Forward Efficiency **−1.41** against a 0.50 floor.

Bürgi & Whelan independently confirm it: **makers lose ~10% on 300k contracts.** Our refutation
was not a fluke of our sample — it is the published result. This design is dead, twice over.

## Design 2 — buy favorites: **REJECTED on decision-point sensitivity**

The paper's "high-price contracts yield small positive returns" looked like it replicated: at a
decision point 75% through a market's trade life, buying at 85–95¢ returned **+4.83¢/contract,
t = 2.33**. But moving the decision point destroys it:

| decision point | net ¢/contract | t |
|---|---|---|
| 25% through life | −0.34 | −0.08 |
| 40% | −2.58 | −0.63 |
| 50% | +1.64 | +0.55 |
| 60% | −1.52 | −0.46 |
| 75% | +4.83 | +2.33 |

The sign flips three times. An edge that exists only at the *latest* observation point is a
**settlement echo** — by then the market is largely resolved and the "forecast" is nearly free
information. Not tradeable. Rejected.

## Design 3 — fade the longshot: **SURVIVES every robustness check so far**

The other half of the FLB is the robust half. Buying cheap YES (1–15¢) loses at **every** decision
point tested:

| decision point | net ¢/contract to the BUYER | t | markets |
|---|---|---|---|
| 25% | −3.63 | −5.37 | 436 |
| 40% | −4.34 | −8.46 | 458 |
| 50% | −4.61 | −11.75 | 480 |
| 60% | −4.53 | −12.77 | 524 |
| 75% | −3.94 | −9.97 | 601 |

Contracts priced around 5¢ settle YES roughly **1%** of the time — a ~5× overpricing. That is the
classic longshot bias, it is stable across the market's whole life (not a settlement artifact),
and it matches the paper's finding that sub-10¢ buyers lose over 60% of their money.

**The trade:** in markets where YES is cheap, take the other side (sell YES / buy NO). Fees favour
it — Kalshi's fee is `0.07·C·P·(1−P)`, near-zero at the extremes (0.63¢ at 90¢), so the cost that
destroys mid-range strategies is smallest exactly here.

### Why this is still NOT a green light

**The risk shape is brutal and the expectancy hides it.** Selling a 5¢ longshot wins 5¢ about 99%
of the time and loses 95¢ about 1% of the time. That is picking up pennies in front of a
steamroller: positive expectancy, catastrophic negative skew, and a Kelly fraction so small that
realistic sizing makes the dollar return trivial. A single 1-in-100 event erases ~19 wins.

Unresolved before this could ever be traded:
- **Fill realism.** Can you actually get filled selling at 5¢ in size, or is the book thin exactly
  where the edge is? Unmeasured.
- **Base-rate confound.** Our sample is strike-ladder heavy (weather, crypto, spreads) where most
  strikes settle NO by construction. The edge must be shown to exceed what naive "always sell YES"
  earns — not yet isolated.
- **Tail sizing.** Requires an explicit Kelly/drawdown study before any size is chosen.
- **Correlated tails.** Ladder strikes on one event resolve together, so "1% of the time" losses
  arrive in clusters, not independently.

## The methodology error worth recording

The first version of this test found the **exact opposite** result — longshots +76%, favorites
−16.7%, Spearman −0.857 — and it was wrong. The bug was definitional: it bucketed **every trade
across a market's entire life**, so a contract that touched 90¢ mid-life and then collapsed
counted as a "favorite." Diagnostic: markets that traded ≥85¢ and settled NO had a median price
*range* of 93¢ and a **median final traded price of 1.0¢**. Those were peaks of dying markets, not
favorites at any decision point.

The tell was that the result contradicted a 300k-contract published paper. **When your analysis
contradicts established work, the prior is that you have a bug** — the fix was one decision per
market at a fixed point, and it reversed the entire conclusion.

## Status

| design | verdict |
|---|---|
| passive liquidity provision (maker) | **REFUTED** — ours + published |
| buy favorites | **REJECTED** — decision-point sensitivity |
| fade longshots | **CANDIDATE** — robust sign and significance; blocked on fill realism, base-rate isolation, and tail sizing |

No design here is cleared for capital. The one survivor is worth a fill-realism study and a
Kelly/tail analysis next — not an order.
