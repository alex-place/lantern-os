---
author: Claude (claude lane) · reviewed Grok (grok lane)
created: 2026-07-11
updated: 2026-07-11
machine_check: node scripts/verify-sharpe-certificate.js  # exit 0 = document matches evidence
---

# Σ — Unisona Sharpe Certificate

### Risk-adjusted-return integrity for the Σ₀ trader, along the loop: **Observe · Remember · Reason · Act · Verify · Converge**

> **Two timescales, three evidence classes, one honest gap.** Fast layer = the
> math we can *prove* (diversification, sizing). Slow layer = the edges we can only
> *measure* (which strategies actually have one). The gap: nothing here certifies
> future returns — only that the theorems are correct, the design implements them,
> and the measured claims match a committed, re-runnable record.

---

## What this document is — and is not

**IS.** A certificate that (1) states the mathematics the trader uses to maximize
client Sharpe, labelled by how strongly each claim is established; (2) records what
we *measured* on real market data, including every idea that **failed**; and (3) is
**machine-checked** — a script re-asserts every load-bearing number against a
committed evidence file, and this document is not to be trusted if that script
fails on a fresh clone.

**IS NOT.** A promise of returns. A live-capital authorization. A backtest dressed
as a guarantee. Sharpe, drawdown, and correlation here are *historical/backtested*
and conditional on the window, costs, and survivorship noted in each section.

**Operator authority is absolute.** Nothing here governs live capital until Alex
signs §Converge. Every allocation stays auditable, veto-able, and one-command
reversible.

---

## How to audit this document

Every load-bearing claim maps to a runnable check. If a command fails on a fresh
clone, **the document has drifted and must be reconciled before it is trusted.**

| Claim | Class | Verify with |
|---|---|---|
| The certificate's headline numbers match the evidence | **MEASURED** | `node scripts/verify-sharpe-certificate.js` → exit 0 (11/11) |
| Leaderboard vs SPY: CAGR / Sharpe±CI / maxDD / YoY / ρ-matrix | **MEASURED** | `node scripts/daily-backtest-harness.js` |
| √N breadth scaling + intraday cost break-even (~6 bps) | **MEASURED** | `node scripts/intraday-microstructure-harness.js` |
| "Sell the news" falsified; drift (PEAD) dominates | **MEASURED** | `node scripts/sell-the-news-harness.js` |
| Real earnings-surprise PEAD event study + backtest | **MEASURED** | `node scripts/earnings-pead-harness.js` |
| Diversification raises Sharpe ≈ √N (Theorem 1) | **PROVEN** | §Reason T1 (closed-form) + verifier E2 checks |
| Regime gating helps iff classifier beats base rate (Theorem 6) | **PROVEN** | §Reason T6 (closed-form, conditional) |
| Tangency / vol-target / Kelly | **STANDARD CONSTRUCTION** | §Reason T2–T5 (cited) |
| Committed evidence record | **ARTIFACT** | `data/trading/leaderboard/leaderboard-2026-07-10.json` |

*Verified-on 2026-07-11 at git commit of this file. Machine check: 11 passed, 0 failed.*

---

## Glossary — internal → standard terms

| Here | Means |
|---|---|
| **sleeve** | one standalone strategy that can be blended into the portfolio |
| **COMBO3** | inverse-vol (risk-parity) blend of SPY + multi-market trend + gold |
| **ρ̄ (rho-bar)** | average pairwise correlation of the sleeves in a blend |
| **the gate** | the two-condition admission rule for a new sleeve (§Act) |
| **edge** | a positive standalone Sharpe whose 95% CI excludes zero |
| **the loop** | Observe · Remember · Reason · Act · Verify · Converge (the whole system) |

---

## Plain-language summary

Don't try to beat the S&P on raw return — almost nothing does over the long run.
Aim instead for the **same return with far less pain** (higher Sharpe), because a
smoother ride compounds better and keeps clients invested. The one free lunch is
**diversification**: blend a few strategies that are *genuinely uncorrelated* and
the combined Sharpe rises roughly like √(number of independent bets). We proved
that math, then measured it: **COMBO3 lifted Sharpe from 0.89 to 1.12 and cut the
worst drawdown from −34% to −12%.** We then tried six more sleeves to push higher.
All six failed — and *why* they failed is the most useful thing we learned:
**finding uncorrelated streams is easy; finding one with a real, cost-surviving
edge is hard.** The path to elite Sharpe is breadth (many small edges) plus cheap
execution — an infrastructure problem, not a signal problem.

---

# OBSERVE — what we measure, and from where

**Status: MEASURED.** All prices are Yahoo daily `adjclose` (total return,
dividends reinvested) unless noted; earnings surprises are Nasdaq's keyless
endpoint; intraday is Yahoo 15-minute bars.

- **Daily total return, 10y**, SPY + ex-US + bills + bonds + gold + commodities +
  44 large-caps + 9 sectors. Feeds the leaderboard and the sleeve correlation matrix.
- **Intraday 15m, ~1mo**, 44 names. Feeds the √N breadth + cost-wall probe.
- **Real earnings surprises**, 44 names × 4 quarters (Nasdaq). Feeds the PEAD test.

**Honest limits.** Daily-total-return via `adjclose` is faithful; intraday reaches
only ~1 month (Yahoo's cap) and uses mid/close prices (no live fills/spread);
Nasdaq gives only ~4 quarters keyless (a ~1-year earnings window); the single-stock
universe is survivorship-biased (today's survivors). Each downstream claim inherits
these and says so.

---

# REMEMBER — the durable, re-runnable record

**Status: ARTIFACT.** Nothing in this certificate floats free of a committed file.

- **Evidence record:** `data/trading/leaderboard/leaderboard-2026-07-10.json` —
  every strategy's CAGR, Sharpe±CI, maxDD, YoY, and the full correlation matrix,
  git-stamped.
- **This certificate + its hash:** `docs/UNISONA-SHARPE-CERTIFICATE.sha256`.
- **Provenance of everything tried:** Appendix M below — the six rejected sleeves,
  each with its measured reason. Kept verbatim so we never re-run a dead end.

---

# REASON — the certified mathematics

Each theorem carries an evidence class and the regime under which it holds.

### T1 — Diversification raises Sharpe ≈ √N. **Status: PROVEN.**

*Plain words.* Blend N strategies that don't move together and the combined Sharpe
grows like √N. Uncorrelated is the whole point; correlated bets add nothing.

*Formal.* For N sleeves each with Sharpe `s` and equal pairwise correlation `ρ`, an
equal-weight blend has `S(N,ρ) = s·√N / √(1+(N−1)ρ)`. Proof: portfolio variance
`= (σ²/N)(1+(N−1)ρ)`; divide mean `μ` by its root. As `ρ→0`, `S→s·√N`; as `ρ→1`,
`S→s`. ∎

*Scope / caveat.* Requires the sleeves to *have* comparable positive Sharpe. A
zero-edge uncorrelated sleeve does **not** help — it dilutes return (measured: §Verify).

### T6 — Regime gating helps *iff* the classifier beats its base rate. **Status: PROVEN (conditional).**

*Plain words.* Stepping to cash in "risk-off" windows raises Sharpe only if you can
actually tell risk-off from risk-on better than chance; otherwise whipsaw costs lose.

*Formal.* Excising a segment whose conditional mean < cash rate raises the numerator
and (risk-off vol being higher) lowers the denominator — both raise Sharpe. The
inequality reverses at/below base rate. ∎ *This converts "our trend filter helps"
from hope into a measurable hypothesis.*

### T2–T5 — Sizing & allocation. **Status: STANDARD CONSTRUCTION (cited).**

- **T2 Tangency** — max-Sharpe weights `w ∝ Σ⁻¹μ` (Markowitz 1952): allocate by
  inverse covariance, not equally.
- **T3 Vol targeting** — scale exposure to constant vol; raises *realized* Sharpe
  under vol clustering (Moreira–Muir 2017).
- **T4 Sharpe→drawdown** — higher Sharpe ⇒ shallower expected max drawdown
  (Magdon-Ismail 2004). Optimizing Sharpe *is* optimizing the client's ride.
- **T5 ½-Kelly** — half-Kelly captures ~75% of growth at ~25% of variance
  (Kelly 1956; Thorp): the Sharpe-favorable operating point; never full Kelly.

### T7 — Elite Sharpe = T1 industrialized. **Status: STANDARD CONSTRUCTION (cited).**

Grinold's Fundamental Law: `Sharpe ≈ edge-per-bet × √(independent bets)`. Firms at
Sharpe 4–10 don't have better per-bet skill; they run *thousands* of tiny,
market-neutral, independent bets and lever the smooth result. Our COMBO3 is the
correct small-N seed of the same law.

---

# ACT — the design, and the admission gate

**Status: HEURISTIC (operational design derived from the theorems above).**

The chat and trader are **one loop**: the Sharpe number a client sees in chat is the
same ex-ante number the sizing layer acts on. The trader pipeline:

1. **Ensemble** — blend low-ρ sleeves *(T1)*
2. **Correlation-aware allocation** — size by `Σ⁻¹μ` *(T2)*
3. **Regime gate** — trend/GEM risk-on/off overlay *(T6)*
4. **Vol targeting** — to a fixed portfolio vol *(T3)*
5. **½-Kelly cap** + hard heat limit *(T5)*
6. **Verify gate** — trade only if ex-ante Sharpe clears threshold; else hold cash
7. **Audit + rollback** — every fill logged, reversible, operator-vetoable

### The two-condition sleeve-admission gate

**A new sleeve is admitted only if BOTH hold** (measured, not argued):

- **(a)** measured pairwise **ρ < 0.4** to the current blend, AND
- **(b)** a positive standalone **Sharpe whose 95% CI excludes 0** (a real edge).

*Why both.* T1 needs uncorrelated *and* positive-edge sleeves. Low ρ alone is
necessary, not sufficient — a zero-edge uncorrelated sleeve dilutes return. The
harness correlation matrix + Sharpe CIs are the sole arbiter; narrative difference
("another asset class", "sounds uncorrelated") is never enough. The **direct**
arbiter is whether the sleeve raises the *blended* Sharpe.

### Red team — gaming a Sharpe certificate

| Attack | What it fakes | Detection |
|---|---|---|
| Overfit a backtest to Sharpe 5 from one clever rule | breadth it doesn't have | demand ≥ N independent bets; wide single-rule CI |
| Survivorship-picked universe | edge that vanished with the losers | flag universe construction; the −60% L/S crash exposed it |
| Report gross, hide costs | a live edge that dies at the spread | cost sweep + break-even bps (intraday harness) |
| One lucky window | significance | Sharpe 95% CI; multi-window (incl. bear) still required |
| Correlated sleeve dressed as diversifier | independence | measured ρ to the blend, not a story (killed mean-rev, short-vol) |

---

# VERIFY — what the measurements actually said

**Status: MEASURED.** Machine-checked by `verify-sharpe-certificate.js` (11/11).

### Evidence table

| # | Claim | Verdict | Numbers |
|---|---|---|---|
| E2 | Diversification (T1) fires on our strategies | **VERIFIED** | COMBO3 Sharpe **1.12** vs SPY **0.89**; maxDD **−12%** vs **−34%**; sleeve ρ̄ **0.36** (Gold ρ=0.10, MFtrend ρ=0.28) |
| E1 | Each core sleeve has positive net Sharpe | **PARTIAL** | all positive; COMBO3 CI [0.50, 1.74] excludes 0; 10y single window — multi-window (incl. bear) still required |
| E3 | Regime gate (T6) beats base rate net of cost | **PARTIAL** | 200d gate cut maxDD −34%→−19.5%, Sharpe 0.89→1.01 over this window; not multi-window-confirmed |
| R1–R6 | Six extra sleeves beat COMBO3 | **REFUTED (all 6)** | see below |

### The six rejections — the real lesson

| Sleeve | ρ↔SPY | Standalone Sharpe (CI) | Rejected on | Reading |
|---|---|---|---|---|
| Mean-reversion RSI(2) | 0.61 | 0.58 [−0.04, 1.21] | **(a) correlated** | long-equity in disguise |
| Short-vol / put-write | 0.73 | 0.53 [−0.10, 1.15] | **(a) correlated** | long-equity tail, in disguise |
| L/S sector momentum | −0.02 | 0.18 [−0.44, 0.80] | **(b) no edge** | truly neutral, no premium this decade |
| L/S single-stock momentum | 0.06 | 0.24 [−0.38, 0.86] | **(b) no edge** | −60% momentum crash; breadth didn't rescue |
| Sell-the-news (fade) | −0.07 | −1.02 [−1.64, −0.39] | **falsified** | fade is *backwards*; drift dominates |
| Earnings PEAD (buy-the-news) | ~0.07 | thin, CI spans 0 | **(b) no edge (yet)** | right sign; ~1y window + beat/miss imbalance too weak |

> **The finding, stated plainly:** *Genuine uncorrelated diversification is easy to
> find; a significant, net-of-cost standalone edge is genuinely scarce.* None of the
> six raised the blended Sharpe. COMBO3 stands.

### The √N wall (why elite Sharpe is out of reach without infra)

Intraday cross-sectional reversal showed **gross Sharpe rising ≈ √N** with breadth
(N=4→3.4, N=44→19.1) — the Fundamental Law, live. But it **dies at a ~6 bps
transaction-cost break-even.** Below ~6 bps all-in → wildly profitable (HFT, via
co-location/rebates); above it → dead (everyone crossing the spread). **The gap from
Sharpe 1.1 to Sharpe 10 is an execution/infrastructure problem, not a signal one.**

---

# CONVERGE — conclusion, open gaps, and the operator gate

**What is settled.** COMBO3 is the verified ensemble: own the market, add
multi-market trend and gold as genuine diversifiers, size by risk. Higher Sharpe
than SPY, a third of the drawdown, machine-checked.

**What is open (tracked, not hidden).**
1. **E1/E3 → multi-window.** Confirm each sleeve's edge and the regime gate across
   windows that include a bear market (2000–02, 2008). *Needs a longer daily feed.*
2. **10-year PEAD.** The one rejected sleeve with a sign-confirmed footprint;
   re-test with a keyed earnings API over a decade. *Needs an API key.*
3. **The industrial-√N path.** Many small market-neutral edges at middle frequency
   where break-even cost > our real trading cost — the only √N path open to a
   non-co-located shop.
4. **Vol-targeting COMBO3** to a client return target — the client-facing capstone,
   ready to build now.

**Collapse-certificate alignment (client protection, non-negotiable).** Explicit
heat limits; ½-Kelly ceiling, no leverage past the risk budget; human-in-the-loop
before any live deployment; full audit trail + one-command rollback; auto-flatten if
rolling realized Sharpe or maxDD breaches a preset threshold; **abstention (hold
cash) is always a valid, Sharpe-preserving action.**

### Signatures

| Role | Name | Status | Date |
|---|---|---|---|
| Author (agent) | Claude (claude lane) | drafted; math self-checked; machine-check 11/11 | 2026-07-11 |
| E2 promotion + gate review | Grok (grok lane) | reviewed & evidence-updated | 2026-07-11 |
| **Operator ratification** | **Alex Place** | ☐ **PENDING** | — |

*`Status: Proposed`. No authority over live capital until the operator signs. The
return door stays open.*

---

## References

- Markowitz (1952) *Portfolio Selection*; Kelly (1956); Magdon-Ismail & Atiya (2004)
  *Maximum Drawdown*; Moreira & Muir (2017) *Volatility-Managed Portfolios*;
  Grinold *Fundamental Law of Active Management*; MacLean/Thorp/Ziemba (2011).
- Companion code: `scripts/daily-backtest-harness.js`,
  `scripts/intraday-microstructure-harness.js`, `scripts/sell-the-news-harness.js`,
  `scripts/earnings-pead-harness.js`, `scripts/verify-sharpe-certificate.js`.
- Evidence: `data/trading/leaderboard/leaderboard-2026-07-10.json`.

---

## Appendix M — Provenance / maintenance log (everything tried, kept verbatim)

- **2026-07-10 — Daily leaderboard built.** SPY total-return benchmark; COMBO3
  (SPY+MFtrend+Gold) Sharpe 1.12 vs 0.89, maxDD −12% vs −34%, sleeve ρ̄ 0.36. E2 → VERIFIED.
- **2026-07-10 — Mean-reversion + short-vol rejected on (a).** ρ=0.61 / 0.73 to
  equity; adding them dropped blend Sharpe 1.12→1.08 and raised equity-ρ to 0.80.
  *Lesson: "sounds different" ≠ uncorrelated; measure ρ.*
- **2026-07-10 — L/S sector momentum rejected on (b).** ρ≈0 (genuinely neutral) but
  Sharpe 0.18 CI spans 0; blend Sharpe fell to 1.06. *Lesson: low ρ is necessary,
  not sufficient — a zero-edge sleeve dilutes return. Gate upgraded to two conditions.*
- **2026-07-11 — L/S single-stock momentum rejected on (b).** More breadth (44 names)
  didn't rescue the edge; −60% momentum crash (survivorship-amplified). Sharpe 0.24 CI spans 0.
- **2026-07-11 — Intraday microstructure probe.** √N breadth scaling confirmed live;
  gross Sharpe 19 at N=44; break-even ~6 bps. *Lesson: the HFT gap is execution, not signal.*
- **2026-07-11 — "Sell the news" falsified.** Post-event DRIFT (PEAD) dominates the
  fade; literal fade is Sharpe −1.02 / −92% DD. Correct direction (buy-the-news) is
  uncorrelated but thin on a jump proxy.
- **2026-07-11 — Earnings PEAD, real Nasdaq surprises.** Event study directionally
  correct (beats drift up, misses drift down) but insignificant over the ~1y keyless
  window; beat/miss imbalance (155 vs 18) in a bull year starves the short leg.
  Tracked as open gap #2 (needs 10y keyed feed).
- **2026-07-11 — Machine-checker added.** `verify-sharpe-certificate.js`, 11 assertions,
  11/11 pass against the committed record. This document is now drift-detectable.
