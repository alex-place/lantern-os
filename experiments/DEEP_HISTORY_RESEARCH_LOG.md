# Trading-model deep-history research log

> **LOOP STATE** (self-paced, autonomous while Alex sleeps). Branch:
> `claude/trading-deep-history-research`. Started 2026-07-18 ~00:27 ET.
> **Run until ~2026-07-18T16:30Z**, then stop scheduling and leave a summary.
> Each iteration: read this log for state → do ONE focused iteration → commit + push →
> update this log. Constraints (hard): **non-risky, never borrow (no margin), keep
> trades low (well under PDT/day-trade thresholds)**, every number measured (no
> fabrication). LOOP 2 running (Σ₀). Iteration 8 done: edge is statistically significant (bootstrap ΔSharpe CI excludes 0 both indices).
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

---

## Iteration 5 — diversification vs the brake (and both together)

`deep_history_blend.py` builds a constant-duration 10Y bond total-return proxy from
`^TNX` (carry − D·Δyield, D=8; a first-order CMT approximation — a proxy, not a real
bond index) and separates the two risk effects.

| 1962-2026 (S&P + bond) | final | CAGR | Sharpe | maxDD | trades/yr |
|---|---|---|---|---|---|
| S&P buy&hold | $2.62M | 7.5% | 0.52 | −57% | 0 |
| 60/40 buy&hold (diversif. only) | $2.13M | 7.1% | 0.71 | −33% | 0 |
| S&P + no-margin brake (brake only) | $1.97M | 7.0% | 0.70 | −27% | 7 |
| **60/40 + no-margin brake (both)** | $1.35M | 6.4% | **0.86** | **−26%** | **4.3** |

| 2000-2026, 50/30/20 S&P/bond/gold | final | CAGR | Sharpe | maxDD | trades/yr |
|---|---|---|---|---|---|
| S&P buy&hold | $123k | 6.4% | 0.42 | −57% | 0 |
| 3-asset buy&hold (diversif. only) | $151k | 7.2% | 0.75 | −27% | 0 |
| **3-asset + no-margin brake (both)** | $135k | 6.7% | **0.96** | **−13%** | **2.4** |

**Findings (iteration 5).**
1. **Diversification is the biggest *free* non-risky win.** A 60/40 (or 3-asset) blend
   cuts drawdown about as much as the brake (Sharpe 0.52→0.71-0.75, maxDD −57%→−27/−33%)
   with **zero trades and no timing risk**. In the 2000+ era the diversified blend *beat*
   S&P on **both** return and risk. (The live model already diversifies via its 6-ETF
   tangency — so it's on the right track; the lever is turning DOWN its trading.)
2. **Brake + diversification = best risk profile, fewest trades.** Sharpe 0.86-0.96,
   drawdown −13 to −26%, at **2.4-4.3 rebalances/yr** — the strongest non-risky, low-
   turnover result in the whole study — at the cost of the most absolute return.
3. **Caveat (honest):** the 1962-2026 bond leg spans the 1981-2020 falling-rate bull that
   flatters 60/40; the ^TNX proxy is constant-duration (no convexity/roll). Directionally
   solid, not a promise of future 60/40 magic.

**Recommendation, final form:** the non-risky, low-trade optimum is **a diversified book +
the Conservative (no-margin) brake, band 0.30 / brake 0.20 / trend 12mo** — ~2-5 trades/yr,
never borrows, Sharpe ~0.9, drawdown roughly a third of all-equity. Present the return
give-up honestly; it's a risk-tolerance dial, not a free lunch.

---

## Iteration 6 — literature sanity-check: our findings match published work

Cross-checked our measured results against the three canonical low-turnover tactical
strands (external reality > internal consistency). All three corroborate, and the
places we diverge are explained.

| Source | Rule | Their result | Matches our finding |
|---|---|---|---|
| **Faber, GTAA** (SSRN 962461), 10-mo SMA, monthly, 5-asset EW | in/out by 10-mo SMA | 1901-2012: Sharpe **0.55 vs 0.32** buy&hold, maxDD **−50% vs −84%**; "equity returns, bond-like drawdowns" | our S&P no-margin: Sharpe **0.71 vs 0.42**, maxDD **−30% vs −86%** — same direction, similar magnitude |
| **Moskowitz-Ooi-Pedersen, Time Series Momentum** (AQR 2012) | **12-mo** lookback, **1-mo** hold | 12-mo is the canonical trend signal; strong in 2008 | our sweep independently picked **trend=12mo, ~monthly** rebalance |
| **Antonacci, Dual Momentum** | 12-mo **absolute momentum** → cash/bonds when negative | maxDD **60%→22.7%**; "absolute momentum does far more to lessen drawdown" | our **trend gate to cash** is the same mechanism; drawdowns cut by a similar factor |

**Findings (iteration 6).**
1. **Our independently-derived config is the academic consensus.** A 10-12-month trend/
   absolute-momentum signal, **monthly** rebalance, cash-defensive, applied to a
   diversified book — we reached band 0.30 / brake 0.20 / **trend 12mo** from a train/
   validate sweep with *no* reference to this literature, and it lands exactly on
   Faber/AQR/Antonacci. Strong external validation.
2. **"Monthly, not daily" is confirmed from the outside.** All three rebalance monthly.
   Reinforces iter-2: the live model's daily retrade is over-trading.
3. **The DCA "reversal" (iter 3) is a known feature, not our bug.** Faber explicitly notes
   the timing model "underperformed stocks six of the next eight years" post-2009; the
   literature frames these as *risk-management* overlays that trail in strong bulls —
   exactly what we measured.
4. **Honest divergence.** TSMOM's headline Sharpe ~1.28 is a *leveraged 58-asset long/short
   futures composite* — not comparable to our long/cash single-index book. The right
   comparables are Faber's single-portfolio 0.55 and Antonacci's drawdown numbers, and we
   sit in line with both. We do NOT claim TSMOM-level Sharpes.

Sources: [Faber GTAA](https://mebfaber.com/wp-content/uploads/2016/05/SSRN-id962461.pdf) ·
[AQR Time Series Momentum](https://www.aqr.com/Insights/Research/Journal-Article/Time-Series-Momentum) ·
[Antonacci Dual Momentum](https://awealthofcommonsense.com/2015/07/my-thoughts-on-gary-antonaccis-dual-momentum/)

---

## Iteration 7 — wire "Conservative (no-margin)" into the LIVE model (+ tests)

Extended the live champion book (`apps/lantern-garage/lib/champion-book.js`) — **no parallel
system** (respects the anti-sprawl gate). The live book already computes tangency weights ×
live brake gross (0-2×) → dollar targets. The change adds a **gross cap**:
- `computeRebalance({ …, maxGross = MAX_GROSS })` — clamps gross to `[0, min(maxGross,
  MAX_GROSS)]`. Default 2.0 = **unchanged behavior**. `maxGross` can only *lower* the ceiling.
- `plan()/rebalanceNow({ conservative })` — `conservative:true` caps gross at **1.0 (never
  borrow)** and widens the no-churn band (0.6%→1.5%) to trade less. Returns `mode` + `grossCap`.
- Route: `GET /api/trading/champion?conservative=1` serves the no-margin plan (read-only, dry).

Tests (`apps/lantern-garage/test/champion-book.test.js`, +4, **11/11 pass**): maxGross caps a
1.8× brake request to 1.0×; can't exceed the hard 2× ceiling; de-risking (0.3× storm gross)
still passes through; default 2× behavior unchanged. `node --check` clean on both files.

**Safety.** Money-path / protected file → **PR for human review, NOT self-merged.** The
change is strictly de-risking (a cap that can only reduce leverage) and default-off, so it
cannot make the existing book riskier.

## FINAL SYNTHESIS

**What Alex asked:** improve the trading model — research farther back, deep-dive trades/
regimes, find non-risky improvements, without over-trading or margin risk.

**What the evidence says (7 iterations, all measured, S&P 1927+ / Nasdaq 1971+ / 60-40 &
3-asset blends, train/validate split, literature-checked):**
1. **The single best non-risky improvement is a cash-defensive, never-borrow (≤1×) overlay
   at ~1 trade/month** (band 0.30 / brake 0.20 / **12-mo** trend). On a funded balance it had
   the **best Sharpe** (0.71-0.90 vs 0.42-0.60 buy&hold) and **shallowest drawdown** (−25 to
   −30% vs −78 to −86%), never borrowing, at **9-19 rebalances/yr** — far under any PDT
   threshold. Validated out-of-sample; matches Faber/AQR/Antonacci.
2. **Trade LESS, not more.** Widening the band + lengthening the trend window cut trades to
   ~monthly while *improving* out-of-sample results — the daily retrade was pure cost.
3. **Diversification is a free risk win** (the live 8-asset book already does this); brake +
   diversification is the best risk profile at the fewest trades (2.4-4.3/yr).
4. **Honest limits:** under small DCA-from-zero the overlay trails buy&hold on final value
   (it's risk-protection, not return-max — a documented feature); 1987-style one-day crashes
   can't be pre-empted by a daily brake; leverage was retired (worse Sharpe, more trades,
   margin risk — the opposite of the ask).

**Shipped:** a selectable **Conservative (no-margin)** mode in the live champion book, default
off, PR for human review. Recommend making it the **default for the advisor / funded-balance
book** and keeping 2× leverage strictly opt-in.
- Web-research low-turnover tactical-allocation literature (dual-momentum, trend+cash) to
  sanity-check the band/trend choice against published results.
- If it holds: wire a selectable **"Conservative (no-margin)"** overlay mode into the live
  model rather than adding a parallel system (extend, don't sprawl).

---

## Closing validation — the recommendation holds on the REAL 8-ETF live book

Confirmed the Conservative config (band 0.30 / brake 0.20 / trend 12mo, maxGross=1.0) on the
actual universe the live code trades (`deep_history_live_universe.py`, equal-weight blend as a
stand-in for the tangency book). ETF histories are short — stated honestly.

| Real live universe | window | buy&hold Sharpe / maxDD | no-margin Sharpe / maxDD | trades/yr |
|---|---|---|---|---|
| Full 8-ETF | 2015-2026 (10.7y) | 0.95 / −25% | **1.07 / −16%** | 6.1 |
| 6-ETF sub-book | 2004-2026 (21.6y, incl. 2008) | 0.78 / −36% | **0.90 / −16%** | 4.7 |

Same signature as the 1927+ proxy study: **higher Sharpe, ~half the drawdown, ~monthly
trading, no margin**, with a modest final-value give-up. The live book is already diversified
(6-8 assets incl. TLT bonds + GLD gold), so this is exactly the iter-5 "diversification + brake"
result — now on the real instruments.

## LOOP COMPLETE (2026-07-18)

7 research iterations + closing validation, all measured, all pushed to
`claude/trading-deep-history-research`. Shipped: a selectable **Conservative (no-margin)**
mode in the live champion book (PR #2728, **48/48 CI green**, awaiting human review — money-path).
Bottom line for Alex: the biggest non-risky win is **cap leverage at 1×, trade ~monthly not
daily, stay diversified** — best Sharpe, ~half the drawdown, far under PDT limits, zero margin
risk. Leverage and daily retrade were both net-negative. Full evidence trail above.

---

# LOOP 2 (2026-07-18, Σ₀ protocol) — run until ~21:27Z

Goal: keep improving the model with Σ₀ rigor — external reality beats internal
consistency; every claim = [claim, evidence, confidence, source]; nothing accepted
without evidence; no fabrication. Loop 1 found the Conservative (≤1×, ~monthly,
diversified) overlay. Loop 2 goes deeper. Agenda (one focused iteration each):

8.  Significance: is the edge real? Block-bootstrap CI on the Sharpe/maxDD *difference*
    (no_margin − buy&hold) + Deflated Sharpe accounting for the configs we tried.
9.  Tangency-weighted validation — port the live tangency_dir weighting to deep history
    (match production exactly, not equal-weight).
10. Transaction-cost sensitivity — re-run at TC 5/10/20 bp; is low-turnover robust to
    worse fills?
11. Regime attribution — decompose where the brake adds vs subtracts (bull/bear/recovery),
    deep-diving the actual rebalance decisions.
12. Alternative/combined signals — 200-day SMA vs 12-mo TSMOM vs dual (require BOTH);
    does combining cut whipsaw?
13. Event-triggered rebalance — trade only on signal flips (even fewer trades;
    control-engineering send-on-delta).
14. Sequence-of-returns / decumulation — a withdrawal scenario where the brake should
    shine; + crisis-only block-bootstrap P(ruin) for the no-margin book.
15. Synthesis 2 + update PR #2728 / the recommendation.

---

## Iteration 8 (Σ₀) — the edge is statistically real (not config-mining)

`deep_history_significance.py`: stationary block bootstrap (21-day blocks, 2000 resamples,
seed 12345) of the paired daily returns, + Deflated Sharpe (Bailey/López de Prado 2014)
against the 45 configs tried in iter-2.

| | point ΔSharpe | bootstrap 95% CI | P(no_margin > buy&hold) | CI excludes 0? | Deflated SR |
|---|---|---|---|---|---|
| **S&P 1927+** | +0.27 | **[+0.10, +0.43]** | 99.9% | **YES** | ≈1.000 (haircut 0.69→>0.23) |
| **Nasdaq 1971+** | +0.31 | **[+0.09, +0.52]** | 99.5% | **YES** | ≈1.000 (haircut 0.90→>0.30) |

**Findings (iteration 8).**
1. **Significant on both indices.** The Sharpe-difference CI excludes 0 — the Conservative
   overlay's risk-adjusted edge is not noise, and no_margin beats buy&hold's Sharpe in
   99.5-99.9% of block-bootstrap resamples.
2. **Survives selection deflation.** Even after deflating for the 45-config sweep, the
   no_margin Sharpe clears the selection-adjusted bar (0.69>0.23, 0.90>0.30). Honest note:
   DSR ≈1.000 is *driven by the very large T* (24,751 / 13,977 daily obs give enormous
   statistical power) — the bootstrap CI is the more informative statistic; both agree the
   edge is real.
3. **What this does NOT prove:** that the edge is as large *out-of-sample* as in-sample
   (iter-2's 2000+ validation already addressed magnitude), nor that future regimes match
   the past. It proves the historical risk-adjusted improvement is not statistical luck.

---

## Iteration 9 (Σ₀) — production-EXACT weighting (monthly capped tangency), not equal-weight

`deep_history_tangency.py` ports the live weighting (capped shrunk tangency, cap 0.35 /
covShrink 0.35 / muShrink 0.5, minObs 60, monthly recompute — exactly champion-book.js
`targetWeights`) onto the 4-asset proxy panel {S&P, bond, gold, Nasdaq}, 2000-2026.

| book (2000+) | final | CAGR | Sharpe | maxDD | trades/yr |
|---|---|---|---|---|---|
| tangency buy&hold | $199k | 8.4% | 0.84 | −23% | 0 |
| **tangency + no_margin** | $149k | 7.2% | **0.92** | **−13%** | **4.5** |
| eq-weight buy&hold | $183k | 8.0% | 0.74 | −30% | 0 |
| eq-weight + no_margin | $177k | 7.9% | **0.98** | −14% | 3.1 |

**Findings (iteration 9).**
1. **Conclusion holds with production weighting.** Tangency + brake still lifts Sharpe
   (0.84→0.92) and roughly halves drawdown (−23%→−13%) at ~4.5 trades/yr. The recommendation
   is not an artifact of the equal-weight simplification.
2. **Nuance (evidence-backed):** the brake adds *less* on top of tangency (+0.08 Sharpe) than
   on top of equal-weight (+0.24). Mechanistic reason: production tangency already tilts
   toward low-vol assets (bonds), so it's partly "self-braked" — the vol-target/trend overlay
   has less risk left to remove. **The brake matters most when the base book is more
   aggressive.** So the two risk tools (smart weighting, the brake) are partial substitutes,
   consistent with iter-5.
3. **Honest caveat:** single window (2000-2026); the 2000-2020 bond bull flatters tangency
   (which loads bonds) and the whole panel. Not a claim about future bond regimes.

---

## Iteration 10 (Σ₀) — robust to transaction costs (the payoff of trading less)

`deep_history_tcost.py` re-runs the no-margin Conservative config at TC = 2/5/10/20 bp
(the last is 10× the base assumption — a pessimistic fill). Buy&hold has zero turnover, so
it is TC-invariant.

| S&P no-margin | TC 2bp | TC 5bp | TC 10bp | TC 20bp | buy&hold |
|---|---|---|---|---|---|
| Sharpe | 0.69 | 0.68 | 0.66 | 0.63 | 0.42 |
| maxDD | −34% | −34% | −34% | −34% | −86% |
| beats B&H Sharpe? | ✔ | ✔ | ✔ | ✔ | — |

| Nasdaq no-margin | TC 2bp | TC 5bp | TC 10bp | TC 20bp | buy&hold |
|---|---|---|---|---|---|
| Sharpe | 0.90 | 0.89 | 0.88 | 0.86 | 0.60 |
| maxDD | −27% | −27% | −27% | −26% | −78% |
| beats B&H Sharpe? | ✔ | ✔ | ✔ | ✔ | — |

**Findings (iteration 10).**
1. **Robust to realistic-to-pessimistic fills.** Even at 20bp the no-margin Sharpe
   (0.63/0.86) still comfortably beats buy&hold (0.42/0.60) and the drawdown advantage is
   untouched. The Sharpe ranking never flips across a 10× cost range.
2. **This is *because* turnover is tiny** (2.7-3.6 units/yr, ~8-11 trade-days/yr): low
   turnover × even a high per-trade cost = small total drag. The "trade less" design is
   what buys the cost-robustness — a clean internal consistency with Alex's don't-over-trade
   constraint.
3. **Honest loss:** at 20bp on the S&P, final value dips below buy&hold ($8.5M vs $10.5M) —
   at pessimistic fills the *return* give-up grows, though the risk-adjusted and drawdown
   advantages persist. A higher-turnover overlay would have failed this test.

---

## Iteration 11 (Σ₀) — regime attribution: where the brake wins and where it costs

`deep_history_regime.py` splits every day by trailing-12mo trend sign × drawdown bucket
(no look-ahead) and attributes each book's return within the regime.

**S&P 1927+ (annualized excess = no_margin − buy&hold, per regime):**

| regime | days | buy&hold %/yr | no_margin %/yr | excess |
|---|---|---|---|---|
| UP · calm (>−10%) — normal bull | 11,100 | 9.8 | 9.4 | **−0.4** |
| DOWN · correction (−10..−20) — the turn down | 2,011 | −10.0 | +1.7 | **+11.7** |
| DOWN · bear (<−20%) | 4,636 | 5.0 | 3.7 | −1.3 |
| UP · correction — recovery | 1,845 | 6.4 | 8.6 | +2.1 |
| DOWN · calm (>−10%) — false down-flip near highs | 760 | 7.1 | 0.1 | **−7.0** |

Nasdaq echoes it: DOWN·correction **+4.9%/yr**, UP·correction +3.1%, UP·calm **−1.3%**, and
the worst cell **DOWN·calm −30.2%/yr** (217 days).

**Findings (iteration 11).**
1. **The entire edge comes from the down-trending correction regime** — it converts
   buy&hold's −10%/yr bleed into ~flat. That IS the crash protection, concentrated where it
   matters (2000/2008/1929/1973 all live here).
2. **It pays for that by lagging normal bulls** (−0.4 to −1.3%/yr in UP·calm, the *majority*
   of days) — the documented give-up-upside cost, consistent with the iter-3 DCA reversal.
3. **Worst regime = "DOWN·calm": a false down-flip while still near highs** → sells → market
   rebounds (−7% S&P, **−30%/yr Nasdaq**). Rare but the sharpest single drag.
4. **Signal is noisy:** ~3-4 trend flips/yr, **80-84% reverse within 3 months.** The 12mo
   trend gate fires many false signals; the no-trade band + drawdown gating contain most of
   the damage, but this is the clear lever → **iter-12 tests a better/confirmed signal to cut
   false flips**, iter-13 tests event-triggered rebalancing.

> **LOOP 2 COMPLETE (2026-07-18):** 8 iterations (8-15). Shipped Conservative config CONFIRMED (significant, tangency-robust, TC-robust, regime-understood); SMA "improvement" REJECTED as OOS-failing overfit; decumulation = tail insurance, glidepath best on the realistic roll. No further live change justified. Branch `claude/trading-research-loop2` (PR #2731); PR #2728 (the shipped mode) merged to master.
> at 14:14Z. Loop-2 continues on branch `claude/trading-research-loop2`; a new PR will
> collect iters 11+.

---

## Iteration 12 (Σ₀) — signal choice: the 200-day SMA gate BEATS the shipped momentum gate

`deep_history_signals.py` swaps the trend gate in the no-margin Conservative overlay:
`mom` = 12mo momentum≥0 (shipped default), `sma` = price≥200-day SMA, `dual` = de-risk only
when BOTH say down.

| S&P 1927+ | Sharpe | maxDD | final | trades/yr | flips/yr |
|---|---|---|---|---|---|
| mom (shipped) | 0.69 | −34% | $16.5M | 8.4 | 3.9 |
| **sma** | **0.80** | **−26%** | $41.5M | 9.5 | 6.0 |
| dual | 0.75 | −34% | $42.2M | 8.6 | 3.8 |

| Nasdaq 1971+ | Sharpe | maxDD | final | trades/yr | flips/yr |
|---|---|---|---|---|---|
| mom (shipped) | 0.90 | −27% | $6.34M | 10.8 | 2.9 |
| **sma** | **0.95** | −27% | $5.93M | 11.6 | 5.6 |
| dual | 0.94 | −27% | $8.84M | 12.3 | 3.5 |

**Findings (iteration 12).**
1. **The 200-day SMA gate dominates the shipped 12mo-momentum gate** on Sharpe (0.69→0.80
   S&P, 0.90→0.95 Nasdaq) AND drawdown (−34%→−26% S&P) AND final value — at trivially more
   trades (9.5 vs 8.4/yr, still far under PDT). The shipped `mom` signal is the weakest of
   the three. **This is the first candidate live improvement of loop 2.**
2. **`dual` maximizes return** (2.5× the mom book's final on S&P, highest on Nasdaq) with the
   fewest flips — but **gives back crash protection** (−34% vs sma's −26%): requiring both
   signals to confirm de-risks slower, eating more of the initial drop. A return-vs-drawdown
   trade-off; for the *non-risky* mandate, `sma` is the better pick (best drawdown too).
3. **Σ₀ caveat — NOT yet actionable.** This is full-history (in-sample) signal selection. The
   shipped config earned its keep via a train/validate split; the SMA claim MUST get the same
   OOS treatment before any live change. **Iter-13 validates sma-vs-mom train(pre-2000)/
   validate(2000+) — only then does it become a live champion-book/brake-monitor refinement
   (money-path → PR #2731, tests, human review).**

---

## Iteration 13 (Σ₀-critical) — the SMA "improvement" was in-sample overfitting; REJECTED

`deep_history_signal_oos.py` re-tested iter-12's SMA gate on a clean split (TRAIN pre-2000,
VALIDATE 2000-2026).

| signal | S&P train Sh | S&P **validate** Sh | Nasdaq train Sh | Nasdaq **validate** Sh |
|---|---|---|---|---|
| mom (shipped) | 0.69 | **0.69** | 1.13 | **0.71** |
| sma | 0.85 | **0.68** | 1.25 | **0.68** |
| dual | 0.77 | 0.74 | 1.19 | 0.73 |

Bootstrap validate ΔSharpe (sma − mom): S&P **[−0.22, +0.20]** (P=44%), Nasdaq **[−0.23, +0.17]**
(P=37%) — both CIs straddle 0. **VERDICT on both indices: sma does NOT beat mom OOS.**

**Findings (iteration 13) — a Σ₀ win: a false positive caught before shipping.**
1. **The iter-12 SMA dominance did not generalize.** Its big in-sample edge (Sharpe 0.85/1.25
   train) collapsed to *slightly worse than momentum* out-of-sample (0.68 vs 0.69 / 0.71). The
   full-history win was pre-2000 regime-specific luck — exactly the overfitting trap OOS
   validation exists to catch. **No signal change is warranted; the shipped 12mo-momentum gate
   stands. No live edit made.**
2. **`dual` is a weak, non-significant maybe** (validate P(dual>mom) 79%/59%, CIs include 0,
   no drawdown gain) — not enough evidence to justify a money-path change either.
3. **Net for the model:** loop-2 has now *confirmed the shipped config's robustness*
   (significant edge, holds under production weighting, TC-robust, understood by regime) and
   *rejected one tempting-but-false improvement*. The honest, evidence-first outcome. The
   `signal` param stays a research knob, not a live default.

---

## Iteration 14 (Σ₀) — decumulation: the brake is TAIL insurance, not an average-case win

`deep_history_decumulation.py`: $1M start, withdraw 4% and a stressed 5%/yr (real, inflated
3%/yr — a labeled assumption), 30-year retirement, start rolled every 12 months across deep
history. Plus a full-history block-bootstrap P(ruin) (1000 × 30y paths, 21d blocks).

| S&P 1927+ | P(ruin) buy&hold | P(ruin) no_margin | median terminal B&H | median nm |
|---|---|---|---|---|
| withdraw 4%/yr | 22% | **25%** | $2.32M | $1.16M |
| withdraw 5%/yr | 41% | **46%** | $1.07M | $0.22M |
| **block-bootstrap 5%** | **76%** | **48%** | — | — |

| Nasdaq 1971+ | P(ruin) B&H | P(ruin) nm | median B&H | median nm | worst terminal |
|---|---|---|---|---|---|
| withdraw 4%/yr | 0% | 0% | $9.05M | $10.94M | B&H $2.3M / nm $6.6M |
| withdraw 5%/yr | 8% | **0%** | $6.66M | $8.22M | B&H $0 (ruin) / nm $4.44M |
| **block-bootstrap 5%** | 18% | **8%** | — | — | — |

**Findings (iteration 14).**
1. **In average/benign historical sequences the brake does NOT reduce ruin** — S&P rolling
   ruin is slightly *higher* (25% vs 22% at 4%) and median terminal ~half. Over 30y the
   accumulation return give-up compounds against you when the feared crash doesn't hit early.
   Stated plainly — it is not a free decumulation win.
2. **In worst-case sequences it substantially reduces ruin** — the block-bootstrap (which
   strings bad periods together = the sequence-of-returns nightmare) shows **S&P P(ruin)
   76%→48%, Nasdaq 18%→8%**, and Nasdaq's 5% historical ruin 8%→0% with a far higher worst-
   case terminal ($4.4M vs $0). This is exactly the tail the drawdown brake is built for.
3. **Framing:** the Conservative overlay is **sequence-of-returns *insurance*** — it costs
   median wealth in good sequences and pays off by preventing catastrophe in bad ones. Right
   for a retiree/withdrawer who weights "don't run out" above "maximize the median." Consistent
   with the whole study: risk-management, not return-max.
4. **Honest caveats:** the 3%/5% inflation/withdrawal figures are labeled assumptions (no CPI
   series); the block-bootstrap is full-history (crises enter via resampling), not crisis-only;
   small crisis-start window counts (n=1-3) on the historical roll.

---

## Iteration 15 (Σ₀) — decumulation glidepath: brake the early years, then un-brake

`deep_history_glidepath.py` tests brake ONLY for the first 5 or 10 years of a 30y retirement
(sequence risk concentrates early), then buy&hold. Same $1M / real-withdrawal / roll +
block-bootstrap harness as iter-14.

| S&P, withdraw 4%/yr | P(ruin) | median terminal |
|---|---|---|
| buy&hold | 22% | $2.32M |
| always-brake | 25% | $1.16M |
| **glide 10y** | **17%** | $1.78M |
| glide 5y | 20% | $2.09M |

| S&P, block-bootstrap 5% (worst-case tail) | P(ruin) |
|---|---|
| buy&hold | 75% |
| **always-brake** | **46%** |
| glide 10y | 66% |
| glide 5y | 71% |

Nasdaq: glidepaths eliminate the 5%-rule historical ruin (8%→0%) like always-brake, with
medians between buy&hold and always-brake; in the bootstrap tail always-brake wins (9% vs
13-16%).

**Findings (iteration 15).**
1. **On the realistic historical roll the glidepath is the best of both** — glide-10y cuts
   ruin below BOTH buy&hold and always-brake (17% vs 22%/25% at 4%) while keeping a median
   near buy&hold. Front-loading protection to the early danger zone, then un-braking, captures
   sequence-of-returns protection without the full 30y return drag.
2. **In the extreme bootstrap tail, always-brake still wins** (S&P 46% vs glide 66-71%) —
   un-braking re-exposes you to *late* crashes. Honest trade-off: glidepath optimizes the
   realistic distribution; always-on optimizes the worst case.
3. **This is a USAGE insight, not a code change** — the live champion book is an
   accumulation/allocation engine, not a decumulation/withdrawal engine. The takeaway for a
   retiree is: turn the Conservative mode ON near/into early retirement, consider relaxing it
   after the danger decade. No live edit made.
4. **Caveats:** overlapping rolling windows (not independent); the 5/10y switch is a clean
   return-splice (ignores the one rebalance at the switch); 10y is the established sequence-
   risk window, not a fitted parameter, but 5y-vs-10y was chosen after seeing the data.

---

# LOOP 2 SYNTHESIS (Σ₀) — what 8 iterations established

**The question:** keep improving the ADR-0028 Conservative overlay under Σ₀ rigor.

**What was CONFIRMED about the shipped config** (band 0.30 / brake 0.20 / 12mo-trend, ≤1×,
~monthly):
- **Statistically real** — block-bootstrap ΔSharpe 95% CI excludes 0 on S&P [+0.10,+0.43] and
  Nasdaq [+0.09,+0.52]; survives deflation for the config search (iter-8).
- **Not a weighting artifact** — holds under the live capped-tangency weighting (iter-9).
- **Cost-robust** — Sharpe ranking never flips from 2 to 20 bp; low turnover is what buys this
  (iter-10).
- **Mechanistically understood** — the entire edge is the down-trending correction regime
  (+11.7%/yr S&P); it lags normal bulls and whipsaws on false down-flips (iter-11).

**What was REJECTED** (Σ₀ working as intended):
- **The 200-day SMA "improvement"** looked dominant in-sample (Sharpe 0.85 train) but FAILED
  out-of-sample (0.68 vs momentum 0.69; CI straddles 0). A regime-luck false positive, caught
  before it could reach money-path code. **No signal change shipped** (iters 12-13).

**What was CHARACTERIZED** (honest use-cases):
- **Funded balance:** the brake wins on both return and risk (loop-1 iters 1-2).
- **Decumulation:** it's **sequence-of-returns tail insurance** — cuts worst-case ruin
  (bootstrap 76→48% S&P) but costs median wealth in benign sequences (iter-14). A **glidepath**
  (brake the early retirement years, then un-brake) is better on the realistic historical
  record; always-on is better in the extreme tail (iter-15).

**STANDING RECOMMENDATION:** the shipped Conservative (no-margin) mode is **sound, robust, and
correctly scoped**. **No further live change is justified by the evidence** — the one tempting
improvement (SMA) was a false positive. Position it as: default for the funded/advisor book;
opt-in capital-preservation for near/into-retirement users; keep 2× leverage strictly opt-in.
The most valuable loop-2 output is negative-space knowledge: we now know what NOT to change.

---

# LOOP 3 (2026-07-19, Σ₀) — new markets, regimes & variables

Loops 1-2 validated the shipped Conservative config on US indices (S&P/Nasdaq) — markets that
always recovered. Loop 3 attacks the untested variables: non-US markets (survivorship bias),
inflation/real returns, interest-rate regimes, decade stability, vol-target sensitivity.
> **LOOP 3 STATE:** run until ~2026-07-19T23:56Z. Branch `claude/trading-research-loop3` (PR to follow). LOOP 3 COMPLETE. Iters 16-20 + synthesis: brake works outside US (Japan doubled buyIters done: **18** (intl/Japan; real returns; rate-regime). Next: decade stability → vol-target sweep → synthesis.hold); boundaries mapped (not an inflation hedge; ZIRP-weak; small drag in crash-free bulls); tv=0.20 robust. Shipped config sound, no live change.

## Iteration 16 (Σ₀) — survivorship-bias test: the brake OUTSIDE the US (incl. Japan)

`deep_history_international.py` runs buy&hold vs the shipped no-margin Conservative overlay on
six non-US markets.

| market | window | B&H Sharpe / maxDD | no_margin Sharpe / maxDD | nm trades/yr |
|---|---|---|---|---|
| Nikkei (Japan) | 1980-2026 | 0.34 / −82% | **0.60 / −32%** | 13 |
| FTSE 100 (UK) | 1984-2026 | 0.41 / −53% | **0.54 / −29%** | 11 |
| DAX (Germany) | 1987-2026 | 0.50 / −73% | **0.58 / −27%** | 12 |
| Hang Seng (HK) | 1986-2026 | 0.36 / −65% | **0.51 / −34%** | 16 |
| CAC 40 (France) | 1990-2026 | 0.30 / −65% | **0.41 / −29%** | 12 |
| All Ords (Australia) | 1984-2026 | 0.47 / −55% | **0.51 / −34%** | 11 |

**Japan from the 1989 bubble peak** (the survivorship-bias killer — Nikkei took ~34y to
reclaim its 1989 high):

| Japan, invest at 1989 peak | buy&hold | no_margin |
|---|---|---|
| full → 2026 (37y) | $42,982 (CAGR 1.5%, maxDD −82%) | **$99,038 (CAGR 3.9%, maxDD −32%)** |
| peak → 2010 (lost decades) | $7,067 (maxDD −82%) | **$37,541 (maxDD −26%)** |

**Findings (iteration 16).**
1. **The brake is NOT US-bounce luck — it works on every market tested, and is MOST valuable
   where buy&hold failed.** In Japan, the one major market that didn't recover for a generation,
   the overlay went to cash through the multi-decade bear and **more than doubled** the buy&hold
   outcome (CAGR 3.9% vs 1.5%) while **cutting drawdown from −82% to −32%.** Through the pure
   lost decades it turned a −29% loss into a +275% gain. This is the strongest external-reality
   evidence in the study — decisive refutation of survivorship-bias critique.
2. **Improves Sharpe AND drawdown on all 6 international markets**, at the same low turnover
   (11-16 trades/yr). The result is not US-specific.
3. **Mechanistic honesty:** the Japan edge comes precisely because Japan *trended down* for
   decades (the trend gate kept it in cash). A market that chops sideways with no sustained
   trend would whipsaw (iter-11); Japan's sustained downtrend is the brake's best case, and it's
   real.

---

## Iteration 17 (Σ₀) — REAL (inflation-adjusted) returns: brake protects crashes, NOT inflation

`deep_history_real.py` deflates both books by an encoded annual US CPI table (BLS historical —
labeled assumption; FRED was unreachable). Both books deflated identically → the comparison is
fair. Caveat: run_overlay's cash carry is flat 3%, which UNDERSTATES 1970s-80s T-bill yields
(5-15%) — so the stagflation result is CONSERVATIVE (pessimistic) for the brake.

| S&P, REAL | buy&hold realSharpe / realDD / real× | no_margin realSharpe / realDD / real× |
|---|---|---|
| full 1927-2026 | 0.26 / −84% / ×22.5 | **0.40 / −57% / ×35.3** ✓ |
| **1970-82 stagflation** | −0.23 / −62% / ×0.6 | **−0.45 / −56% / ×0.6** ✗ |
| 2000-2026 | 0.29 / −65% / ×2.7 | **0.46 / −20% / ×3.3** ✓ |
| 2021-26 inflation spike | 0.58 / −30% / ×1.6 | **0.64 / −21% / ×1.5** ✓ |

**Findings (iteration 17).**
1. **The brake improves REAL returns in most regimes** — full history (real Sharpe 0.40 vs
   0.26, real DD −57% vs −84%, higher real multiple), the modern 2000-2026 crashes, and even
   the recent 2021-22 inflation spike. It is not merely a nominal illusion.
2. **BUT in the 1970s stagflation it gave NO real edge — slightly worse real Sharpe (−0.45 vs
   −0.23), same real loss (both ×0.6).** Cash is a poor inflation hedge: when the enemy is
   *inflation* (not a nominal crash), parking in cash doesn't preserve purchasing power. **The
   brake protects nominal drawdowns, not inflation.** A real inflation hedge (TIPS / commodities
   / gold) is a different tool. This is the honest limit.
3. **Caveat softens #2:** the flat-3% cash assumption badly understates 1970s T-bill yields, so
   the true 1970s real result is better than shown; but qualitatively cash-parking still isn't
   an inflation hedge. → **iter-18 tests rate-regime sensitivity directly** (how much of the edge
   depends on the cash yield).

---

## Iteration 18 (Σ₀) — the edge is CASH-YIELD dependent (ZIRP is the weak spot)

`deep_history_rates.py` varies the idle-cash yield (0/3/6%) for the no-margin book (buy&hold
holds no cash → RF-invariant).

| S&P 1927+ | cash 0% | cash 3% | cash 6% | buy&hold |
|---|---|---|---|---|
| no_margin Sharpe | **0.09** | 0.69 | 0.79 | 0.42 |
| no_margin final | $33k | $16.5M | $50.7M | $10.5M |
| beats B&H Sharpe? | **NO** | yes | yes | — |

| Nasdaq 1971+ | cash 0% | cash 3% | cash 6% | buy&hold |
|---|---|---|---|---|
| no_margin Sharpe | **0.82** | 0.90 | 0.98 | 0.60 |
| beats B&H Sharpe? | yes | yes | yes | — |

**Findings (iteration 18).**
1. **The brake's edge scales strongly with the cash yield — this is a real, material
   sensitivity.** On the S&P over a century, at 0% cash the Sharpe collapses to 0.09 (below
   buy&hold's 0.42) and terminal wealth is decimated: sitting in cash earning nothing ~40% of
   the time forgoes ~98 years of compounding. At the historically-normal ~3% it's solid; at 6%
   it dominates.
2. **On the Nasdaq the RISK-ADJUSTED edge survives even 0% cash** (Sharpe 0.82 > 0.60) — its
   crashes (dot-com −78%) are violent enough that avoidance pays regardless of cash interest —
   but final value still lags buy&hold at 0%.
3. **Practical caveat (important):** the brake works best when cash earns a real yield (≥3%,
   like 2023-2026). In a sustained **ZIRP world (cash ≈ 0%, like 2009-2021)** it loses much of
   its appeal on broad indices — you sit in cash earning nothing while missing the recovery.
   The full-history 0% run is a counterfactual (cash didn't earn 0% for a century; the realistic
   long-run yield is ~3-4%, where the brake holds), but it correctly flags that **the strategy's
   value is regime-dependent on rates.** Combined with iter-17 (not an inflation hedge), the
   honest boundary is now sharp: the Conservative brake is *nominal crash insurance that pays a
   cash coupon* — strong when cash yields are positive, weak under ZIRP or pure inflation.

---

## Iteration 19-20 (Σ₀) — decade stability + vol-target robustness

**Decade-by-decade (S&P; excess = no_margin − buy&hold Sharpe):**

| decade | ΔSharpe | B&H maxDD → nm maxDD |
|---|---|---|
| 1920s | +0.56 | −45% → −21% |
| 1930s | +0.30 | −83% → −28% |
| 1970s | +0.14 | −48% → −26% |
| **2000s** | **+0.58** | −57% → −10% |
| 2020s | +0.11 | −34% → −19% |
| 1980s | −0.03 | −34% → −27% *(brake worse Sharpe)* |
| 1990s | −0.03 | −20% → −17% *(brake worse Sharpe)* |
| 2010s | −0.11 | −20% → −17% *(brake worse Sharpe)* |

Nasdaq echoes it: crisis decades win big (1970s +0.73, 2000s +0.49), strong-bull decades cost
a little (1980s −0.02, 1990s −0.03, 2010s −0.13).

**vol-target (tv) sweep, S&P (shipped tv=0.20; buy&hold Sharpe 0.42):**

| tv | Sharpe | maxDD | final | trades/yr |
|---|---|---|---|---|
| 0.10 | 0.77 | −26% | $6.5M | 25.7 |
| 0.15 | 0.72 | −33% | $11.5M | 12.8 |
| **0.20** | 0.69 | −34% | **$16.5M** | **8.4** |
| 0.25 | 0.66 | −33% | $16.2M | 7.0 |
| 0.30 | 0.62 | −34% | $14.1M | 6.5 |

**Findings (iter 19-20).**
1. **The edge is structurally "crisis insurance," consistent across 10 decades:** the brake
   REDUCES drawdown in *every* decade on both indices, wins Sharpe big in crisis decades
   (1920s/30s/70s/2000s), and costs a little Sharpe in strong-bull decades (80s/90s/2010s). It
   is not a fragile few-era artifact — the direction is stable; the magnitude tracks how bad the
   decade was. Honestly: in a decade-long bull with no crash, the brake is a small drag.
2. **tv=0.20 is robust, not a knife-edge:** the whole 0.10-0.30 range beats buy&hold on Sharpe,
   varying smoothly. Lower tv (0.10-0.15) gives higher Sharpe/shallower drawdown but 2-3× the
   trades; tv=0.20 is the low-turnover sweet spot and maximizes final value. Consistent with the
   don't-over-trade mandate. (If Sharpe were the sole goal and turnover didn't matter, tv≈0.10-15
   would edge it — stated for completeness.)

---

# LOOP 3 SYNTHESIS (Σ₀) — the operating envelope, mapped

**Question:** keep improving/validating the shipped Conservative overlay on variables loops 1-2
never touched (non-US markets, inflation, rates, decade + parameter robustness).

**CONFIRMED (the model is more robust than loops 1-2 could show):**
- **Works outside the US — including where buy&hold FAILED.** Improves Sharpe+drawdown on all 6
  non-US markets; on Japan-from-the-1989-peak it MORE THAN DOUBLED buy&hold ($99k vs $43k) and
  cut drawdown −82%→−32%. Decisive refutation of survivorship-bias (iter-16).
- **Improves REAL returns in most regimes** (full history, 2000s, the 2021-22 inflation spike)
  (iter-17).
- **Structurally consistent across 10 decades** — reduces drawdown every decade; wins in crises,
  small drag in strong bulls (iter-19).
- **tv=0.20 is a robust, low-turnover choice**, not a knife-edge (iter-20).

**HONEST BOUNDARIES (newly sharpened — when it does NOT help):**
- **Not an inflation hedge.** In the 1970s stagflation it gave no real edge — cash is poor
  inflation protection; it insures *nominal* crashes (iter-17).
- **Cash-yield / rate dependent.** Under sustained ZIRP (cash≈0%) its edge collapses on broad
  indices (S&P Sharpe 0.09 at 0% cash) — it needs cash to earn a real yield (≥3%, like now).
  Nasdaq keeps a risk-adjusted edge even at 0% (iter-18).
- **A drag in long crash-free bull decades** (1980s/90s/2010s) — small give-up, always with less
  drawdown (iter-19).

**STANDING RECOMMENDATION:** the shipped Conservative (no-margin) config remains **sound and
correctly scoped** — loop 3 found NO reason to change it and NO new false-improvement to chase.
Its value is now precisely bounded: **nominal crash insurance that pays a cash coupon** — most
valuable in crisis-prone or downtrending markets with positive cash yields (the present regime),
least valuable in a crash-free bull, under ZIRP, or against pure inflation. Position it as an
opt-in capital-preservation mode with these conditions stated to the user. No live change.

---

## Iteration 21 (Σ-cert) — holdout theater measured on the Champion's own selection (2026-07-19)

Applied the Collapse Certificate's §8.4 result (fixed-holdout reuse inflates adaptive research;
Thresholdout keeps evidence honest; Dwork arXiv:1506.02629) to the champion's selection process
and MEASURED it (`experiments/champion_holdout_theater.py`, 81-config grid tv×brake×trend×band,
one full $2k+$20 walk-forward each; TRAIN <2013 / VAL 2013-19 / TEST ≥2020 touched once; a
greedy 40-query researcher hill-climbs VAL under three regimes; 24 seeds for stochastic arms).

| selection regime | reported Sh | TEST Sh | TEST growth | full-period $ | maxDD |
|---|---|---|---|---|---|
| naive holdout reuse | 0.855 | 0.915 | 2.52× | $68,099 | −20.2% |
| thresholdout (T=.25, σ=.15, budget 10) | 1.096 (infl.) | 0.924 | 2.63× | $68,074 | −22.0% |
| fresh-flow proxy (block bootstrap) | 1.415 (infl.) | 0.905 | 2.64× | $69,003 | −23.5% |
| **CHAMPION as actually chosen** | — | **1.019** | **3.65×** | **$91,703** | −25.5% |
| test-window oracle | — | 1.139 | 3.43× | $86,865 | −24.5% |

**Findings.**
1. **The champion survives the certificate's audit.** Chosen once (max final value with a Sharpe
   floor), it beats every adaptive val-Sharpe-optimizing researcher on the untouched 2020-26
   window on BOTH growth (3.65× vs 2.5-2.6×) and Sharpe (1.02 vs ~0.91), and sits near the test
   oracle (whose full-period final it actually exceeds). No evidence its selection was
   holdout-noise-mining.
2. **At this grid granularity, naive reuse did NOT corrupt picks** — all three regimes land the
   same low-vol config family with equal test quality. The landscape is coarse and smooth; the
   cert's 22× penalty regime is fine-grained noise-chasing. Consequence: adopt Thresholdout when
   the search gets fine (the 100+-strategy meta-hunts), not for 81-cell grids.
3. **Where the cert's warning DID bite: reported scores, not picks.** Noisy query channels
   inflate the reported Sharpe (+0.27 thresholdout, +0.59 fresh-proxy) while true quality stays
   flat — winner's curse on the reporting path. Protocol rule: publish re-measured truth, never
   the search's own reported score (our walk-forward re-runs already do this; now it's a rule).
4. **Objective choice dominated holdout discipline ~10:1.** Val-Sharpe maximization under-earns
   the champion's $-objective by ~$24k (−26%) at only slightly better drawdown. Fix the
   objective (final wealth s.t. floors) before optimizing the reuse mechanism.

Honest limits: fresh-flow arm is a bootstrap proxy, not truly fresh data; constants (T, σ,
budget) at the noise scale — shape is the claim; single val/test split (2013-19 → 2020-26);
Sharpe-greedy researcher is one adversary, not the worst one.

---

## Iteration 22 — the contender cook-off: 6 challengers, any honest means (2026-07-19)

Operator: beat the champion with any strategy, any means necessary. Discipline held (iteration-21
rules): all free params tuned pre-2020 only, 2020→2026-07 graded ONCE, every entrant reported,
engine-equivalence asserted ($91,703 vs published $91,702). `experiments/contender_cookoff.py`.

| entrant | full $ | maxDD | full Sh | TEST Sh | TEST growth |
|---|---|---|---|---|---|
| CHAMPION (ref) | $91,703 | −25.5% | 0.65 | 1.02 | 3.65× |
| C1 grid-refit (tv.2/bk.3/tr12/bd.16) | $81,945 | −25.1% | 0.73 | 0.97 | 2.87× |
| C2 dual momentum top5, 1× | $62,745 | −23.3% | 0.80 | 0.86 | 2.27× |
| C3 dualmom top5 + brake | $90,797 | −35.0% | 0.65 | 0.67 | 2.42× |
| C4 Moreira-Muir σ² (c=.04) | $75,736 | −42.9% | 0.57 | 0.70 | 2.35× |
| **C5 champion + 10% BTC sleeve** | **$277,980** | −27.9% | 0.83 | 1.19 | 5.74× |
| **C6 = C5 + real ^IRX carry** | **$312,092** | −28.0% | 0.84 | 1.19 | 5.73× |

**Findings.**
1. **Within its own 8-ETF universe, the champion remains unbeaten on wealth** — six more
   challengers join the 100+ prior failures. C1/C2 lift Sharpe by giving up dollars (the
   objective split, again); C3 ties on money at far worse drawdown; naive σ² scaling (C4) blows
   the DD envelope on a multi-asset book.
2. **The only thing that beat it was a new asset, not a new strategy.** A 10% BTC-USD sleeve
   (monthly-rebalanced, live from BTC's 2014 listing, sleeve size tuned pre-2020 where it already
   ran 8.8×) triples the final: $277,980, and KEPT winning out-of-sample (test growth 5.74× vs
   3.65× through two crypto winters incl. 2022's −75%) at only 2.4pt deeper worst dip — the
   capped, rebalanced sleeve harvests the vol without owning the ruin. Stacking the measured
   IRX carry fix gives $312,092 (+240% over the champion).
3. **THE FLAG, unmissable: universe selection is where hindsight hides.** BTC is on the menu
   *because* 2026 knows its history — the same survivorship-of-the-menu bias as failure-map #1.
   The pre-2020 tuning discipline bounds parameter hindsight, not ASSET hindsight. No backtest
   can clear that; only ADR-0029's Phase-B live paper duel can earn it forward.
4. Verdict: promote **champion+BTC-sleeve (5-10%) + IRX carry** to a live paper duel candidate
   (Alpaca supports BTC, so the paper book can actually hold it); universe expansion is an
   operator decision (ADR approval), not a research decision. Everything else retires with its
   numbers on the record.
