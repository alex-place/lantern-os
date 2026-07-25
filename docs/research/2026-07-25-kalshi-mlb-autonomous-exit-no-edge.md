# Kalshi KXMLBGAME, autonomous entry + exit: NO EDGE — and the arithmetic that forecloses it

**Date:** 2026-07-25 · **Type:** Research note — pre-registered backtest, negative result + a
hard cost bound that generalises.
**Status:** [measured — pilot, thin sample]. **No trades were placed; this is research only.**
**Artifacts:** [`kalshi_mlb_path_extract.py`](../../experiments/kalshi_mlb_path_extract.py) ·
[`kalshi_mlb_autonomous_exit_backtest.py`](../../experiments/kalshi_mlb_autonomous_exit_backtest.py)
→ [`results`](../../experiments/results/kalshi_mlb_autonomous_exit_backtest.json)

## Why this wasn't a re-chase of a refuted edge

The repo's prior Kalshi refutations are real and were respected: crypto 15M taker has no edge
after fees (−$48 / 6,209 trades, now code-enforced), day-ahead weather fails its market-relative
certification. But both covered *other market classes* and — the load-bearing point — both **held
to resolution**, which is exactly what produces the measured "+2¢ average win / −100¢ average
loss" profile. **Autonomous exits change the payoff shape and had never been tested.** The
available tight-band data is 100% `KXMLBGAME` (live baseball), a class never tested, and the only
data carrying the 6-second price *path* that makes exit testing possible at all.

## The result: the gates failed

Fade-a-sharp-move entry, autonomous exit (take-profit +3¢ / stop −4¢ / 15-min timeout), fills
crossing the spread both ways, Kalshi fee `ceil(0.07·C·P·(1−P))` charged on **both** sides,
market-level out-of-sample split:

| arm | n | mean net | win rate | t |
|---|---|---|---|---|
| in-sample fade | 104 | **−3.82¢** | 0.23 | −6.15 |
| **OOS fade** | 73 | **−5.37¢** | 0.16 | −6.22 |
| OOS random-entry control (same exits) | 90 | −5.59¢ | 0.00 | −34.2 |

**G1 (positive net) FAIL. G2 (beats random) FAIL** — the signal beats random entry by only
+0.22¢, well inside noise, and both are deeply negative. G3 (power) passed. **Verdict: NO EDGE.**

## Why — and this is the part worth keeping

The strategy was **structurally guaranteed to lose before it ever ran**, and the backtest merely
confirmed it. Measured from the real quotes, the **round-trip cost floor** — median spread paid
twice by crossing, plus the Kalshi fee on both sides — is:

| price band | median spread | fee ×2 | **round-trip floor** |
|---|---|---|---|
| 0–20¢ | 1.0¢ | 2¢ | **3.0¢** |
| 20–40¢ | 1–2¢ | 4¢ | 5–6¢ |
| **40–60¢** (where the volume is) | 1.0¢ | 4¢ | **5.0¢** |
| 60–70¢ | 3.0¢ | 4¢ | 7.0¢ |
| 80–100¢ | 1.0¢ | 2¢ | **3.0¢** |

The take-profit target was **3¢ against a 5¢ floor** at mid-range. Every "winning" trade was still
a net loss — which is precisely why the win rate is 0.16 while take-profits (35) and stop-losses
(36) fire about equally.

**Two consequences that generalise beyond this strategy:**

1. **The fee is U-shaped, so the extremes are the CHEAPEST place to round-trip**, not the most
   expensive. `0.07·P·(1−P)` peaks at 1.75¢/contract at P = 0.50 and vanishes at the tails, while
   the measured spread stays ~1¢ across bands. Floor is 3¢ at the tails vs 5¢ mid-range. (Note
   this does *not* reproduce the longshot spread premium of [arXiv:2604.24366](https://arxiv.org/abs/2604.24366)
   in this venue/sample.)
2. **For the median market in this sample, no taker round trip can profit at all — ever.** Median
   total price movement across a market's whole observed life is **3¢**, *below* the 5¢ mid-range
   floor. Only **27 of 79** markets move ≥10¢. Signal quality is irrelevant when the price cannot
   travel far enough to pay the toll.

## Honest limits

Thin pilot: 79 markets, a ~2-day window in which the two daily files cover **the same** markets
(so the split is market-level, not temporal), and **nothing resolved in-window** (all `active`),
so hold-to-resolution could not be scored as a baseline. This does not prove no edge exists in
KXMLBGAME — it shows the tested strategy has none, and establishes the cost floor any future
candidate must clear.

## The one honestly-untested lead

Everything above is **taker** — crossing the spread, paying the toll twice. A **maker** strategy
(resting limit orders) *earns* the spread instead of paying it, which moves the floor from about
+5¢ to roughly −1¢ + fees. That inverts the sign of the dominant cost term, and it is the class
the earlier no-taker-edge note explicitly left open ("a maker (limit/rebate) strategy … would need
separate proof"). It is **not** tested here and is **not** claimed to work — resting orders carry
adverse selection (you get filled exactly when you are wrong), which this data cannot measure
without trade-direction ground truth that the Polymarket microstructure result says an order-book
feed cannot reliably supply (~59% accuracy). Testing it needs fill-level data we do not have.
