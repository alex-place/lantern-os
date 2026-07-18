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

### Next (later iterations)
- Tune `band`/`brake`/`trend_m` *on the deep history* with a clean train(pre-1990)/
  validate(1990+) split — confirm ~16 trades/yr is near-optimal, not just the live spec.
- Re-run with the real DCA deposit schedule (not lump sum) to match the live plan.
- Test a blended S&P+Nasdaq+gold panel over deep history.
- If it holds: wire a selectable **"Conservative (no-margin)"** overlay mode into the
  live model rather than adding a parallel system (extend, don't sprawl).
