# Kalshi: takers lose on every series, makers win gross on every series — and on weather the maker edge survives fees

**Date:** 2026-07-25 · **Type:** Research note — measured on real executed trades vs real
settlements. **No orders placed; read-only public market data.**
**Status:** [measured] for the taker/maker split · **[CANDIDATE — pre-registered gates FAILED]**
for the weather maker edge. Not a proven edge, and not deployable as-is.
**Artifacts:** [`kalshi_pull_settled_trades.ps1`](../../scripts/kalshi_pull_settled_trades.ps1) ·
[`kalshi_maker_vs_taker_settled.py`](../../experiments/kalshi_maker_vs_taker_settled.py) →
[`results`](../../experiments/results/kalshi_maker_vs_taker_settled.json)

## Why this measurement was possible at all

The earlier KXMLBGAME entry/exit pilot ended with one honestly-untested lead: the **maker** side.
A resting order *earns* the spread instead of paying it, flipping the sign of the dominant cost
term. I could not test it because it needs trade-direction ground truth, and the Polymarket
microstructure result ([arXiv:2604.24366](https://arxiv.org/abs/2604.24366)) shows an order-book
feed supplies that at only ~59% accuracy.

**Kalshi publishes `taker_side` on its public trade feed.** So every executed trade has a *known*
maker on the opposite side, and every settled market has a known `result`. Realized maker P&L is
therefore **arithmetic over trades that actually happened**, not a simulation:

```
V = 100c if result == 'yes' else 0c
taker bought YES at p  ->  maker sold YES  ->  maker P&L = p - V
taker bought NO  at p  ->  maker sold NO   ->  maker P&L = V - p
```

Data: 180 settled markets across 3 series, **1.49 M executed trades, 182 M contracts.**

## Result

| series | markets | trades | maker gross | fee | **maker NET** | % markets + | t |
|---|---|---|---|---|---|---|---|
| KXMLBGAME | 59 | 634,843 | +0.34c | 1.07 | **-0.74c** | 49.2% | 0.13 |
| KXBTC15M | 59 | 708,000 | +0.09c | 0.68 | **-0.58c** | 37.3% | -1.79 |
| **KXHIGHNY** (weather) | 59 | 148,499 | **+2.11c** | 0.74 | **+1.37c** | **79.7%** | 1.99 |

**Two findings, one solid and one candidate.**

**1. Solid — takers lose everywhere, and this now has settlement ground truth.** Taker net after
fee: MLB -1.41c, crypto -0.77c, weather -2.84c per contract. This confirms and *extends* the
repo's prior refutations to new market classes using real settled outcomes rather than quotes.
Makers earn positive gross in all three series, exactly as microstructure theory says liquidity
provision should.

**2. Candidate — on weather, the maker edge survives the full fee.** +1.37c/contract net, with
79.7% of individual markets profitable. **The most important implication for this repo: we have
been trading the wrong side of the weather market.** The prior work put the system on the *taker*
side of KXHIGHNY (day-ahead edge, which failed its certification); the same markets pay the
*maker* +1.37c while charging the taker -2.84c. That is a coherent explanation of the earlier
failure, not a contradiction of it.

## It is not the favorite-longshot bias

The obvious confound — that this is just selling cheap tails that expire worthless — does not
hold. Maker P&L is positive in **9 of 10 price buckets** (from +1.20c at 0-10c up to +6.59c at
80-90c) and on **both** taker directions (+1.04c when takers buy NO, +2.62c when they buy YES).
A pure longshot bias would concentrate in the cheap-YES buckets on one side only. This is
broad-based spread capture.

## Why I am NOT calling it an edge

**My pre-registered gates failed, and I am not rewriting them after the fact.** G2 (survives fee)
and G3 (market-level, not an outlier) both required **>= 2 of 3 series**; only one series passed.
Additional honest problems:

- **Multiple comparisons.** Three series tested, one significant at t = 1.99 (p ~ 0.05). With
  three tests, roughly a 1-in-7 chance of at least one such hit by luck alone.
- **The temporal split decays.** Early 30 markets +2.00c (t = 2.29); late 30 markets +0.74c
  (t = 0.58, not significant). The *sign* is stable — 80% of markets profitable in both halves —
  but the magnitude is not, and the out-of-sample half does not clear significance on its own.
- **Fill realism.** This measures what the *actual* makers earned. A new entrant competes for
  queue position and would not necessarily obtain the same fills at the same prices; realized
  fills for a newcomer are plausibly worse.
- **Scope.** 60 markets, one series, one venue, a ~2-week window.

## What would settle it (pre-registration for the next test)

1. **Fresh out-of-sample weather markets** — pull the next N settled KXHIGHNY markets *after*
   this window and score with these exact gates, unchanged. Sign *and* significance must hold.
2. **Verify the fee treatment.** I charged the maker the full taker-fee formula, which is
   conservative; if Kalshi waives or reduces maker fees the edge is the +2.11c gross figure.
   This must be confirmed against the live fee schedule before any sizing.
3. **Queue-position realism** — model fills as *partial* (a fraction of the observed maker
   volume) and re-check that the edge survives.

Until 1-3 land, this stays a **candidate**. It is worth exactly one thing right now: a
paper-traded, fee-verified maker experiment on KXHIGHNY, never a live deployment.
