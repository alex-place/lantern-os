# Prediction Markets as External Grounding / Reward Signal — Literature Survey

**Issue:** #520 · **Epic:** #509 · **Type:** Research · **Date:** 2026-06-15

**Question:** Is using prediction markets (Kalshi, Polymarket) as an external
grounding / reward signal for ML agents a viable approach for Lantern OS?

**Verdict (TL;DR):** **Partially viable, with a strong theoretical foundation and
a hard practical constraint.** Prediction-market mechanisms are *formally
equivalent to online learning*, so a market price is a principled, calibrated
training target — this is well-established theory, not speculation. The blocker
is **reward latency**: market resolution can take hours to months, which turns
training into a sparse/delayed-reward problem. The recommended path is to use the
*continuously-updating market price* (a proper-scoring-rule signal available every
tick) as the grounding signal, and reserve *resolution* as a periodic ground-truth
anchor — not the per-step reward.

---

## 1. Literature survey

### A. Prediction markets ARE learning algorithms (the core result)

- **Chen, Y. & Vaughan, J. W. (2010). "A New Understanding of Prediction Markets
  via No-Regret Learning." ACM EC 2010.**
  Establishes a formal duality: a **Logarithmic Market Scoring Rule (LMSR)**
  market maker is mathematically equivalent to a **Follow-the-Regularized-Leader
  (FTRL)** no-regret online learner. The market's price path *is* the iterate of
  an online-learning algorithm; the market maker's worst-case loss is its regret
  bound. This is the key reason a market price is a sound learning target.

- **Abernethy, J., Chen, Y. & Vaughan, J. W. (2013). "Efficient Market Making via
  Convex Optimization, and a Connection to Online Learning." ACM TEAC.**
  Generalizes the above: *cost-function-based* market makers correspond to
  online convex optimization with a convex regularizer. Gives a recipe for
  constructing markets with desired bounds — i.e. you can design the grounding
  signal's properties.

- **Hanson, R. (2007). "Logarithmic Market Scoring Rules for Modular Combinatorial
  Information Aggregation." Journal of Prediction Markets 1(1).**
  The LMSR primitive itself (the mechanism Kalshi-style markets approximate).
  Relevant because LMSR's scoring rule is the **log loss** — the same objective
  ML models already optimize.

### B. Why a market price is a *good* target (proper scoring rules)

- **Gneiting, T. & Raftery, A. E. (2007). "Strictly Proper Scoring Rules,
  Prediction, and Estimation." JASA 102(477).**
  A *strictly proper* scoring rule is uniquely maximized by reporting the true
  probability. The logarithmic score (= cross-entropy / log loss) and the Brier
  score are strictly proper. Consequence: training an agent to match a
  market-implied probability under a proper scoring rule incentivizes
  **calibration**, not just accuracy — the property we want from a grounding
  signal.

### C. The practical obstacle (delayed / sparse rewards)

- **Arjona-Medina, J. et al. (2019). "RUDDER: Return Decomposition for Delayed
  Rewards." NeurIPS 2019.**
  Documents why delayed, sparse rewards break credit assignment in RL and offers
  return-decomposition as a mitigation. Directly applicable: market *resolution*
  is a delayed reward; naive use produces high-variance, slow learning.

### D. Practitioner / applied evidence

- **"Machine learning augmentation reduces prediction error in collective
  forecasting" (PMC10502359).** Uses an LMSR-based point-reward system to
  incentivize early-and-accurate human forecasters, with ML augmentation —
  empirical evidence that LMSR rewards drive useful forecasting behavior.
- **Gensyn, "Prediction Markets are Learning Algorithms" (2024, blog).** A
  current practitioner synthesis of the Chen/Vaughan/Abernethy line for ML/RL.

---

## 2. Does market resolution time affect training loops? (Yes — decisively)

| Signal | Availability | Use in a training loop |
|--------|-------------|------------------------|
| **Market price** p(t) | Every tick (Kalshi ~seconds) | **Dense** grounding target via a proper scoring rule. No delay. |
| **Price change / surprise** Δp | Every tick | Innovation/surprise signal (already used by the Σ₀ NIS canary). |
| **Resolution** (YES/NO) | Hours → months | **Sparse, delayed** ground-truth anchor. Verification, not per-step reward. |

The resolution delay is the crux. Treating *resolution* as the reward yields a
classic sparse/delayed-reward problem (RUDDER). Treating the *price* as the
target sidesteps it: by the no-regret duality, the price is already a calibrated
running estimate, so matching it is a dense, low-latency learning signal. The
resolution then plays the role of an occasional unbiased anchor that re-grounds
the price target (and lets you measure the agent's calibration error after the
fact).

---

## 3. Viability verdict

**Viable as a *grounding* signal; not directly viable as a *per-step RL reward*.**

- **Strong:** the theory (Chen & Vaughan; Abernethy et al.; Gneiting & Raftery)
  says a market price under a proper scoring rule is a principled, calibrated,
  low-latency target. This is exactly the kind of *external* signal the Σ₀
  collapse analysis (#509, arXiv:2402.07043) says is required to avoid collapse
  (the real-data fraction π > 0).
- **Constraint:** resolution latency makes resolution-as-reward a delayed-reward
  RL problem. Funding/inventory constraints and market thinness (Kalshi tight
  bands) add noise and partial observability.
- **Honest scope:** Lantern OS does not currently *train* a model online (per
  CLAUDE.md: "persistent learning, not weight modification"). So in the near
  term this is a **validation / grounding** signal feeding the convergence
  records and the Σ₀ surprise loop — not a gradient-descent reward.

---

## 4. Proposed wiring into Lantern OS (if pursued)

Grounding-signal path (no model retraining required — fits the Convergence Core):

1. **Dense grounding target** — treat the de-vigged Kalshi mid-price `p(t)` as
   the external observation `y` in the Σ₀ Kalman surprise monitor
   (`src/cio_sde/surprise.py`). This fixes the current `y=x` self-observation gap
   (engine.py:321 "for now") with a *real* external signal — the exact π>0
   grounding the double-scaling law requires.
2. **Proper-scoring-rule scoring** — log-score the agent's probability against
   `p(t)` each tick; append `{t, p_market, p_agent, log_score}` to a convergence
   record (`data/kalshi/cio-accuracy-log.jsonl`, already populated by #425).
3. **Resolution anchor** — when a market resolves, append the unbiased outcome to
   a separate JSONL and compute realized calibration (Brier/log) over the window.
   This is the periodic external re-grounding, not the per-step reward.
4. **(Future) reward use** — only if/when Lantern adds online training, use the
   *price-tracking* log-score as the dense reward and apply RUDDER-style return
   decomposition for the resolution anchor. Flagged as out of current scope.

This reuses existing infrastructure (#425 accuracy log, #507/#523 grounding demo,
PR #511 surprise loop) and changes the grounding signal from synthetic
self-observation to a real, calibrated, externally-determined price.

---

## 5. Honesty / provenance notes

- **Unverified prior citation:** the earlier stub `docs/prediction-markets-as-grounding.md`
  and `docs/SIGMA0-COLLAPSE-CERTIFICATE.md` cite **`arXiv:2309.01219` as
  "Using Prediction Markets to Validate ML Models."** I could **not** verify that
  this arXiv id maps to that title; it should be confirmed or removed. This survey
  deliberately relies on the independently-verifiable references in §1 instead.
- All §1 references are established, citable works (venues: ACM EC, ACM TEAC,
  NeurIPS, JASA, J. Prediction Markets) located via literature search 2023–2026.
- No claim here asserts that Lantern OS currently trains on market rewards — it
  does not. This is a viability survey plus a proposed integration.

---

## 6. Live wiring in Lantern OS (absorbed from `docs/prediction-markets-as-grounding.md`, 2026-07-16)

The Kalshi tight-band terminal (`public/kalshi-terminal.html`)
already uses prediction markets as an operational grounding signal:

- **Collapse detection** — a market discontinuity (large price jump) registers as
  a surprise spike in the Σ₀ anti-collapse loop (PR #511).
- **Recovery validation** — post-discontinuity price stabilization validates the
  recovery excitation; measured < 5 min in the #507 grounding demo.
- **Baseline accuracy** — agent performance vs human traders; 40% tight-band
  accuracy at the 2026-06 baseline, tracked daily in
  `data/kalshi/cio-accuracy-log.jsonl` (#425). A/B target: anti-collapse ON vs
  OFF > 2% accuracy gain.

Integration points: `routes/trading.js` (Kalshi REST),
`lib/kalshi-collector.js` (6s polling + 429 backoff with
`Retry-After`).

Additional verified references carried over: Wolfers & Zitzewitz (2004),
*Prediction Markets*, J. Economic Perspectives 18(2):107–126 — verified 2026-06-17
(#660); Dohmatob et al. (2024), *A Tale of Tails: Model Collapse as a Change of
Scaling Laws*, arXiv:2402.07043 (ICML 2024); Bar-Shalom, Li & Kirubarajan (2001),
*Estimation with Applications to Tracking and Navigation*.
