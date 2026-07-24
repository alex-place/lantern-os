# Owned Math — the conjecture slate, with first tests run (M1–M6)

**Date:** 2026-07-21
**Type:** Research program — six theorem-shaped claims built ONLY from objects this project owns
(the both-class ledger, the instrumented loop, the dilation field), each with a kill criterion
stated before work and a **first test executed the same day**.
**Status:** Living slate. Issues: [#2786](https://github.com/alex-place/lantern-os/issues/2786) (M1) ·
[#2787](https://github.com/alex-place/lantern-os/issues/2787) (M2) ·
[#2788](https://github.com/alex-place/lantern-os/issues/2788) (M3) ·
[#2789](https://github.com/alex-place/lantern-os/issues/2789) (M4) ·
[#2790](https://github.com/alex-place/lantern-os/issues/2790) (M5) ·
[#2791](https://github.com/alex-place/lantern-os/issues/2791) (M6) ·
[#2924](https://github.com/alex-place/lantern-os/issues/2924) (M7)
**Loop stages:** Verify (M1, M3, M4, M6) · Converge (M1, M2, M7) · Act/route (M5)

**Grounding contract — External Reality Rule.** Tags: **[measured — this note]** (a number
produced by a run committed alongside), **[derived — this note]** (analytical result written
out here), **[refuted — this note]** (first test killed the claim as stated; pivot recorded),
**[grounded]** (external literature, named), **[conjecture]** (stated with kill criterion,
unproven). Prior art is named per claim — the point is to *occupy* the frontier honestly, not
to pretend it is empty.

**Reads first:** [`../SIGMA0-COLLAPSE-CERTIFICATE.md`](../SIGMA0-COLLAPSE-CERTIFICATE.md) ·
[`2026-06-30-pumped-lossy-resonator.md`](2026-06-30-pumped-lossy-resonator.md) ·
[`2026-07-21-tesseract-application-map.md`](2026-07-21-tesseract-application-map.md) ·
[`../KEYSTONE-IP-AND-BUILDOUT.md`](../KEYSTONE-IP-AND-BUILDOUT.md) §4.3–4.6

---

## TL;DR

> Six candidate theorems, all terminating in quantities already flowing through
> `records.jsonl` or the canaries — **theorems with telemetry**. First tests ran today:
> **M4 supported** (Kreiss-inflated thresholds: naive monitor false-alarms 100% on healthy
> non-normal decay, inflated threshold 0%, instability still caught 100%). **M3 refuted as
> stated and pivoted** — the probe found a large structured *silent set* (self-consistent
> stationary loops fool both canaries), which upgrades the claim to an **indistinguishability
> lemma** whose corollary is that the #1012 hard re-grounding cadence is *mathematically
> necessary*, not merely prudent. **M1/M2 terms measured** on the real ledgers (free-confidence
> mass 20.8%; staleness half-life 48–337 h, instrumentation-limited; derived T\* bracket 3–31
> min contains the shipped 30-min tick). **M5 derived** — the shipped dilation heuristic's two
> strangest features (the fetch cutoff and the G12 collapse-deflation) fall out of one KKT
> water-filling frame; one mismatch found (linear vs log breadth ramp) → an A/B. **M6 stated.**
> Two instrument-circularity bugs were caught and kept as findings — both are miniatures of
> the very phenomena the theorems are about.

---

## 0. Status board

| # | Claim (short) | First test | Verdict today | Issue |
|---|---|---|---|---|
| **M1** | No-Free-Confidence inequality | ledger term scan | **[measured]** terms exist; inequality formalizable; clamp empirically holds | [#2786](https://github.com/alex-place/lantern-os/issues/2786) |
| **M2** | Grounding half-life → EOQ cadence T\* | ρ fit from calibration ledger | **[measured — instrumentation-limited]** T\* bracket contains the shipped 30 min | [#2787](https://github.com/alex-place/lantern-os/issues/2787) |
| **M3** | Two-canary completeness dichotomy | silent-set hunt (45 cells) | **[refuted as stated → pivoted]** to indistinguishability lemma; cadence necessity derived | [#2788](https://github.com/alex-place/lantern-os/issues/2788) |
| **M4** | L3: Kreiss-inflated thresholds survive non-normality | synthetic Jordan family | **[supported synthetically]** perfect FA/detection separation | [#2789](https://github.com/alex-place/lantern-os/issues/2789) |
| **M5** | Dilation = water-filling optimum | KKT derivation vs shipped code | **[derived]** cutoff + G12 fall out; linear-vs-log mismatch found | [#2790](https://github.com/alex-place/lantern-os/issues/2790) |
| **M6** | Lasing threshold (per-mode G/L) | — | **[conjecture]** statement only | [#2791](https://github.com/alex-place/lantern-os/issues/2791) |
| **M7** | Attribution loss: the composed law's anti-runaway guarantee is unsatisfiable over global signals | two-world counterexample vs SHIPPED code | **[derived + measured 2026-07-24]** laundered runaway survives 40/40 steps; keyed guard shipped; starvation corollary measured | [#2924](https://github.com/alex-place/lantern-os/issues/2924) |

Artifacts: [`owned_math_m1_m2_ledger_scan.py`](../../experiments/owned_math_m1_m2_ledger_scan.py) ·
[`owned_math_m3_dichotomy_edgecase.py`](../../experiments/owned_math_m3_dichotomy_edgecase.py) ·
[`owned_math_m4_kreiss_transient.py`](../../experiments/owned_math_m4_kreiss_transient.py) →
JSON reports in [`experiments/results/`](../../experiments/results/).

---

## M1 — The No-Free-Confidence inequality

**Statement [conjecture].** Let J_t be justified confidence (proxy: log-det posterior
precision; ledger proxy: 1−Brier over graded records). Then along any run,
`ΔJ_t ≤ η·E_t − λ·U_t`, where E_t is external-evidence influx (precision added by
measurement/grounding events; refutations enter with sign) and U_t is unverified-confidence
mass. **Confidence growth with zero evidence influx is bounded, and sustained growth forces a
canary.** Linear-Gaussian core: the information-filter update adds precision *only* through
measurement terms (`Λ_post = Λ_pred + Σ H'R⁻¹H`), and the prediction step with process noise
strictly leaks it — the pump/leak structure of the resonator doc, as algebra.

**First test [measured — this note].** Scan of the real ledger (1,205 records):
confidence mass total **870.7**; evidence-or-graded **689.8**; **FREE mass 180.9 = 20.8%**
(no evidence, ungraded — dominated by gemini chat-interaction records, 165.3 of 180.9);
**zero** records with c ≥ 0.8 unanchored — the `allowed_max_confidence` clamp is doing exactly
what the inequality demands at the top of the range. Both-class grading is real: 64 verified +
20 refuted.

**Next / kill.** Write the precision-form proof; machine-check (L2 pattern); longitudinal
per-hypothesis test. Killed by a legitimate regime of confidence growth with zero influx and
no canary.

**Prior art [grounded]:** information filter / precision additivity (textbook); data-processing
inequality. **Ours:** the both-class ledger mapping (refutations as negative evidence) and the
measured product-side clamp.

## M2 — The grounding half-life law

**Statement [conjecture].** Claims go stale at rate ρ (per claim-type). Under a renewal model
with verification price p_v and error cost p_e, the optimal re-grounding interval is the EOQ
square-root law **T\* = √(2·(p_v/p_e)/ρ)** — the shipped 30-minute `GROUNDING_TICK` becomes a
*derived* quantity, per-topic.

**First test [measured — instrumentation-limited].** `grounding-calibration.jsonl` holds 371
events over only **6 keys**, heavily bursty (311 consecutive pairs < 60 s). Raw fit: 7
success→failure flips over 486 h exposure → ρ̂ = 0.0144/h, **half-life ≈ 48 h**. De-burst
(≥60 s spacing): **1 flip** → ρ̂ = 0.0021/h, **half-life ≈ 337 h**. The 7× spread *is* the
finding: the ledger cannot yet support per-topic ρ. Still, the derived bracket
**T\* = 3.1–31.2 min** across p_v/p_e ∈ [0.01, 1] **contains the shipped 30-min tick** — the
magic constant is defensible under the crude fit.

**Next / kill.** Instrument spaced probes over many keys; per-claim-type ρ; ship derived
cadences. Killed if T\* is unstable across resamples.

**Prior art [grounded]:** age-replacement / inspection-maintenance theory; EOQ. **Ours:** the
grounding-economy application, estimated from a *refutation* ledger the system writes about
itself.

## M3 — From completeness dichotomy to the indistinguishability lemma

**Original claim [refuted as stated — this note].** "For the ungrounded linear loop
`x_{t+1} = ρR(θ)x_t + w`, every trajectory trips degeneration (isotropization/freeze) or
surprise (NIS mis-calibration) — the two canary axes are jointly complete."

**First test.** 45-cell probe over (θ, noise-anisotropy κ, ρ) with toy instrument semantics
(prequential EW mean/cov monitor, NIS band vs χ²₂, anisotropy + freeze bands):
**27/45 cells silent** — and the silent set is *structured*, not edge-case: stationary
anisotropic AR loops (θ∈{0,π}, ρ≤1) sit with calibrated NIS ≈ 2.0 and healthy anisotropy
forever; even random walks stay silent because the EW monitor **tracks the drift** — the
boiling frog, reproduced in 40 lines. Bonus instrument finding, kept deliberately: v1 fit the
monitor on the same window it scored, making in-sample NIS ≡ d — **a self-refit ungrounded
monitor is silent by construction**, the whole phenomenon in miniature.

**The pivot [conjecture — the real theorem].** **Indistinguishability lemma:** no measurable
functional of the internal trajectory alone separates a grounded stationary loop from an
ungrounded loop with the same trajectory law (two generative processes, identical pushforward
measure). **Corollary: hard-cadence external re-grounding (#1012) is *necessary* — no internal
monitor, however clever, can replace it.** The shipped boiling-frog defense stops being a
prudent heuristic and becomes a theorem's conclusion.

**Next / kill.** Write the measure-theoretic proof; machine-check; fold into the certificate
corpus. The *lemma* dies if someone exhibits a computable internal functional separating the
probe's silent set.

**Prior art [grounded]:** the Boiling Frog Threshold result ([arXiv:2603.08455](https://arxiv.org/abs/2603.08455))
showed internal monitors carry no extractable signal for gradual drift; Kalman fault-detection
detectability. **Ours:** the trajectory-law formalization over our specific two-canary
instrument set, and the cadence-necessity corollary tied to shipped code.

## M4 — L3: Kreiss-inflated thresholds close the non-normal gap

**Statement [conjecture, supported synthetically].** The certificate's Theorem 1 covers normal
operators. For non-normal A with spectral radius < 1, transients grow before decaying; the
Kreiss matrix theorem bounds them: `sup_t ‖A^t‖ ≤ e·n·K(A)`. **L3:** canary thresholds
inflated by `e·n·K(A_nominal)` retain their guarantee — no false alarm on healthy non-normal
transients, detection preserved on genuine instability.

**First test [measured — this note].** Family `A=[[r,k],[0,r]]`: measured max transients
**3.9× / 19.4× / 77.5×** (k=1/5/20, r=0.9) all violate the naive spectral envelope and all sit
under the Kreiss envelope (bound holds 5/5). Detection protocol with **nominal-model**
thresholds: naive false-alarm rate **100%** on healthy non-normal decay vs L3 **0%**; true
instability (r=1.02) caught **100% by both**. Protocol bug caught and kept: v1 computed K from
the *monitored* matrix — an unstable A inflates its own threshold to ∞ and can never fire;
thresholds must come from the nominal healthy model.

**Next / kill.** Machine-check the finite-horizon lemma; compute K for the real Ouro loop
Jacobians and re-derive shipped canary thresholds. Killed in practice if real-loop K is so
large the inflated threshold never fires on recorded collapse events (then: band-limited
pseudospectral version or vacuous).

**Prior art [grounded]:** Kreiss matrix theorem, pseudospectra (Trefethen). **Ours:** the
applied detection lemma over our canaries, machine-checked — L2's pattern, next letter.

## M5 — Dilation derived: grounding allocation is log water-filling

**Derivation [derived — this note].** Nodes i with uncertainty u_i, grounding budget b_i ≥ 0,
Σb_i ≤ B, residual-error model `e_i(b) = u_i·exp(−γ_i b)` (diminishing returns; γ_i = marginal
value of grounding at node i). KKT on the Lagrangian gives **log water-filling**:

```
b_i* = max(0, (1/γ_i)·ln(γ_i·u_i / ν))        ν = water level from the budget
```

Three consequences line up with shipped code
([`grounding-policy.js`](../../apps/lantern-garage/lib/grounding-policy.js) /
[`dilation.py`](../../src/convergence_io/dilation.py)):
1. **The hard cutoff exists** — nodes below the water level get *zero* (shipped:
   `fetch_external = false` for D ≤ 0.5). Falls out of KKT, not taste.
2. **The G12 collapse-deflation falls out** — a frozen/confidently-wrong node has γ_i → 0
   (more retrieval has no marginal value there): allocation → 0, i.e. D → D_MIN. The
   sign-fix that needed a paragraph of prose in #764 is one line of KKT.
3. **One mismatch [finding]:** shipped breadth scales **linearly** with D
   (`max_results ∝ D`) where the optimum grows **logarithmically** in u — the live policy
   likely over-spends on the highest-uncertainty nodes. Testable: log-ramp vs linear-ramp A/B
   at equal latency (pairs with the application map's A8).

**Next / kill.** Run the A/B; stretch goal — Whittle-index form of claim re-verification as a
restless bandit (indexability proof would be genuinely publishable). Killed if the log-ramp
shows no groundedness-per-latency win.

**⚠️ IP gate.** Dilation-as-grounding-budget is the register's §4.4/§6 **patent opt-out
candidate**. The primitive is already publicly disclosed in the register; this sketch stays at
the level of that disclosure. Before publishing a proof-grade derivation *plus measured win*,
re-confirm the opt-out decision per [`../KEYSTONE-IP-AND-BUILDOUT.md`](../KEYSTONE-IP-AND-BUILDOUT.md) §6
(publication forecloses).

**Prior art [grounded]:** reverse water-filling (rate-distortion), sensor
selection/scheduling, value-of-information, restless bandits/Whittle. **Ours:** the grounding
economy instantiation, the γ→0 account of collapse-deflation, and the tie to shipped code.

## M6 — The lasing threshold

**Statement [conjecture].** Per-mode linearization with resonant gain G and verify-leak L:
modes with **G/L > 1 and zero external-innovation coupling** grow without bound — the
confident-but-unanchored axis as a sharp threshold, estimable from decode telemetry
(self-repeat gain vs canary damping). Ranked last: a stability condition in costume; its value
is the measured corollary (lead-time over the NIS canary on `canary-events.jsonl`), and it
inherits M3's boundary — the threshold is only informative *given* external innovation exists
to couple to. Killed by no lead-time.

## M7 — Attribution loss: the composition is not sound over global signals

**Statement [derived — proofs note Lemma 3] + [measured 2026-07-24 — against SHIPPED code].**
The unified control law (#2857) composes M1/M2/M4/M5/M6 through a **global per-step signal
vector**; but M6's kill side-condition ("G/L > 1 *and zero external-innovation coupling*") is
**per-mode**. Two-world counterexample: an *anchored* run (evidence for the lasing mode every
step) and a *laundered* run (zero evidence ever for the mode; an unrelated feed sets the
global influx bit) produce **identical signal histories** — so no causal policy over the
global vocabulary is both M6-sound and non-vacuous. Measured against the shipped
`convergeControl`: the laundered runaway survives **40/40 steps** at final confidence
0.9999986, per-step reason *"improving on external evidence."* **Starvation corollary:** the
shipped allocation (provenance-blind u = 1−c) is strictly decreasing in laundered confidence
(D → 0.500001, the knife-edge of the `D > 0.5` fetch cutoff; G12 deflation double-starves a
self-repeating laser) — the runaway suppresses its own kill switch *and* de-allocates its own
audit. Completes the M3 arc: **hard cadence is necessary (M3) but cadence + allocation
without attribution is not sufficient (M7).** Guard shipped default-compatible
(`evidenceForMode` keyed anchor; kill at step 1; legacy calls unchanged); the attribution
vocabulary is **M1's paid/free split**, which the ledger already emits. Full note:
[`2026-07-24-owned-math-m7-attribution.md`](2026-07-24-owned-math-m7-attribution.md) ·
artifact [`owned_math_m7_composition_counterexample.js`](../../experiments/owned_math_m7_composition_counterexample.js)
(first slate artifact to drive the real code paths, not toy semantics).

**Next / kill.** #2791 instrumentation must tag grounding events with the mode they anchor
(else the keyed bit is not computable live and guarantee (a) must be withdrawn from the law's
header); allocator requirement recorded (u must be anchored uncertainty 1 − c_paid — M5
IP-gate unchanged). Lemma 3's impossibility half dies if the real M6 estimator provably
entangles gain and coupling; the counterexample against the shipped global-bit rule survives
either way.

**Prior art [grounded]:** discrete-event fault diagnosability (Sampath et al. 1995) —
observation-equivalent faulty/nominal traces; static-output-feedback distinguishability.
**Ours:** the instantiation on the shipped law, the executable two-world artifact, the
starvation corollary tying M5/G12 into the same mechanism, and the sibling relation to M3
(trajectory level → step-signal level).

---

## 7. Frontier position — how this becomes *ours*

1. **Vehicle.** This commit is the **defensive publication + priority timestamp** for every
   claim above at its current grade (per the register's strategy: publish methods, trademark
   names, patent only deliberate opt-outs). M5's proof-grade extension is the one item behind
   an explicit gate.
2. **arXiv candidates once proven:** M3's indistinguishability lemma + cadence-necessity
   corollary (the strongest — it *derives* a shipped defense), and M4/L3 (the certificate's
   sequel lemma). The certificate precedent (§4.6: math → arXiv, machine-checked) is the
   template.
3. **What makes the slate defensible** is not that the tools are new (they are named above,
   every one) — it is that **every theorem terminates in telemetry the product already
   emits**, and the proofs will be machine-checked against those streams. Prior art owns the
   tools; nobody owns theorems about *this instrumented loop*, because nobody else runs it.
4. **Discipline:** kill criteria were stated before the first tests ran; two of six claims
   took damage on day one (M3 refuted-as-stated, M2 instrumentation-limited) and the slate
   reports it. That is the difference between occupying a frontier and decorating one.

---

## 8. Progress log — 2026-07-21, second pass (issues worked)

All six issues advanced the same day the slate landed. New artifacts:
[`owned_math_m1_precision_check.py`](../../experiments/owned_math_m1_precision_check.py) ·
[`owned_math_m2_bootstrap.py`](../../experiments/owned_math_m2_bootstrap.py) ·
[`owned_math_m3_indistinguishability.py`](../../experiments/owned_math_m3_indistinguishability.py) ·
[`owned_math_m4_ensemble.py`](../../experiments/owned_math_m4_ensemble.py) ·
[`owned_math_m5_allocation_sim.py`](../../experiments/owned_math_m5_allocation_sim.py) ·
[`owned_math_m6_canary_census.py`](../../experiments/owned_math_m6_canary_census.py) (+ JSON reports).

**M1 — lemma machine-checked + ledger clean [measured].** The exact decomposition
`ΔJ = evidence_term + dynamics_term` with `evidence_term ≥ 0` and
`dynamics_term ≤ 2·log(1/|det A|)` held with **0 violations over 9,000 information-filter
steps across 300 random systems** (evidence-precision monotonicity also 0 violations;
decomposition exact to 1e-9). Positive no-evidence growth occurred **only** through the
contraction channel (1,890 of 8,940 contracting steps) — the collapse-suspect mode, never a
third source. **Ledger longitudinal test:** among 24 repeated hypotheses (50 consecutive
same-hypothesis pairs, generic chat heartbeats excluded), **0 paid-growth violations** —
today's ledger satisfies No-Free-Confidence. Remaining for proof-grade: write §M1 as a lemma
with the Minkowski-determinant step spelled out, machine-check symbolically (L2 pattern).

**M2 — kill criterion executed: fires for the data, not the law [measured].** Cluster
bootstrap over keys (B=2000): **32.9% of resamples cannot define ρ at all** (zero flips);
half-life CI **[21.6 h, 866 h]** (40×); T\* CI [2.5, 15.8] min at p_v/p_e=0.1. Recorded
verdict: the estimator is sound, the 6-key bursty ledger is not — **per-topic cadences are
blocked on instrumentation** (spaced probes over many keys), which
[#2787](https://github.com/alex-place/lantern-os/issues/2787) now specifies.

**M3 — lemma's computational half done [measured].** Equal-law construction (perfect tracker
of an external AR world vs the self-driven loop): passive battery of five internal
functionals — mean prequential NIS, anisotropy, lag-1 autocorrelation, step norm, state norm —
**non-separating across 200 runs each** (KS D 0.06–0.125, p 0.08–0.85). The interventional
probe **separates perfectly**: grounded recovery median **1 step** (the next observation of
the untouched world snaps the tracker back) vs ungrounded **22 steps** (pure dynamical decay,
consistent with ρ=0.9 theory), KS D = 1.0, p ≈ 0. Passivity cannot separate grounded from
ungrounded; one intervention against the external channel does — the cadence-necessity
corollary, now demonstrated end to end. Remaining: the two-paragraph measure-theoretic
write-up (equal pushforward ⇒ equal functional distributions) for the certificate corpus.

**M4 — ensemble upgrade: bound universal, one honest trade surfaced [measured].** Beyond the
hand-picked Jordan family: 150 random stable matrices (n 2–4, spectral radius 0.9, Henrici
non-normality up to **0.935**): envelope `M ≤ e·n·K(A)` — **0 violations**, margin never
below 2.2× (non-vacuous, never breached; no grid refinement even triggered). Detection on a
40-system subset with nominal-model thresholds: healthy false-alarm **naive 44% vs L3 0%**;
unstable-twin detection **naive 100% vs L3 93%**. The 7-point detection gap concentrates in
the highest-K systems where the inflated threshold is slow inside the 150-step horizon —
i.e., **L3 trades false alarms for detection latency on extreme non-normality**, which is
exactly the band-limited refinement path the issue's kill criterion anticipates. Real-loop
Jacobians (the GPU step) remain the open item on
[#2789](https://github.com/alex-place/lantern-os/issues/2789).

**M5 — hypothesized gain quantified offline [measured].** Across three node populations ×
three budgets: KKT water-filling beats the faithful shipped linear-ramp allocator by
**1.5–14.5% (median 6.1%)** total residual error under the derivation's own model — and,
the robustness check, **still wins under a misspecified power-law returns model
(0.5–8.2%, median 5.2%)**. Robust-positive but modest → the live A/B (application map A8)
decides; no policy change from simulation alone. IP gate unchanged.

**M6 — blocked on instrumentation, now precisely specified [measured].** Census of
`canary-events.jsonl`: 61 events (7 collapse-tripped, 54 grounded-pass), all signals are
**terminal scalars** — `events_with_time_series_signals = 0`. Lead-time analysis is
impossible on today's log. Instrumentation ask (in
[#2791](https://github.com/alex-place/lantern-os/issues/2791)): flag-gated per-token signal
trajectories for both fired and non-fired generations, sampled; then estimate per-mode
gain/leak and measure crossing→fire lead time.

### 8.1 Third pass (same day) — proofs, product instrumentation, refinements

**M1 — proven + exact-checked.** Formal statement and proof written
([`2026-07-21-owned-math-proofs.md`](2026-07-21-owned-math-proofs.md) Lemma 1), and the two
load-bearing inequalities re-checked in **exact rational arithmetic** (no tolerances):
0 violations / 200 random rational systems
([`owned_math_m1_exact_check.py`](../../experiments/owned_math_m1_exact_check.py)).

**M3 — proven via the innovations representation, generalized beyond the corner.** Proof note
(Lemma 2 + both corollaries) rides Kailath's innovations representation: **every**
steady-state Kalman tracker has an ungrounded doppelgänger of identical law — passive
indistinguishability holds at every observation-noise level, not just perfect observation.
Machine check per r ∈ {0.01, 0.25, 1.0, 4.0}
([`owned_math_m3_innovations.py`](../../experiments/owned_math_m3_innovations.py)): passive
battery non-separating (honest wrinkle: at r=4.0, 2 of 16 tests show nominal p<0.05 —
marginal after multiple-comparison correction; flagged for a higher-power recheck rather than
hidden). The gain-separability corollary measured: tracker probe-recovery 3→6 steps as gain
falls (spec radius A(I−K) 0.651) vs the mimic's constant 22 — **grounding quality is probe
separability**, quantified.

**M4 — the L3′ envelope threshold closes the gap completely [measured].** Time-indexed
threshold `τ_t = 1.05·c·‖A_nom^t‖` (zero FA by construction): across the extreme-K family +
the 6 highest-K random systems — healthy FA **0.0 everywhere**, unstable detection **1.00
everywhere** (flat threshold's minimum was 0.95), median detection time **3–7 steps vs the
flat threshold's 14–79** ([`owned_math_m4_envelope.py`](../../experiments/owned_math_m4_envelope.py)).
L3′ is the shippable form; the flat e·n·K bound remains the proof device.

**M5 — the log ramp is now product code, default-off.**
[`grounding-policy.js`](../../apps/lantern-garage/lib/grounding-policy.js) gained
`GROUNDING_RAMP=log` / `{ ramp: "log" }` (breadth = base·(1+ln D) above the water level), with
Python parity in [`dilation.py`](../../src/convergence_io/dilation.py) and 7 unit tests
([`grounding-policy-ramp.test.js`](../../apps/lantern-garage/test/grounding-policy-ramp.test.js));
24 existing dilation tests still green. The live A/B (map A8) can now run by flipping one env
var.

**M6 — the instrumentation exists, default-off.** `CANARY_TRACE=1` records the per-generation
signal **trajectory** (sampled where the mid-stream collapse guard already scores; bounded at
48 points; reset on provider retries) and emits events for healthy generations too — the
both-class data the lead-time analysis needs
([`canary.js`](../../apps/lantern-garage/lib/canary.js) `createCanaryTrace`,
[`stream-chat.js`](../../apps/lantern-garage/lib/stream-chat.js) wiring, 4 unit tests). Local
(ollama) path first — where collapse events actually occur; cloud paths need a token-cadence
sampler, noted in [#2791](https://github.com/alex-place/lantern-os/issues/2791).

**M2 — the survey closed the "maybe another ledger" question [measured].** Every longitudinal
outcome stream the repo writes was graded for ρ-fittability
([`owned_math_m2_ledger_survey.py`](../../experiments/owned_math_m2_ledger_survey.py)):
best is grounding-calibration with **1** fittable key; council-reviews has 63 keyed entities,
**0** fittable. **No existing stream can power the staleness law** — the spaced-probe
instrumentation is confirmed as the only path, not merely the preferred one.

---

## 9. Honest scope

- Nothing here is proven yet. M4 is *supported synthetically*; M3's lemma is *conjectured
  after refutation of its predecessor*; M1/M2 have *measured terms*, not theorems; M5 is a
  *derivation under a chosen error model* (exponential returns — the conclusion's shape
  depends on it); M6 is a statement.
- The M3 probe and M4 demo use toy instrument semantics (like X4 before them) — they validate
  *claim content*, not the shipped canaries' exact code paths.
- The two v1 instrument bugs (in-sample NIS; self-referential Kreiss threshold) are kept in
  the doc because both are the phenomenon under study appearing inside the study — and because
  hiding fixed bugs is how ledgers start lying.
- No new subsystem. Every claim strengthens Verify or Converge on existing surfaces; the only
  code added is `experiments/`.
