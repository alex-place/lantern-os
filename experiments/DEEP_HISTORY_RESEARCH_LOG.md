# Trading-model deep-history research log

> **LOOP STATE** (self-paced, autonomous while Alex sleeps). Branch:
> `claude/trading-deep-history-research`. Started 2026-07-18 ~00:27 ET.
> **Run until ~2026-07-18T16:30Z**, then stop scheduling and leave a summary.
> Each iteration: read this log for state → do ONE focused iteration → commit + push →
> update this log. Constraints (hard): **non-risky, never borrow (no margin), keep
> trades low (well under PDT/day-trade thresholds)**, every number measured (no
> fabrication). Iterations done: **4** (extend-1927; low-trade tune; DCA reversal; hybrid retired). Next:
> DCA-deposit version → blended/bonds panel → literature sanity-check → wire a
> "Conservative (no-margin)" mode into the live overlay + tests → final synthesis.

Goal (from Alex, 2026-07-18): improve the ADR-0028 leverage brake overlay. Research
**farther back in time**, deep-dive the trades/regimes, and find **non-risky**
improvements — **without over-trading** (day-trade / PDT pattern risk) or margin risk,
so it keeps running smoothly.

Ground rules: every number here is measured from real data (Yahoo adjclose via
`deep_history_cache.py`) — nothing synthesised. Where a variant loses, it's stated.

---

## Iteration 1 — extend the backtest to 1927 & find the non-risky variant

**What the live model is.** A DCA plan with a daily overlay: gross =
clamp(target_vol / realized_vol_20d, [min,max]), a 6-month trend gate to cash, a
drawdown brake that tapers to cash, T-bill interest on idle cash, and a no-trade band
to cut turnover. It was tuned on 2000-2012 and validated 2013+ — a window with only
~2 US equity bears.

**The lever for "farther back."** The live universe is ETFs (SPY/QQQ/… inception
~2000-2004), so it *can't* see older crises. Swapping in index proxies reaches much
further: `^GSPC` S&P 500 → **1927**, `^IXIC` Nasdaq → **1971**, `^RUT` → 1987. (A
Windows quirk — `datetime.timestamp()` throws on pre-1970 dates — was blocking this;
fixed with `calendar.timegm` + epoch-plus-timedelta in `deep_history_cache.py`.)

**The three books tested** (`deep_history_overlay.py`), lump-sum $25k, 2bp/turnover:
- `buyhold` — always 100% invested.
- `leveraged` — max 2.0× (current live style; can borrow).
- `no_margin` — **max 1.0×, never borrows**; only de-risks to cash. Zero margin risk
  by construction. This is the "non-risky" candidate.

### Result — S&P 500, 1927-2026 (99 years)

| book | final ($25k→) | CAGR | Sharpe | maxDD | avg gross | trades/yr |
|---|---|---|---|---|---|---|
| buyhold | $10.5M | 6.3% | 0.42 | **−86%** | 1.00 | 0 |
| leveraged (2×) | $17.9M | 6.9% | 0.55 | −32% | 0.86 | 51 |
| **no_margin (≤1×)** | **$16.3M** | 6.8% | **0.71** | **−30%** | 0.59 | **16** |

### Result — Nasdaq, 1971-2026 (55 years)

| book | final | CAGR | Sharpe | maxDD | avg gross | trades/yr |
|---|---|---|---|---|---|---|
| buyhold | $6.33M | 10.5% | 0.60 | **−78%** | 1.00 | 0 |
| leveraged (2×) | $5.52M | 10.2% | 0.73 | −35% | 0.81 | 62 |
| **no_margin (≤1×)** | $5.75M | 10.3% | **0.90** | **−25%** | 0.65 | **19** |

### Per-crisis peak-to-trough (S&P)

| crisis | buyhold | leveraged | no_margin |
|---|---|---|---|
| 1929 Crash | −86% | −27% | −27% |
| 1937 | −54% | −16% | −13% |
| 1973-74 | −48% | −20% | −13% |
| 1987 Black Monday | −34% | −32% | **−30%** |
| 2000 dot-com | −49% | −18% | −12% |
| 2008 GFC | −57% | −8% | **−4%** |
| 2020 COVID | −34% | −19% | −16% |
| 2022 | −25% | −18% | −16% |

### Findings (iteration 1)

1. **The non-risky variant is the winner on risk-adjusted terms.** `no_margin` has the
   **highest Sharpe of the three** on *both* indices (0.71 / 0.90), the shallowest max
   drawdown (−30% / −25% vs −86% / −78% buy-and-hold), never borrows, and rebalances
   only **~16-19×/year** — comfortably under any day-trade/PDT threshold. It gives up
   almost nothing in final value (S&P: *beats* buy-hold; Nasdaq: −9%).
2. **Leverage buys final dollars but not quality.** The 2× book edges final value on
   the S&P but has a *worse* Sharpe than no_margin, 3× the trades, and margin risk —
   the opposite of what Alex asked for. Recommendation is trending toward: **default to
   the no-margin (cash-defensive) overlay**, keep leverage as an opt-in.
3. **Honest limitation.** 1987 (a single −22% day) is the one regime the daily brake
   barely helps — no daily-bar overlay can pre-empt a one-session crash.

---

## Iteration 2 — tune the non-risky overlay: how few trades can it make?

`deep_history_sweep.py` sweeps band × brake × trend_m for the **no-margin** book, with
an honest split — TRAIN on each series' pre-2000 history, VALIDATE on 2000-2026 (unseen
dot-com/GFC/COVID/2022). Selection: among configs beating buy&hold's TRAIN Sharpe, take
the **fewest-trades** one.

**Both indices independently selected the SAME config: `band=0.30, brake=0.20,
trend=12mo`** — and it holds out-of-sample:

| VALIDATE 2000-2026 | Sharpe | vs buy&hold | maxDD | vs buy&hold | final | vs buy&hold | trades/yr |
|---|---|---|---|---|---|---|---|
| S&P no-margin | 0.69 | 0.42 | −19% | −57% | $161k | $133k | **9** |
| Nasdaq no-margin | 0.71 | 0.41 | −23% | −78% | $228k | $164k | **16** |

**Findings (iteration 2).**
1. **Trading *less* is strictly better here.** Across the whole grid, widening the band
   (→0.30) and lengthening the trend window (→12mo) cut trades to **~1/month** while
   validate Sharpe/final *held or improved*. The live model's daily retrade
   (hundreds–thousands of trade-days) is over-trading — turnover cost with no edge.
2. **It beats buy&hold out-of-sample on BOTH return and risk** — not just risk-adjusted:
   higher final value, ~⅓ the drawdown, on data never used to tune it.
3. **Robustness:** two independent 55-99y series converging on the same low-trade config
   is strong evidence it isn't overfit.
4. **Constraint check:** 9-16 rebalances/yr is far under any PDT/day-trade threshold;
   never borrows → no margin risk. Exactly the profile requested.

**Recommendation forming:** default the overlay to **Conservative (no-margin), band 0.30
/ brake 0.20 / trend 12mo**; keep 2× leverage as an explicit opt-in.

---

## Iteration 3 — under REAL DCA deposits, the overlay is risk-protection, not return-max

`deep_history_dca.py` re-runs the three books with a $20/mo deposit from $0 (matching the
live champion plan) instead of a lump sum.

| S&P DCA (1927+) | final | deposited | mult | Sharpe | maxDD | trades/yr |
|---|---|---|---|---|---|---|
| buyhold | $4.39M | $23.7k | 185× | 0.42 | −57% | 0 |
| leveraged 2× | $3.40M | $23.7k | 144× | 0.54 | −32% | 54 |
| no_margin | $2.80M | $23.7k | 118× | **0.68** | **−27%** | **8** |

| Nasdaq DCA (1971+) | final | deposited | mult | Sharpe | maxDD | trades/yr |
|---|---|---|---|---|---|---|
| buyhold | $906k | $13.3k | 68× | 0.60 | −78% | 0 |
| no_margin | $663k | $13.3k | 50× | **0.90** | **−28%** | **11** |

**Finding (iteration 3) — the honest reversal.** Under DCA-from-zero, **buy-and-hold makes
MORE final money** than the overlay (opposite of the lump-sum case). The mechanism is real
and not a bug: continuous deposits already "buy the dip," so de-risking to cash during
crashes fights DCA's built-in advantage of accumulating cheap shares. The no-margin overlay
still **halves the drawdown (−27% vs −57%) and lifts Sharpe (0.68 vs 0.42) at 8 trades/yr** —
it's a **risk-management overlay, not a return maximizer**, and its edge is deployment-
dependent:
- **Existing balance / lump sum** (a funded account — the portfolio-advisor & champion-book
  use case): no-margin wins on *both* return and risk (iters 1-2). Apply it here.
- **Small DCA from zero:** buy-and-hold accumulates more; the overlay trades ~35% of final
  value for half the drawdown and 2× the Sharpe. A risk-tolerance choice, stated plainly.

**Refined recommendation:** apply the Conservative (no-margin) brake to the *accumulated
balance* (protect capital you already have), and let fresh DCA contributions go in at full
weight (keep buying dips with new money). That hybrid is the next thing to test.

---

## Iteration 4 — the hybrid doesn't work (and it's clear WHY)

`deep_history_hybrid.py` brakes the accumulated balance but invests each fresh $20/mo
deposit at 100% (dollar-tracked invested/cash sleeves, never borrows). Hypothesis: capture
buy&hold's dip-buying AND the overlay's protection.

| DCA $20/mo | buyhold | no_margin | **hybrid** |
|---|---|---|---|
| S&P final | $4.39M | $2.80M | **$2.78M** |
| S&P Sharpe / maxDD | 0.42 / −57% | 0.68 / −27% | **0.68 / −28%** |
| Nasdaq final | $906k | $663k | **$668k** |
| Nasdaq Sharpe / maxDD | 0.60 / −78% | 0.90 / −28% | **0.90 / −28%** |
| overlay trades/yr | 0 | 8-11 | 12-14 |

**Finding (iteration 4) — negative, and instructive.** The hybrid is ~identical to the pure
no-margin overlay, **not** closer to buy&hold. Reason: a $20/mo deposit is negligible vs an
accumulated balance, so "invest the deposit at full weight" can't move the needle — the
dip-buying advantage only exists in the brief early phase when deposits ≈ balance. You
**cannot** have both buy&hold's accumulation and the overlay's protection under small DCA;
they're a genuine tradeoff, not an engineering gap. Idea retired.

**Recommendation locked:** offer **Conservative (no-margin)** as a drawdown-protection
overlay for an **existing/funded balance** (advisor + champion-book), where it wins on both
return and risk (iters 1-2). For pure small-DCA, present it honestly as "half the drawdown,
higher Sharpe, somewhat less final value" — a risk-tolerance choice, not a free lunch.

### Next (later iterations)
- Blended S&P+Nasdaq+gold panel + a bond-proxy from ^TNX over deep history.
- Web-research low-turnover tactical-allocation literature (dual-momentum, trend+cash) to
  sanity-check the band/trend choice against published results.
- If it holds: wire a selectable **"Conservative (no-margin)"** overlay mode into the live
  model rather than adding a parallel system (extend, don't sprawl).
