# Trading-model deep-history research log

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

### Next (later iterations)
- Re-run with the real DCA $20/mo deposit schedule (not lump sum) to match the live plan.
- Test a blended S&P+Nasdaq+gold panel + a bond-proxy from ^TNX over deep history.
- Web-research low-turnover tactical-allocation literature to sanity-check the band/trend
  choice against published dual-momentum / trend-following-with-cash results.
- If it holds: wire a selectable **"Conservative (no-margin)"** overlay mode into the
  live model rather than adding a parallel system (extend, don't sprawl).
