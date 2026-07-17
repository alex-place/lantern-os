# Σ₀ Collapse Certificate — `docs/investing-2k-plan.html`

**Claim under test:** "$2,000 + $20/mo DCA into a momentum-tilted 8-asset mix, gross
leverage ∈ [0, 2×] via 35% vol-target × 6-mo trend gate × 30% DD-taper → cash
(T-bills), real-time streaming brake, produces $91,843 (12.6%/yr, maxDD −25%,
Sharpe 0.65) from 2000-01 → 2026-07 versus $54,603 SPY B&H+DCA."

This certificate is the adversarial audit of that claim. It is committed alongside the
artifact so the audit is as durable as the number. Per the External Reality Rule, the
receipts that matter are the runnable experiments (`experiments/dca_champion_2k.py`,
`experiments/dca_champion_instrumented.py`, `experiments/leverage_*`), not the prose.

## Evidence-class discipline (strict, asymmetric)

| Class | What it covers | Status |
|---|---|---|
| **MEASURED (in-sim)** | Walk-forward equity curve, 679-row trade log, 1,000-path bootstrap | True **only** for the exact code, price series, and cost model used |
| **OPERATIONAL** | "Nothing has passed the gate yet" (`meets_ci` withholds live capital) | Correct and conservative |
| **HEURISTIC** | Forward projection tables; "best of 55/58 alternatives" ranking | Extrapolation, not fact |
| **UNPROVEN / open** | That the edge is available, implementable, and durable for a real $2k retail account today | Not yet measured at the required confidence |

## Load-bearing assumptions that can collapse the claim

- **A · Momentum-sleeve history.** XMMO (~2005), SPMO (~2015). **Corrected vs the raw
  red-team:** the sim does *not* reconstruct or proxy pre-inception history — funds enter
  the tangency direction only once they have a full trailing window of real Yahoo prices
  (`live = [s for s in UNIVERSE if not np.isnan(px[s][lb:i]).any() and i-lb>252]`). So the
  proxy/tracking-error overstatement does **not** apply. What survives: the sleeve's
  contribution is concentrated in its live era, which overlaps the momentum-favorable
  regime — durability is unproven.
- **B · Leverage at retail scale.** 2× gross on $2k is *margin*, not a 2× ETF:
  maintenance margin (25–30%+ house rules, higher in stress), PDT flag on frequent brake
  fires, dynamic debit interest, forced-liquidation order + partial fills. A single delayed
  brake or margin call = permanent impairment DCA cannot repair at this contribution rate.
  Under-modeled.
- **C · Transaction + financing drag realism.** 679 trades over 26y. Bid-ask on the small
  sleeves (IWM/EFA/XMMO/SPMO), fees, and the T-bill-vs-debit spread compound; the cost
  model is a flat bps approximation and **taxes are not modeled** (679 taxable events in a
  taxable account is a real haircut). Small-account costs are higher, not lower.
- **D · Selection multiplicity (Bailey / López de Prado).** The champion is the survivor of
  a 100+ strategy / 55-asset search → elevated overfitting probability. The 1,000-path
  bootstrap stresses the *champion*, not the *discovery process*; it is not a full OOS
  stress of the search that selected it.
- **E · Regime / path dependence.** The 6-mo-trend × vol-target × DD-taper rules worked in
  the tested window; they are not invariant to prolonged high-rate/low-growth regimes,
  simultaneous equity+bond+gold drawdowns, or a weakened/inverted momentum premium. −25%
  maxDD is the realized path, not a ceiling.
- **F · Human operator factor (the real gate).** "A person always decides" is the strongest
  part of the design and also where real plans fail most: the operator sees −25% while a
  plain-SPY neighbor is −15%, overrides the brake on a false positive, or stops the $20 in a
  multi-year flat stretch. Behavioral leakage is not in the backtest.

## What survives adversarial pressure

- A diversified, trend-gated, modestly levered multi-asset book with an explicit cash brake
  improving both terminal wealth and maxDD vs plain SPY DCA is directionally consistent with
  published risk-parity / momentum / managed-futures overlay literature.
- The "nothing qualifies for live capital yet" gate is the correct Σ₀-style control.
- Contribution size remains the dominant lever (the artifact says so).
- Gold ballast + TLT are sensible, not exotic. Real-time vs daily brake is a measurable
  engineering claim, presented as such (PR #2694: hourly beat daily +$4,278 at equal turnover).

## Minimal honest statement that does not collapse

> Inside the exact historical price series, cost model, and code path used, the described
> engine produced higher terminal wealth and lower maxDD than SPY DCA from 2000–2026. The
> live implementation path for a $2k retail margin account contains several frictions
> (margin mechanics, small-account costs, taxes, regime durability, and operator adherence)
> not yet measured at the required confidence. The internal gate correctly withholds real
> capital. The single highest-confidence action remains **increasing the monthly
> contribution while keeping the risk engine in practice mode.**

## Non-collapsing core (the operator decision surface)

Human click only · practice-mode brake first · `meets_ci` gate (ADR-0028, Buffett bar 0.79;
nothing has cleared it). Everything else on the page is a MEASURED historical simulation that
has not yet earned the right to be treated as a live edge.

*No part of this analysis constitutes financial advice.*
