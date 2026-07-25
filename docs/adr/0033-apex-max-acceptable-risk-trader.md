# ADR-0033: Apex trader — maximize profit at the highest ACCEPTABLE risk (tail-capped 3× overnight composition)

- **Status:** Proposed (awaiting Alex's approval) — **design only; nothing in this ADR arms or trades**
- **Date:** 2026-07-24
- **Deciders:** Alex Place (pending); operator-requested design (kriskin)
- **Loop stage:** Reason (objective + risk framing) + Act (composition) + Verify (gates, breakers)
- **Relates to:** ADR-0028 (Sharpe-CI mandate for real capital), ADR-0032 (real-money onboarding), the 2026-07-24 measured-strategy ledger (`data/oracle/active-loop-runs.jsonl` rows `bandits-trader-*`, `overnight-vol-conditioned`), the options-shadow trader (measurement-gated), the ETF-universe retune.

## Context

A session of walk-forward measurement established, with recorded evidence:

| Measured fact | Number | Sample |
|---|---|---|
| SPY overnight (Mon–Thu, trend-aligned + vol > trailing median) | **Sharpe 3.18, 65% win, +0.103%/night, maxDD −3.1%** | 10y, n=402 |
| Same edge levered (incl. ~5%/yr financing): 2× / 3× / 5× | Sharpe 2.88 / 2.77 / 2.69 · CAGR 7.8 / **11.3** / 18.4% · DD −6 / **−10** / −16% | 10y |
| QQQ overnight is a **calm-night** edge (regime complements SPY's) | Sharpe 2.12 (flat-vol nights) | 10y, n=875 |
| 3× ETFs (TQQQ/SOXL) for this edge | Sharpe 1.5–1.7, DD −25…−28% — **dominated by margined SPY** | 10y |
| Intraday day-trader (best config: ETF universe + regime + 1R) | PF 1.17 in-sample, **Sharpe ~0.19 OOS** — weak | ~1mo |
| OTM overnight options | modeled **negative** (theta); now being measured by the shadow trader | gated |
| Single stocks | negative expectancy — excluded | 1mo + real book |

The operator asks for the profit-maximal trader at the **highest acceptable risk**. This ADR defines "acceptable" precisely and composes the measured edges under it.

## Decision (proposed)

### 1. Define "acceptable risk" by the tail, not by variance
Gaussian/Kelly sizing on the measured per-night stats (μ≈0.10%, σ≈0.47%) suggests ~47× — absurd, because the binding risk is the **un-stoppable overnight gap** (a 2015/2020-class −5…−6% open), not night-to-night variance. So acceptability is a **stress constraint**:

> **S1 (hard):** a −6% overnight SPY gap must cost ≤ ~20% of equity in one night and must not breach maintenance margin.
> **S2 (hard):** monthly loss ≥ −10% forces de-leverage to 1× for the rest of the month.
> **S3 (hard):** the existing kill-file / brake halts all entries instantly.

S1 ⇒ **hard leverage cap 3.0× on the overnight book** (3 × −6% = −18% worst night). 5× is explicitly rejected: +18.4% CAGR was measured, but a single bad gap ≈ −30% plus margin-call risk, and the backtest window contained no such gap — the DD figures understate exactly the risk that matters.

### 2. The Apex composition (one account, flat by day)
| Sleeve | What | Size | Measured basis |
|---|---|---|---|
| **A — core** | SPY overnight, Mon–Thu, trend-aligned + **vol-not-flat** regime | up to **3×** (margin, not 3× ETFs) | Sharpe 2.77, CAGR 11.3%, DD −10% at 3× |
| **B — complement** | QQQ overnight, **calm-vol** regime (fires on *different* nights than A by construction) | up to **2×**, and combined same-night gross ≤ 3× | Sharpe 2.12 regime |
| **C — carry** | Days + ineligible nights: cash/T-bill yield (equity is flat overnight-book by design) | 100% idle equity | ~4–5% carry |
| **D — convex (the "highest-risk" slot)** | The asymmetric OTM options sleeve | ≤ **1% equity premium/night**, bounded loss = premium | **OFF until the options-shadow ledger measures positive expectancy over ≥30 nights** |
| Excluded | Single stocks; 3× ETFs (dominated); intraday day-trader (no proven edge — signals-only at most) | — | measured negative/weak |

### 3. Risk governance (what makes maximum aggression *acceptable*)
- **Leverage scalar = base × brake:** the existing `brake-monitor` gross (0–2×, normalized) scales the 3× cap continuously to 0 in storms — the book de-levers itself before regimes break it.
- **Circuit breakers:** 3 consecutive losing nights → halve leverage for 5 sessions; S2 monthly breaker; kill-file honored everywhere.
- **Regime discipline:** no trend-alignment → flat (inherent to the gates); one decision per night; weekend holds never.
- **Vehicle upgrade (Phase 2):** move sleeves A/B to **MES/ES futures** when available — the ~23h session makes overnight *stops executable*, converting most un-stoppable gap risk into stoppable path risk, with cleaner margin. This raises the acceptable cap; revisit S1 then.

### 4. Expected performance (composed from measured parts — honest bands)
**CAGR ~15–20%** (A ≈11% + B on its nights + carry), **blended Sharpe ~2.3–2.8**, max-DD budget **15–20%**, worst-single-night **−18% by construction**. Confidence **medium**: 10-year bull-heavy sample, filtered-night Sharpe has wide CIs, tails understated by history, financing modeled at 5%/yr.

### 5. Sequencing and money
Phase 1: build Apex as a **paper** trader mode (sleeves A–C; D stays shadow). Phase 2: futures vehicle. Phase 3: arm D only on the shadow's measured `positive_edge_candidate` verdict + operator approval. **Real money remains gated by ADR-0028 (Sharpe-CI mandate) and ADR-0032 (onboarding) — this ADR does not touch that.**

## Consequences
- The system gets one coherent max-aggression book with its risk defined by an explicit, testable stress bound instead of vibes — and a paper track record that ADR-0028 can eventually score.
- Profit is deliberately left on the table vs 5× (−7pp CAGR) to keep single-night ruin off the table; that is the point of "acceptable."
- The options sleeve stays an option (measurement-gated), so the highest-risk component can never silently turn on.

## Rejected alternatives
- **5× leverage** (measured +18.4% CAGR): one −6% gap ≈ −30% night + margin call; tail unpriced in-sample. Rejected on S1.
- **Kelly/variance sizing** (~47×): ignores gap tails entirely — the failure mode this design exists to prevent.
- **3× ETFs as the leverage vehicle:** measured strictly worse (Sharpe 1.5–1.7, DD −25…−28%) than margined SPY at equal effective leverage; vol-drag + concentration.
- **Including the intraday day-trader as a sleeve:** OOS Sharpe ~0.19 — no proven edge to lever; keep signals-only until it earns in.
- **Unconditional overnight holding (no vol/trend gates):** measured Sharpe 1.59 vs 3.18 gated — the gates ARE the edge concentration.

## Sources
- Measured runs (this repo): `data/oracle/active-loop-runs.jsonl` — rows `bandits-trader-profitability`, `bandits-trader-universe`, `bandits-trader-sharpe-oos`, `overnight-vol-conditioned`; scratch harnesses replaying `lib/signal-engine` + Yahoo daily/15m bars (no lookahead).
- `lib/brake-monitor.js` (gross scalar), `lib/options-shadow.js` (measurement-gated convex sleeve), ADR-0028, ADR-0032.
