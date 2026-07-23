---
author: Alex Place (drafted by Claude lane under operator direction, 2026-07-23)
created: 2026-07-23
status: DRAFT design of record — landed with one binding condition (external review, 2026-07-23):
  the FIRST follow-up engineering slice is P0 (wire JSRR onto the default serve path; arm Σ₀⁻¹
  under a bounded intervention budget). No base-model bake-offs and no training runs before the
  certificate's own runtime gates are live. An ADR follows operator acceptance.
---

# The Σ₀ LLM — design of record for the owned local model

*A FrugalGPT-grade product: the most verified correct answers per dollar on the computer you
already own. One small, stable, looped core; a real verifier around everything; the frontier as a
rare teacher, never a runtime dependency.*

**Inputs this design merges (all grounded this session, 2026-07-23):**
[small-model SOTA theory (#2877)](2026-07-23-small-model-sota-theory.md) ·
[Collapse Certificate](../SIGMA0-COLLAPSE-CERTIFICATE.md) ·
[ADR-0030 Spiral](../adr/0030-spiral-verified-cascade-harness.md) /
[ADR-0031 ARC-AGI-2 niche](../adr/0031-spiral-coder-arc-agi2-efficiency-target.md) ·
the Grok red-team (2026-07-23, external adversarial pass) ·
[SIGMA0-OURO-CODER](../SIGMA0-OURO-CODER.md).
Evidence classes follow the certificate's taxonomy: **PROVEN / MEASURED / IMPORTED / PREDICTED /
NOT-VALIDATED**. Do not upgrade a class when citing this document.

---

## 1. The claim (falsifiable, Pareto form — imported from #2877 verbatim)

**Refused:** raw leaderboard SOTA at this size (open 32B-class ≈ closed frontier on SWE-bench;
parameters are not our axis).

**Made:** on the operating point **⟨local ≤8GB box, verified answers, deterministic serving,
bounded cost⟩**, the best measured point on the cost–reliability frontier: more *verified* pass@1
than any single ≤8GB model call at ≤K× its cost, with precision-of-claimed-solve ≈ 1.0 (when it
says "solved," tests pass). Registered against [BENCHMARKS.md](../BENCHMARKS.md); the missing
headline run is named in §8.

## 2. Hard constraints (operator envelope, 2026-07-23 — non-negotiable)

| Constraint | Value | Source |
|---|---|---|
| Product/cheap tier size | **≤3B params, ≤4GB footprint, CPU-viable** | operator, #2877 §1.5 |
| 7B-class | **escalation-tier only** (crashes the reference box) | operator, #2877 §1.5 |
| Smallest tier with a usable truth signal | **1.5B** (probe AUROC 0.980 factual / 0.774 assoc, MEASURED; 0.5B fails at 0.703) | #2877 §1.5 |
| Connectivity | offline-first; cloud = optional, rare escalation | mission |
| Honesty | abstains ("can't verify") rather than bluffs; internal signals are alarms, never selection | certificate §8.4.1 Freshness Law (MEASURED) |
| Capability path to "7B-class on a CPU" | **ternary W1.58A8 (ADR-0026)** — ~2GB, CPU-native kernels; probe survival #2873 is critical-path | #2877 §1.5 |

## 3. Architecture — one small looped core, verified outside

```
user task (verifiable: code/math/structured)
   ↓
[CHEAP TIER — pure looped recursive core, ≤3B, quantized→ternary]
   N samples, adaptive loop depth (Q-exit), JSRR ρ<1 accept-gate per §5
   ↓  real exec verifier (Fix-Rate) picks the first verified candidate
[verified? → done at cost ≈ N·c₀]
   ↓  stall (verifier-confirmed, not self-assessed)
[ESCALATION TIER — 7B-class local (capable boxes) or cloud frontier]
   inherits accumulated progress (ADR-0030 spiral memory); rescue logged as VTD fuel
   ↓  still unverified → HONEST HALT ("cannot verify"), never a fabricated pass
```

- **The mechanism is verifier amplification, not model size** (#2877 §2.1, core math IMPORTED
  from pass@k, Chen et al. 2021): `P(verified solve) = τ·(1−(1−p)^N) + (1−τ)·FA(N)`. At the
  ≤3B tier's smaller p, N cheap CPU samples × a real exec verifier is *the* product, not an
  optimization. MEASURED anchors: coding-golden exec pass@1 0.96 (#2173); 7B Q4 HumanEval-164
  0.829 single-shot (now re-scoped to *escalation-tier reference*); cascade 8.3× cheaper at e≈0
  with a strong cheap tier, rescue 88.4% > 84.8% with a weak one (#2798/#2800); fully-local
  0.5B→7B cascade 18/18 MBPP-basic at e=6% (ADR-0030 Phase 0).
- **Cascade policy is FIXED (propose → verify → escalate), not learned.** The learned
  value-of-information router is a **late-stage, falsifier-gated bet** (Grok red-team rank #2;
  both reviews concur): it is built only after the fixed policy is measured, and dies unless it
  beats the fixed policy on verified-skill/sample/watt.
- **Held-out gate (NEW, forced by measurement).** `experiments/spiral_arc_smoketest.js`
  (2026-07-23, real harness + real python exec) reproduced the transduction trap: a memorizing
  program passes **all** visible tests (Fix-Rate 1.0 → "solved") yet fails held-out. Therefore
  visible-test pass is *necessary, not sufficient*: whenever tests can be split, verification
  holds out a subset; `τ` (test adequacy) is carried as a real term, not a footnote (hidden-test
  false-accepts 5–15% in literature; unmeasured in-repo — NOT-VALIDATED).

### 3.1 The core: pure looped recursion now — MoE deferred behind certification, NOT rejected

The v1 cheap tier is a **weight-tied looped transformer with adaptive exit** (Ouro-style; the
paper's third scaling axis — loop depth, not width), because that is the only architecture our
own stability machinery covers **today**: certificate **§1.2.2** states a routed MoE-recurrent
loop is a *switched system* that Part I does not certify (per-route contraction + dwell-time
conditions are needed), and a repo-wide grep (2026-07-23, recorded in
`data/oracle/active-loop-runs.jsonl`) confirms **no switched-system / dwell-time tooling exists
yet**.

**MoE is a live future direction, not a rejection (operator, 2026-07-23).** A future fused
design (anticipated, not yet specified) is expected to bring expert width into the looped core.
The certificate itself names the on-ramp; this design pre-commits to it as the **MoE admission
gate** — the future design enters v-next when these bricks exist:

1. **Switched-system certification tooling** — per-route contraction + average-dwell-time gate
   (multiple Lyapunov functions; the certificate's own cites: arXiv:2405.03560, 2303.17858,
   2008.06546) built and validated the way JSRR was: synthetic known-ρ cases first, then the
   real loop.
2. **Route-switch dynamics measured as a stability quantity** — frozen-route contraction + the
   dwell-time statistics the model actually induces (certificate §1.2.2 consequence 1).
3. **Expert-choice routing preferred** (arXiv:2202.09368 — experts pick tokens; fixed capacity,
   balance by design) as the lower-discontinuity comparator to token-choice top-k.
4. **Candidate architectures held warm**, not discarded: tied/universal experts shared *across*
   recursion steps (MoUE; Tied-Expert-MoE arXiv:2606.16825; MoR arXiv:2507.10524) — width folded
   into the loop rather than bolted beside it, which also minimizes the switched-system surface
   the gate must certify.

Until the gate exists, quoting §1 stability numbers for a routed loop is forbidden (certificate
§1.2.2 consequence 3) — that is the *only* thing being enforced here.

### 3.2 Anytime budget mode (operator scope enhancement, 2026-07-23)

The cascade's cost posture is a **per-task budget dial, not a global minimization objective**.
The spiral is an *anytime algorithm*: it can keep proposing → verifying → refining on one
problem for as long as the budget allows, and its answer only improves (the ratchet commits only
verified advances). Four levers open when the dial opens, ranked by expected impact:

1. **Raise N under verifier amplification** — more cheap samples before escalating (pass@k
   compounding; cost ~linear in N).
2. **Structured search over candidate programs, not raw sampling** — beam/evolutionary/inductive
   refinement; the known high-value path on ARC-style work. "More spiral helps; smarter spiral
   helps more."
3. **Escalate earlier on hard signals** — probe/uncertainty streaks + failed-verify runs route
   budget away from tasks the small core cannot solve (uncertainty-aware budget allocation is an
   active 2026 lane: arXiv:2604.14853, 2605.26849, 2606.04402 — IMPORTED, not yet run in-repo).
4. **Teacher-as-repair, not replacement** — escalation sends the *best local candidate + the
   failing tests + partial progress*, never a blank prompt. Caution carried honestly: self-repair
   feedback in frozen *small* models is partly placebo (arXiv:2606.31511), which is why repair
   here means real execution feedback + a **stronger** repairer — a configuration we've already
   measured working (rescue 88.4% > 84.8%) — never tiny-model self-repair (measured harmful,
   6/6→2/6).

Scope honesty: this raises score *within the efficiency band*; it does not chase the
$10–$200/task frontier cluster. Diminishing returns on raw N are real — the budget buys
structured search and repair, not indefinite blind sampling.

**Base-model choice is a measured decision, not an assumption:** best of
{Qwen2.5-Coder-1.5B/3B-class, Ouro-1.4B native loop} by verified-pass@cost + probe signal on the
reference box, with retrofit recurrence (arXiv:2511.07384) available to add looping to a
non-looped winner. LoopFormer-style variable-unroll training with short/long-trajectory
consistency (arXiv:2602.11451) is the candidate recipe for making one checkpoint serve both
shallow-cheap and deep-hard. (Both IMPORTED; neither run in-repo — NOT-VALIDATED.)

## 4. Honesty stack (what "feels like Claude" without the cloud)

| Capability | Mechanism | Status |
|---|---|---|
| Says "solved" only when true | exec verifier decides; precision-of-claimed-solve is a first-class metric | MEASURED (0.96 gate; honest-unsolved observed live on `rle`) |
| Says "can't verify" | M5 answerability halt; no ratchet without a test | shipped (ADR-0030) |
| Knows when it's likely wrong | 1.5B probe (0.980/0.774 AUROC) as *alarm* | MEASURED; alarms-only per Freshness Law |
| Doesn't degrade into itself | anti-collapse stack (§5) + external grounding as the only escape | PROVEN in-regime + MEASURED |
| Remembers your work | CSF memory + escalation corpus (owned verified traces) | shipped; retrieval into *tiny* models measured HARMFUL (6/6→2/6) — capability rides in weights, not context |

## 5. The certificate as an enforced contract (the Grok-flagged gap, closed by rule)

**Rule: every Σ₀ serving or training path MUST run the certificate's runtime gates, or carry an
explicit written justification for skipping.** Today's reality, grounded by grep 2026-07-23:

| Gate | What it does | Status today | Required change |
|---|---|---|---|
| **JSRR `ρ(A) < 1`** (§1.2.3, ADOPTED from STARS 2605.26733) | rejects latent trajectories whose loop dynamics are unstable | machine-checked (12 tests) but **only on the `OURO_NATIVE=1` path; default cached serving bypasses it** | wire the verdict into the default serve path & the spiral cheap tier; log ρ per generation |
| **Σ₀⁻¹ re-excitation** (§3, Theorem C3 PROVEN for all A; 900/900 prevention MEASURED) | prevents permanent freeze | **dormant**: `observe_only=True, max_interventions=0` ([engine.py:229](../../src/cio_sde/engine.py)) | arm it (bounded budget + receipts) for the product tier; C3 is conditional on permission to act |
| **DecodeCanary + depth coupling** | degeneration alarm → deepen loop | shipped, observe-only default (`OURO_ADAPT=0`) | arm for product tier |
| **Σ_θ acceptance gate** (Part II) | gates weight-update promotion on fresh held-out evidence | logic tested; **has never controlled a real training run** | mandatory for every VTD/ternary run (§6); first real run = the gate's first real test |
| **Scheduled grounding** (§3.1, alarm premium 2.25× MEASURED) | fresh external truth on a cadence, not only on alarm | experiment-only | adopt the cadence in the serve loop |
| **Held-out verification** (§3 above) | blocks visible-test memorization | required by smoke test | split tests wherever possible; report held-out pass separately |

Honest caveats carried verbatim: Part-I theorems are in-regime (local linear Jacobian), so
**grounding remains the actual safety mechanism**; JSRR is validated as the right stability
*object*, not a quality win (CART's null result); the empirical-Jacobian proxy, not the true JVP,
feeds the gate today (#2029 deferred to a GPU run).

## 6. Training path (owned weights, staged, gated)

Sequential, never joint (Grok rank #3: joint ternary multi-component training is the brittle
bet): **(a)** pick the base by measurement (§3.1) → **(b)** VTD on the owned escalation corpus +
exec-verified open sets (TACO Apache-2.0 primary; KodCode NC-tagged) — dose-response already
MEASURED: −6 at 63 traces, ±0 at 204 gentle; crossover needs order-of-magnitude more traces →
**(c)** RLVR with Fix-Rate reward (ADR-0025, double-gated) → **(d)** ternary BitDistill
(ADR-0026) with **#2873 probe-survival as the critical-path acceptance test**. Every promotion
passes **Σ_θ** on fresh held-out — which also finally gives Part II its first real-run evidence.
GPU spend is real money and sits with the mookman handoff (#2850); nothing here presumes it.

**Explicitly deferred for v1** (with the reason on record): MoE core (**deferred behind the
§3.1 admission gate — a future fused design is anticipated; certification bricks unlock it, and
building them is a valid parallel research lane**) · learned VoI router (falsifier-gated, late) · verifier
*internalization* (Grok rank #1 most-dangerous bet — the external verifier stays the ground truth
and held-out anchor; an internal PRM head may only ever *pre-rank* candidates) · hypervisor /
hot-swap contracts and live session migration (systems elegance, zero capability; revisit only
when shipping multiple backbones) · from-scratch pretraining (7.7T-token territory).

## 7. Product layer (latency/cost levers + the IP reality)

- **Speculative decoding** (draft-model) is the biggest cheap latency win for CPU serving — and
  an **actively patented area**: WO2024205726A1, US12229192B2 (granted 2025), US20250245430A1.
  Use upstream implementations (llama.cpp/EAGLE-family); do not claim novelty; FTO check before
  any commercial packaging.
- **Edge quantization**: GB2641319A (joint weight-equalization + activation-range for
  edge-destined LLMs) is the closest patent to our lane; Q4_K_M measured *free* on-box (0.829 =
  fp16 baseline, quant-cliff run) — MEASURED.
- Aggressive caching/prompt reuse; deterministic serving for reproducible receipts.

## 8. Falsifiers & registered benchmarks (what would prove — or kill — this design)

1. **The missing headline number (queued first):** full **HumanEval-164 verified-cascade** run at
   the ≤3B product tier (N samples + exec verify + escalation), cost-instrumented → one point on
   the §1 frontier vs. the 0.829 single-shot 7B reference. (Named missing in #2877 §4.)
2. **Verifier-amplification check:** does measured verified-pass at N samples track
   `1−(1−p)^N` within the FA(N) band? (First in-repo measurement of τ.)
3. **ARC-AGI-2 budgeted track** (ADR-0031): land on the cost-efficiency Pareto frontier
   (NVARC 24% @ ~$0.20/task band) via inductive program synthesis with the held-out gate.
4. **Stability under depth:** ρ-trajectory + peak-then-collapse profile of the chosen core on
   real tasks (the #2029 JVP run) — the JSRR gate's first live-workload validation.
5. **Router bet (late):** learned router must beat the fixed policy on verified-skill/sample/watt
   on the reference box, or it is dropped without sunk cost.
6. **Ternary survival:** #2873 — probe AUROC and verified-pass must survive W1.58A8, else the
   capability path falls back to 4-bit and the §2 envelope is re-negotiated.
7. **The two-budget experiment (§3.2's own falsifier):** same ARC-AGI-2 split, two runs —
   low budget (minimal-escalation cascade) vs high budget (anytime spiral: higher N, structured
   search, early escalation, repair prompts). Report score, $/task, score-per-dollar, and the
   local-vs-escalated solve split. This measures exactly what the budget dial buys.

## 9. Build order (each step measured before the next)

**P0** wire the gates (JSRR on default path; arm Σ₀⁻¹ + canary, bounded) — *no new weights* →
**P1** base-model bake-off at ≤3B on the reference box (§3.1) → **P2** run falsifiers 1–2
(the headline cascade number) → **P3** VTD→RLVR→ternary behind Σ_θ (§6) → **P4** falsifier 3–4 →
**P5** router bet, only if P0–P4 hold.

**R (parallel, non-blocking): the MoE admission gate** — build the §3.1 switched-system
certification bricks (dwell-time gate first, synthetic-validated like JSRR). This lane never
blocks P0–P5; when it lands, the operator's future fused MoE design has a certified doorway
instead of an exception.

## 10. References (verified this session)

#2877 / `docs/research/2026-07-23-small-model-sota-theory.md` · Collapse Certificate (incl.
§1.2.2, §1.2.3, §3, §8) · STARS arXiv:2605.26733 · CART arXiv:2606.01495 · Ouro arXiv:2510.25741 ·
Retrofitted Recurrence arXiv:2511.07384 · LoopFormer arXiv:2602.11451 · MoR arXiv:2507.10524
(rejected-for-v1 context) · Snell arXiv:2408.03314 · BitDistill arXiv:2510.13998 · TernaryLM
arXiv:2602.07374 · pass@k Chen et al. arXiv:2107.03374 · FrugalGPT arXiv:2305.05176 · patents
WO2024205726A1, US12229192B2, US20250245430A1, GB2641319A · Grok red-team transcript
(2026-07-23, operator-relayed) · grounded pulls in `data/oracle/active-loop-runs.jsonl`.
