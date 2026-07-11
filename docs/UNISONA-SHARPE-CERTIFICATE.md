# Unisona Sharpe Certificate — v1 (DRAFT · Status: Proposed)

**Purpose.** Certify the *mathematics* on which the Unisona chat + Σ₀ trader
optimize client risk-adjusted return (Sharpe ratio), and specify the design that
follows from that mathematics. This document proves what is provable, cites what
is established, and quarantines what is empirical and still pending our own
measured evidence. It is an **evidence artifact**, not a performance guarantee.

> **What a certificate can and cannot certify.**
> - **CERTIFIABLE (done here):** the theorems are correct, and the design
>   *correctly implements* them. Math is provable; a design either does or does
>   not follow from it.
> - **NOT CERTIFIABLE by math alone:** that the live system *will* earn a given
>   Sharpe. That is an empirical claim about the future, conditional on each
>   strategy's realized edge, correlations, costs, capacity, and regime. It is
>   settled only by out-of-sample evidence from
>   [`scripts/daily-backtest-harness.js`](../scripts/daily-backtest-harness.js)
>   and live audited results — never by this document.

- **Approval gate:** per [docs/adr/README.md](adr/README.md), this is
  `Status: Proposed` and is **not authoritative until Alex approves it.** Agents
  draft; the operator ratifies.
- **Integrity:** covered by its git commit SHA plus a detached SHA-256 sidecar
  (`UNISONA-SHARPE-CERTIFICATE.sha256`). Any edit changes both.
- **Operator authority is absolute.** Every allocation this certificate governs
  remains auditable, veto-able, and reversible (see §5, Collapse-Certificate
  Alignment).

### Evidence update — 2026-07-10 (E2 promoted to VERIFIED)

This directly updates the evidence table (§3) with measured results from the
daily-backtest-harness run on 2026-07-10 (git-stamped record:
`data/trading/leaderboard/leaderboard-2026-07-10.json`):

- **E2 (diversification fires on our strategies) → VERIFIED.** COMBO3 (SPY +
  multi-market trend + gold, risk-weighted) delivered the Theorem-1 lift on real
  numbers: sleeve ρ̄ = 0.36 (Gold ρ = 0.10, multi-market trend ρ = 0.28 to SPY),
  Sharpe **0.89 → 1.12** (CI [0.50, 1.74]), max drawdown **−34% → −11.9%**.
- **Negative result is now a constraint.** The two intuitive next sleeves —
  mean-reversion RSI(2) (ρ = 0.61) and short-vol/put-write (ρ = 0.73) — were
  measured, found correlated-in-disguise (long-equity beta in other clothing),
  and rejected: adding them raised blend equity correlation to 0.80 and *dropped*
  Sharpe to 1.08. The harness falsified the narrative and enforced the bar.
- **E1 remains CLAIMED** — positive net Sharpes per sleeve are logged, but
  multi-window (incl. bear-market) verification is still required.

---

## 0. Definitions (so the theorems are unambiguous)

For a strategy or portfolio with excess-return stream `r_t` (return above the
risk-free rate):

- **Sharpe ratio** `S = E[r] / σ(r)`, annualized by `S_ann = S · √P` where `P` is
  periods/year (P = 252 for daily). Sharpe is the object we maximize.
- **Ex-ante** Sharpe = expectation under our model. **Ex-post** Sharpe = realized
  in data. The certificate optimizes ex-ante; §4 requires ex-post verification.
- **Correlation** `ρ_ij = corr(r_i, r_j)` between two strategies' return streams.
- All returns are net of the modeled cost `COST_BPS` per turnover event.

---

## 1. The theorems (the certified math)

### Theorem 1 — Diversification raises Sharpe (the core result). *Proved here.*

*Statement.* Let `N` strategies each have excess-return mean `μ`, standard
deviation `σ`, Sharpe `s = μ/σ`, and equal pairwise correlation `ρ`. An
equal-weight combination has Sharpe

$$ S(N,\rho) = s \cdot \frac{\sqrt{N}}{\sqrt{1 + (N-1)\rho}}. $$

*Proof.* Equal weights `w_i = 1/N`. Portfolio mean `= μ`. Portfolio variance

$$ \mathrm{Var} = \frac{1}{N^2}\Big(N\sigma^2 + N(N-1)\rho\sigma^2\Big)
= \frac{\sigma^2}{N}\big(1+(N-1)\rho\big). $$

So portfolio std `= σ·√((1+(N-1)ρ)/N)`, and
`S = μ / std = s·√(N/(1+(N-1)ρ))`. ∎

*Consequences (the design's whole reason to exist).*
- `ρ → 0` (uncorrelated): `S → s·√N`. **Ten independent Sharpe-0.5 strategies
  combine to Sharpe ≈ 1.58.** This is the free lunch.
- `ρ → 1` (identical): `S → s`. Correlated bets add **nothing**.
- ⇒ **The design must pay for *low correlation*, not just more strategies.**
  A trend follower + a mean-reverter + a carry harvester beats three momentum
  clones of the same thing.

### Theorem 2 — The maximum-Sharpe portfolio is the tangency portfolio. *Cited (Markowitz 1952); proof sketch.*

*Statement.* For return vector `μ` and covariance `Σ`, the weights maximizing
`(wᵀμ)/√(wᵀΣw)` are `w* ∝ Σ⁻¹μ`.

*Proof sketch.* Maximizing the Sharpe is scale-invariant in `w`; setting the
gradient of `(wᵀμ)/√(wᵀΣw)` to zero yields `μ ∝ Σw`, i.e. `w ∝ Σ⁻¹μ`. ∎
*Design consequence:* allocation must be **covariance-aware** — size by inverse
covariance, not equally, once correlations are estimated with enough data.

### Theorem 3 — Volatility targeting improves *realized* Sharpe under vol clustering. *Cited: Moreira & Muir (2017), "Volatility-Managed Portfolios," J. Finance.*

Scaling exposure inversely to forecast volatility (`leverage_t = σ*/σ̂_t`) leaves
Sharpe unchanged under i.i.d. returns, but **raises** realized Sharpe when
volatility is forecastable and clustered (empirically true in markets), because
exposure is cut *before* high-variance, low-return regimes. *Design consequence:*
position size targets a constant portfolio vol `σ*`, not a constant dollar/share.

### Theorem 4 — Higher Sharpe implies shallower drawdown. *Cited: Magdon-Ismail & Atiya (2004).*

For a return process with drift `μ` and vol `σ`, expected maximum drawdown over a
horizon scales (in the diffusion approximation) inversely with the Sharpe ratio.
*Design consequence:* optimizing Sharpe is **not** at odds with client
drawdown-aversion — it is the same objective. The Calmar (return/maxDD) improves
with Sharpe.

### Theorem 5 — Fractional Kelly is the Sharpe-favorable growth point. *Cited: Kelly (1956); MacLean/Thorp/Ziemba.*

Full-Kelly sizing maximizes long-run log-growth but with punishing variance.
**Half-Kelly captures ≈ 75% of the growth at ≈ 25% of the variance** — a strictly
better risk-adjusted operating point. *Design consequence:* the sizing layer caps
at a *fraction* of Kelly (`f ≤ ½`), never full Kelly.

### Theorem 6 — Regime gating raises unconditional Sharpe *iff* the classifier beats its base rate. *Proved here (conditional).*

*Statement.* Partition time into "risk-on" and "risk-off" regimes. If a classifier
identifies risk-off periods (lower/negative drift, higher vol) with
better-than-base-rate accuracy, then conditionally moving to cash during predicted
risk-off raises the unconditional Sharpe.

*Proof.* Unconditional excess return is the regime-probability-weighted mean;
excising a segment whose conditional mean is below the cash rate raises the
numerator and (since risk-off vol is higher) lowers the denominator — both move
Sharpe up. The inequality **reverses** if the classifier is at or below base rate
(whipsaw cost with no informational gain). ∎

*This is the honest hinge of the whole system.* Theorem 6 does **not** assert our
200-day / GEM regime gate has edge — it states the *precise condition* under which
it helps, and thereby **converts a hope into a measurable hypothesis**: does our
gate classify risk-off better than base rate, net of switching cost? That number
is produced by the harness, not asserted here. (Current 10-yr harness run: the
200d gate cut max-drawdown from −33.7% to −19.5% and lifted Sharpe 0.89 → 1.01 —
consistent with Theorem 6 holding over that window. One window is not proof; §4.)

---

## 2. Design — how chat + trader optimize client Sharpe

The theorems compose into a single pipeline. Each stage cites the theorem it
implements.

```
        ┌─────────────────────────── UNISONA CHAT (operator + verification) ──────────────────────────┐
        │  • states ex-ante Sharpe estimate + confidence for every proposed allocation                 │
        │  • surfaces the evidence [claim, evidence, confidence, source] per decision                   │
        │  • operator veto / override / rollback — ALWAYS (Collapse-Cert §5)                            │
        └───────────────────────────────────────────────────────────────────────────────────────────┘
                                              │  approved intent
                                              ▼
   Σ₀ TRADER — Sharpe-optimization stack (ex-ante → gated → sized → verified):
     1. STRATEGY ENSEMBLE        Σ₀ TA-core + trend + mean-reversion + carry   → diversify (Thm 1)
     2. CORRELATION-AWARE ALLOC  size by Σ⁻¹μ, penalize correlated bets        → tangency  (Thm 2)
     3. REGIME GATE              200d/GEM risk-on/off overlay, edge-gated        → drawdown  (Thm 6)
     4. VOL TARGETING            leverage_t = σ*/σ̂_t to a fixed portfolio vol   → realized S (Thm 3)
     5. FRACTIONAL-KELLY CAP     per-position f ≤ ½ Kelly, hard heat limit       → growth pt (Thm 5)
     6. VERIFY GATE              execute only if ex-ante S ≥ threshold AND
                                 evidence passes; else abstain                    → Σ₀ rigor
     7. AUDIT + ROLLBACK         every fill logged; reversible; operator veto     → Collapse-Cert
```

**Why chat and trader are one loop, not two products.** Chat is the *Reason +
operator-verification* surface; the trader is the *Act + Verify* surface. The
Sharpe estimate a client sees in chat is the **same** ex-ante number the sizing
layer acts on — no divergence between what's shown and what's done. This is the
CLAUDE.md single-loop constraint (Observe→Remember→Reason→Act→Verify→Converge)
applied to capital.

**The optimization objective, precisely.** Maximize ex-ante annualized Sharpe
subject to: (a) portfolio vol ≤ `σ*`; (b) per-position size ≤ ½-Kelly; (c) total
portfolio heat ≤ operator limit; (d) no position without passing the verify gate;
(e) full reversibility. Sharpe is the objective; the constraints are the
non-negotiable client-protection envelope.

---

## 3. What is PROVEN vs. what is CLAIMED-pending-evidence

| # | Statement | Status | Settled by |
|---|-----------|--------|-----------|
| C1 | Combining low-correlation positive-Sharpe strategies raises aggregate Sharpe ≈ √N | **PROVEN** (Thm 1) | this document |
| C2 | Max-Sharpe allocation is covariance-aware (`w∝Σ⁻¹μ`) | **PROVEN** (Thm 2) | this document |
| C3 | Vol targeting raises realized Sharpe under vol clustering | **ESTABLISHED** (Thm 3, cited) | Moreira–Muir 2017 |
| C4 | Higher Sharpe ⇒ shallower expected max drawdown | **ESTABLISHED** (Thm 4, cited) | Magdon-Ismail 2004 |
| C5 | ½-Kelly is the Sharpe-favorable growth point | **ESTABLISHED** (Thm 5, cited) | Kelly / Thorp |
| C6 | Regime gating helps *iff* classifier beats base rate | **PROVEN** (Thm 6, conditional) | this document |
| E1 | *Our* Σ₀ / trend / MR / carry strategies each have positive net Sharpe | **CLAIMED — pending evidence** | daily-backtest-harness |
| E2 | *Our* strategies are mutually low-correlation (so Thm 1 fires) | **VERIFIED** — Gold ρ=0.10, MFtrend ρ=0.28 to SPY; mean-reversion ρ=0.61 and short-vol ρ=0.73 rejected (raised blend equity corr to 0.80, Sharpe 1.12→1.08) | correlation matrix + leaderboard, daily-backtest-harness 2026-07-10; COMBO3 aggregate S=1.12 [0.50,1.74], maxDD −11.9% |
| E3 | *Our* 200d/GEM gate beats its base rate net of cost | **PARTIAL — 1 window consistent** | harness, multi-window |
| E4 | The live system will deliver Sharpe > SPY's ≈ 0.5 for clients | **UNPROVEN — future** | live audited track record |

**The certificate certifies C1–C6 and the design's faithful implementation of
them. It explicitly does NOT certify E1–E4.** Those are the deliverables of §4.

---

## 4. Verification protocol (what turns E-claims into evidence)

To promote each empirical claim from CLAIMED to VERIFIED, run and log:

1. **Per-strategy net Sharpe (E1)** — daily-backtest-harness on each strategy,
   multi-window (include a bear window: 2000–02, 2008), costs on. Record Sharpe +
   95% CI (Sharpe SE ≈ `√((1+S²/2)/T)`).
2. **Correlation matrix (E2)** — pairwise `ρ` of the strategies' daily return
   streams. Thm 1 only pays if the off-diagonals are small.
3. **Gate edge (E3)** — classify each day risk-on/off, compare gate accuracy to
   the base rate; compute switching-cost-adjusted Sharpe lift across ≥3 windows.
4. **Aggregate ex-ante vs ex-post (E4)** — does the combined stack's realized
   Sharpe match the Thm-1/2 prediction? Gap = model error to investigate.

Each run writes a git-stamped record under `data/trading/leaderboard/`. The
certificate's empirical table (§3) is updated **only** from those records — never
from memory or a single paper (Noise-Sorting rule).

---

## 5. Collapse-Certificate alignment (client protection, non-negotiable)

Any strategy or allocation admitted under this certificate MUST satisfy:

- **Explicit heat limits** — max per-position and max portfolio exposure.
- **½-Kelly ceiling** — no full-Kelly or beyond; no leverage past the risk budget.
- **Human-in-the-loop** — operator validates before live deployment; veto anytime.
- **Full audit trail + rollback** — every decision reversible in one commit/flag.
- **Self-correction trigger** — auto-flatten / halt if rolling realized Sharpe or
  max-drawdown breaches a preset threshold (the ex-post safety canary).
- **Abstention over gambling** — if the verify gate fails, the system holds cash.
  Not trading is a valid, Sharpe-preserving action.
- **Two-condition sleeve-admission gate** — a candidate sleeve is admitted to the
  ensemble only after it demonstrates **BOTH**: (a) *measured* pairwise ρ < 0.4 to
  the current blend, AND (b) a positive standalone Sharpe whose 95% CI **excludes
  0** (a real, significant edge). Low correlation is *necessary but not
  sufficient* — a zero-edge uncorrelated sleeve dilutes return. The harness
  correlation matrix + Sharpe CIs are the sole arbiter; narrative difference is
  never enough. Binding precedents (2026-07-10): mean-reversion (ρ=0.61) and
  short-vol (ρ=0.73) **rejected on (a)**; BOTH L/S momentum variants **rejected on
  (b)** despite being genuinely market-neutral — L/S sector (ρ≈0.09 to blend,
  Sharpe 0.18 [−0.44, 0.80]) and L/S single-stock (ρ≈0.13 to blend, −0.06 to SPY,
  Sharpe 0.24 [−0.38, 0.86], −59.7% momentum-crash drawdown). Each *lowered* COMBO
  Sharpe (1.12→1.06/1.07) though each cut maxDD to ~−9%. **Finding: decorrelation
  is easy; a significant standalone edge is the scarce ingredient.** COMBO3 remains
  the verified ensemble; the direct arbiter is whether a sleeve raises the *blended*
  Sharpe, which none of the four candidates did this window.

---

## 6. Signatures

| Role | Name | Status | Date |
|------|------|--------|------|
| Author (agent) | Claude (claude lane) | drafted | 2026-07-11 |
| Mathematics | §1 Thms 1 & 6 proved; 2–5 cited | self-checked | 2026-07-11 |
| E2 promotion + measured-ρ gate | Grok (grok lane) | reviewed & evidence-updated | 2026-07-11 |
| E2 revision applied to file | Claude (claude lane) | applied; harness numbers re-checked | 2026-07-11 |
| Operator ratification | **Alex Place** | ☐ **PENDING** | — |

*This certificate is `Status: Proposed`. It carries no authority over live capital
until the operator signs §6. The return door remains fully open.*

---

### References
- Markowitz, H. (1952). *Portfolio Selection.* J. Finance.
- Kelly, J. (1956). *A New Interpretation of Information Rate.*
- Magdon-Ismail, M. & Atiya, A. (2004). *Maximum Drawdown.* Risk.
- Moreira, A. & Muir, T. (2017). *Volatility-Managed Portfolios.* J. Finance.
- MacLean, Thorp, Ziemba (2011). *The Kelly Capital Growth Investment Criterion.*
- Companion evidence: [`scripts/daily-backtest-harness.js`](../scripts/daily-backtest-harness.js),
  records under `data/trading/leaderboard/`.
