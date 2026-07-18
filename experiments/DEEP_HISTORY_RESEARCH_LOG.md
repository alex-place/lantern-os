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
