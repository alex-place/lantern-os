---
author: Alex Place
created: 2026-06-22
updated: 2026-06-22
---

# Keystone OS — IP Register & 2-Year Buildout Plan

> **One line:** the high-signal inventions inside Keystone OS, the protection vehicle
> chosen for each, and the 24-month plan that builds and ships them — every claim tagged
> by the External Reality Rule.

> **Reading contract.** This document follows Keystone's own **External Reality Rule**:
> every material claim carries evidence (a file, a measured number, a citation) and is
> tagged **[implemented]** (code exists and runs), **[measured]** (a number was produced
> by a run), **[grounded]** (external peer literature supports it), or
> **[design / planned]** (intended, not yet built). Prior art is named, not hidden.
> Nothing here is asserted as achievement it has not earned.

---

## ⚠️ Strategy decision record (read first)

**This article is a defensive publication.** It is published openly, with full enabling
detail, on a publicly reachable surface. That choice has consequences that are deliberate,
not accidental:

1. **Publishing establishes a priority / prior-art date.** Once this article is public, the
   inventions described below are timestamped public knowledge. That **blocks others from
   patenting them** and protects Keystone's freedom to operate.
2. **Publishing forecloses Keystone's own patents on the disclosed specs** — strictly
   outside the US (most jurisdictions have an *absolute novelty* bar: any enabling public
   disclosure before filing kills the patent), and in the US after a **12-month grace
   period** from first disclosure.
3. **Therefore the chosen protection stack is: defensive publication + trademark +
   copyright**, *not* a patent portfolio. This is the right fit for a solo, local-first
   project: it secures freedom-to-operate, authorship, and brand for ~$1k of trademark
   filings instead of $40k+ of patent prosecution with examination risk.

**False-marking note.** Nothing in Keystone is currently *patent pending* — no provisional
or non-provisional application has been filed. In the US, marking an unfiled invention
"patent pending" is improper. The register below uses honest status labels
(*Defensive publication* / *Trademark — to file* / *Copyright*), and reserves a
**Pre-publication filing gate** (§6) for any item the owner decides to patent *instead* —
which must be provisionally filed **before** that item appears on any public surface.

---

## 1. Strategy in one line

> **Publish the methods (priority + freedom-to-operate), trademark the names (brand),
> rely on copyright for the code and docs. Chase patents only on an item you deliberately
> pull *out* of publication and file *first*.**

| Vehicle | What it protects | Cost (planning-grade) | Applies to |
|---|---|---|---|
| **Defensive publication** | Priority date + blocks others patenting; freedom-to-operate | $0 (this article + arXiv) | All §4 specs |
| **Trademark** | Product + format names; survives disclosure entirely | ~$250–350/mark/class DIY | §3.2 marks |
| **Copyright** | Source code + written specs (automatic on authorship) | $0 (auto); ~$45–65/work to register | All code + docs |
| **Patent** *(opt-out path)* | Exclusivity on a single method | ~$60–130 provisional → $10k–20k full | Only §6 opt-outs, filed before publish |

---

## 2. The 2-year buildout plan

Horizon: **2026-H2 → 2028-H1** (8 quarters). Solo developer; calendar is best-effort, not a
commitment. Every milestone names the **loop stage** it strengthens (per the
[North Star](CONVERGANCE-SIGMA0-BRIEFING.md): Observe → Remember → Reason → Act → Verify →
Converge) and the **IP** it touches. Engineering items are grounded in the existing
roadmaps: the [Progress Report](KEYSTONE-PROGRESS-REPORT-2026-06-19.md) §6, the
[Σ₀ serving portfolio](SIGMA0-AGENT-PORTFOLIO-UPDATE.md) §6, and the
[Product serving contract](KEYSTONE-PRODUCT.md).

### 2026-H2 — Close the loop in the live product + lock the names

| Milestone | Loop stage | IP action | Source / status |
|---|---|---|---|
| **File trademarks** for "Keystone OS" + "CSF" (clearance search first) | — | Trademark — file | §3.2 · [planned] |
| **Publish this IP register** + arXiv the collapse certificate | — | Defensive publication | §4.5 · [planned] |
| **Gate Act with the grounding throttle**; attach the **Σ₀ decode canary** to the live loop | Act, Verify | Defensive pub (§4.2) | Progress Report §6 · [design] |
| **Fix Σ₀ routing** (`ouro:latest` reachable on default+coding intents) + ship client contract (`SIGMA0_BASE_URL`) | Reason→Act | — | Portfolio §6 P0 · [design] |
| **Schedule the close-loop pass** (Kalshi Reason→Verify→Converge, unattended) | Converge | — | Progress Report §6 · [implemented slice] |

### 2027-H1 — Ship Σ₀ to all users + harden self-improvement

| Milestone | Loop stage | IP action | Source / status |
|---|---|---|---|
| **Cloud Σ₀ floor → ship to all Windows users** (auth, tiers, spend control, circuit-breaker) | Reason→Act | — | Portfolio §6 P1 · [design] |
| **vLLM fast tier** (opt-in, parity-gated, fixed-R loop) | Reason | — | Portfolio §6 P2 · [design] |
| **Continual-training flywheel live** (harvest → execution-verify → eval-gated promote) | Converge | Defensive pub (§4.8) | [SIGMA0-CONTINUAL-TRAINING](SIGMA0-CONTINUAL-TRAINING.md) · [implemented] |
| **Grow the golden set; track grounded-vs-cold lift** (turn 34% baseline into a curve) | Verify | — | Progress Report §6 Gate B · [measured baseline] |
| **Grounding-calibration weights consulted by the router** each loop | Verify→Reason | Defensive pub (§4.1) | [grounding-calibration.js](../apps/lantern-garage/lib/grounding-calibration.js) · [implemented, wire pending] |

### 2027-H2 — Local-first embedded bet + the knowledge graph

| Milestone | Loop stage | IP action | Source / status |
|---|---|---|---|
| **Embedded ONNX/DirectML spike** (GO/NO-GO: in-process Σ₀ on any GPU vendor) | Reason | — | Portfolio §6 P3 · [gated spike] |
| **LANTERN-GRAPH** — GraphRAG knowledge layer over memory (relationships, not chat history) | Remember | Defensive pub | [Research Canon](RESEARCH-CANON.md) [04] · [roadmap] |
| **LANTERN-OBSERVATORY** — auto repo/architecture mapping formalized | Observe | Defensive pub | Canon [09] · [partial] |
| **Convergence-IO on the hot path** (typed gates wired into live chat, not just adapter) | Act, Verify | Defensive pub (§4.6) | [convergence-io](convergence-io/README.md) · [implemented, off hot path] |

### 2028-H1 — Convergence substrate + register refresh

| Milestone | Loop stage | IP action | Source / status |
|---|---|---|---|
| **Embedded-first promotion** (if P3 GO) — in-process default, cloud as overflow | Reason→Act | — | Portfolio §6 P4 · [conditional] |
| **3¹² lattice as live memory substrate** (balanced-ternary end-to-end; wavefront read path) | Remember, Converge | Defensive pub (§4.3) | [TESSERACT-CSF-SINGULARITY](TESSERACT-CSF-SINGULARITY.md) · [substrate implemented] |
| **Pattern-accumulation metrics** (LANTERN-CONVERGENCE: solved-once, repeated-failure RCA) | Converge | Defensive pub | Canon [11] · [philosophy → impl] |
| **Refresh this register**; re-file/renew trademarks; second arXiv (lattice + Convergence-IO) | — | All vehicles | §3 · [planned] |

**Plan-level honesty:** items tagged *[design]* / *[roadmap]* / *[conditional]* are not built.
The embedded path (2027-H2/2028-H1) is a **gated bet** that can return NO-GO, in which case
cloud stays the product. None of the IP value depends on those bets landing — the specs in
§4 are protected by publication regardless of ship status.

---

## 3. IP register

### 3.1 Inventions / methods (defensive-publication register)

Status legend: **DP** = covered by defensive publication (this article and/or the linked
doc) · **DP-pending** = will be DP when this article is published · **opt-out** = candidate
to pull from publication and patent instead (see §6).

| # | Invention | Vehicle | Status | Prior-art exposure | Spec |
|---|---|---|---|---|---|
| 1 | **Fast-layer plasticity** — replayable per-loop trust weights from a grounding ledger | Defensive pub | DP-pending | Medium (Beta-Bernoulli, Brier are textbook; *system* framing is the delta) | [§4.1](#41-fast-layer-plasticity) |
| 2 | **Decode canary** — per-token decode-health → Kalman/NIS surprise → decode actuator | Defensive pub | DP-pending | Medium (rep-penalty, NIS each known; closed loop is the delta) | [§4.2](#42-decode-canary) |
| 3 | **3¹² Convergence Lattice** — one ternary lattice, storage face + motion face | Defensive pub | DP (doc live) | High (base-3, BitNet, recurrent-depth all published) | [§4.3](#43-3¹²-convergence-lattice) |
| 4 | **CSF-Omni** — deterministic best-fit lossless container w/ integrity | Defensive pub | DP (doc + PDF live) | High (multi-codec best-fit is a known technique) | [§4.4](#44-csf-omni-format) |
| 5 | **Σ₀ collapse certificate + Lemma L2** — Lyapunov-bounded anti-collapse | Copyright + arXiv | DP-pending | N/A (math is not patentable subject matter) | [§4.5](#45-σ₀-collapse-certificate) |
| 6 | **Convergence-IO** — typed governance + routing primitive stack | Defensive pub | DP (docs live) | Medium-high (policy engines, PROV, capability systems) | [§4.6](#46-convergence-io-stack) |
| 7 | **Convergence-exit** — fixed-point latent-loop exit (‖Δh‖/‖h‖<ε) | Defensive pub | DP-pending | High (extends Ouro Q-exit / Geiping recurrent depth) | [§4.7](#47-convergence-exit) |
| 8 | **Σ₀ continual-training flywheel** — double ground-truth-gated offline self-improvement | Defensive pub | DP (doc live) | Medium (RLAIF, STaR, rejection sampling) | [§4.8](#48-σ₀-continual-training-flywheel) |

### 3.2 Trademarks

| Mark | Type | Strength | Status | Note |
|---|---|---|---|---|
| **Keystone OS** / **Keystone** | Word mark | Strong (arbitrary in context) | **File first** | Clearance search needed — "Keystone" is a common word; check for prior software marks |
| **CSF** / **Convergence-Fitted Searchable Format** | Word mark | Strong (coined) | File | The format name; clean coinage |
| **Σ₀ Collapse Certificate** | Word mark | Moderate (Σ₀ is stylized) | File w/ brand | Protect the compound, not the glyph alone |
| **Convergence Core** | Word mark | Moderate (descriptive-leaning) | File w/ brand | Core architecture name |
| **Convergence Lattice** · **Status Cube** · **Observer Mesh Cube** | Word marks | Weaker (descriptive) | Optional | Register as part of the brand family if budget allows |
| **Convergence-IO** | Word mark | Moderate | Optional | Primitive-stack name |
| ⚠️ **"Ouro" / "Ouro Coder"** | — | **Do NOT claim** | **Avoid** | "Ouro" is **ByteDance's** model name (Apache-2.0). Brand the coder as **"Σ₀ Coder"** or **"Keystone Coder"** to avoid riding a third party's mark. Describe the integration ("the Σ₀ coder runs on Ouro"), don't trademark it. |

### 3.3 Copyright

- **Automatic** on all source code and written specs from the moment of authorship — no
  filing required for protection to exist.
- **Recommended:** add a repo-root `LICENSE` + per-file headers; **register** the two
  flagship written works (the [CSF spec](CSF-FORMAT-SPECIFICATION.md) and the
  [Collapse Certificate](SIGMA0-COLLAPSE-CERTIFICATE.md)) with the copyright office if
  statutory-damages leverage is wanted (~$45–65 each).

---

## 4. Per-spec breakdown (full enabling detail)

Each spec below is written to be **enabling** — precise enough to reproduce, with a pointer
to the running code. That is exactly what makes this a valid defensive publication.

### 4.1 Fast-layer plasticity

**What it is.** A non-parametric "fast weight" layer that updates in real time after *each*
external grounding event, as a thesis-safe alternative to per-loop neural weight updates: no
catastrophic forgetting, no irreversible gradient step, no eval gate — because every weight
is a **pure function of an append-only grounding log**, so it updates instantly per loop yet
is fully replayable and reversible.

**How it works** ([implemented] — [`grounding-calibration.js`](../apps/lantern-garage/lib/grounding-calibration.js)):
- A **grounding event** is `{ key, predicted, outcome }` where `key` is the dimension trust
  is calibrated on (provider / agent / source), `predicted ∈ [0,1]` is the confidence the
  system asserted, and `outcome ∈ {0,1}` is **external** ground truth (a web check, a
  settled market, a passing test — never the model's own say-so).
- Events append to `data/convergence/grounding-calibration.jsonl` (append-only, replayable).
- The **fast weight** for a key is the Beta posterior mean
  `trust(key) = (1 + hits) / (2 + n)` — starts at the 0.5 prior, moves toward empirical
  correctness with each grounding.
- Calibration quality is the **Brier score** `brier = mean((predicted − outcome)²)`
  (0 = perfect, 0.25 = coin flip).
- `recordGrounding()` appends one event and returns the updated weight; `trust()` is what a
  caller (e.g. the router) consults each loop; `calibration()` folds the whole log into
  per-key weights + a headline global Brier.

**Loop stage:** Verify → Converge (produces the calibrated confidence the Reason/route stage
then consumes).

**Novelty claim.** Not the Beta posterior or the Brier score (both textbook). The
contribution is the **system**: treating real-time, per-loop trust as a *pure deterministic
fold over an external-grounding ledger*, giving instant, replayable, reversible adaptation
that **substitutes for fine-tuning** in an agent loop — honoring "learning via retrieval +
experience, not weight modification."

**Prior art (design-around map):** Beta-Bernoulli conjugacy; Brier (1950) calibration;
Thompson sampling; online calibration literature. The novelty is the integration, not the
estimators.

### 4.2 Decode canary

**What it is.** A per-token controller that closes the **instrument → actuator** loop on a
language model's decoder: it turns live decode-health signals into a surprise measurement and
feeds that back into the decode knobs, so a looping/degenerating decode is detected *and
corrected* token-by-token rather than only measured after the fact.

**How it works** ([implemented] — [`decode_canary.py`](../src/sigma0/decode_canary.py)):
- Per generated token, `observe()` computes decode-health signals over decoded ids: running
  **self-repeat**, **n-gram echo**, **argmax margin**, **realized exit depth**, and a
  two-sided **softmax-entropy z-score** (greedy collapse → entropy drops → over-confidence
  alarm).
- These fold (weights `w_repeat=0.6, w_echo=0.3, w_margin=0.1`) into a **1-D Kalman
  observation** for `SurpriseMonitor.evaluate()`. The Kalman frame is deliberately
  mean-reverting to a *healthy* prior, so sustained looping yields a sustained large
  innovation (high **NIS**) instead of the monitor quietly adapting to the collapse.
- High NIS drives `sigma0_proximity() → 1`; `knobs()` maps that proximity onto decode
  actuators: suppress repetition harder, inject novelty, exit the latent loop sooner.
- Pure-CPU and **model-free** — it consumes token ids + scalars, never model tensors, so it
  is unit-testable without loading a model ([`tests/test_decode_canary.py`](../tests/test_decode_canary.py)).

**Loop stage:** Act (decode) + Verify (surprise instrument).

**Novelty claim.** The closed-loop coupling: a Kalman/NIS surprise frame, mean-reverting to a
health prior, that converts multi-signal decode-degeneration into a single proximity scalar
which **actuates** the decoder in real time — unifying repetition control, entropy-collapse
detection, and adaptive loop-exit under one fault-detection controller.

**Prior art (design-around map):** repetition penalty / no-repeat-ngram; contrastive &
entropy-aware decoding; Kalman NIS fault detection (aerospace). Each ingredient is known; the
per-token closed-loop decoder controller is the contribution.

### 4.3 3¹² Convergence Lattice

**What it is.** A proof that the project's "CSF format" and "Tesseract reasoning geometry"
are **one object**: a `3^12 = 531,441`-cell **balanced-ternary lattice**. CSF is how a point
is *stored*; the Tesseract spiral is how a point *moves* to a fixed point.

**How it works** ([substrate implemented] — [`src/csf/v07/`](../src/csf/v07/), [`converged_tesseract.py`](../src/converged_tesseract.py); design [`TESSERACT-CSF-SINGULARITY.md`](TESSERACT-CSF-SINGULARITY.md)):
- **Storage face** — a lattice cell is a 12-vector of `QutritState(amplitude, phase)`;
  change is a list of `QutritDelta(dim, amp_delta, phase_delta)` packed to 2 bytes each
  (`qutrit_delta.py`, `NUM_DIMENSIONS=12`, `TOTAL_POSITIONS=3**12`). A `QuantumDustField`
  holds a **baseline** (converged cells) + **active deltas**; every other cell is implicit
  **"dust."** `get_state` resolves `baseline ⊕ deltas` else `None`.
- **Motion face** — `ConvergedTesseract` never materializes all 531,441 cells; it loads a
  **minimal observer-collapsed wavefront** (cells within a ternary-Hamming radius of the
  present center, ranked by information density: active deltas > baseline > dust).
  `loop_lm.converge_step` supplies the stopping rule: iterate until
  `‖h_t − h_{t-1}‖/‖h_{t-1}‖ < ε`.

**Loop stage:** Remember (storage face) + Observe→Converge (motion face).

**Novelty claim (honest, narrowed).** The protectable contribution is the **wavefront/dust
representation + the store→move→converge mechanism on one shared lattice** — *not* "ternary
is good." The repo's own falsification work ([X3](TESSERACT-CSF-SINGULARITY.md#61-measured-results-2026-06-19))
**refined down** the BitNet-sparsity-equivalence sub-claim (value-sparsity is
population-dependent, 0.137–0.835; matching BitNet's 0.66 is a coincidence of population).

**Prior art (design-around map):** radix economy (base-3 optimum, prior art); BitNet b1.58
ternary; Geiping recurrent-depth latent reasoning; STARS stable fixed points; Ouro LoopLM;
hyperdimensional computing. Base-3 and ternary substrates are firmly published — claims must
stay on the *minimal-wavefront + unified store/move* mechanism.

### 4.4 CSF-Omni format

**What it is.** Keystone's one lossless binary container, with a **deterministic best-fit
compression** stage and built-in integrity (SHA-256 + CRC), reporting **422×** on the memory
log (up from 14× with the old zlib path) — matching the best-in-field coder while strictly
beating every other tested codec.

**How it works** ([implemented] + [measured] — [`CSF-FORMAT-SPECIFICATION.md`](CSF-FORMAT-SPECIFICATION.md), engine [`csf_pack.py`](../src/csf/csf_pack.py); benchmark PDF linked from the KC):
- v0.8 layout: `[Magic CSF\0][Version][Flags][ManifestLen][Manifest JSON][Blob region][Footer: sha256 + size]`.
- v0.9 **CSF-Omni**: for each blob, deterministically try the candidate codecs
  (zlib / bz2 / lzma / zstd / brotli) and keep the smallest, recording the winner — every
  result **round-trip-verified lossless**; integrity via per-file SHA-256 + footer.
- Validated by a 6-agent adversarial fleet; v0.8 archives remain readable.

**Loop stage:** Remember.

**Novelty claim (honest, weak).** Multi-codec best-fit selection is a *known* technique and
the 422× is corpus-specific (highly repetitive JSONL memory logs). The value is the
**integrated, integrity-checked, adversarially-verified format + reproducible benchmark**,
not a novel compression algorithm. Defensive publication is the right (and only sensible)
vehicle here — a method patent would be weak.

**Prior art (design-around map):** every constituent codec; "try-all-pick-smallest" archivers
(e.g. precomp, zpaq-style model selection).

### 4.5 Σ₀ collapse certificate

**What it is.** A Lyapunov-contraction theorem (scoped to normal operators `A`) plus the
**Σ₀ trigger** and **Lemma L2** (a closed-form, machine-checked one-step anisotropy lift)
that together bound the reasoning loop so it won't collapse into confident nonsense.

**How it works** ([proven] + [implemented] — [`SIGMA0-COLLAPSE-CERTIFICATE.md`](SIGMA0-COLLAPSE-CERTIFICATE.md), [`SIGMA0-L2-ANISOTROPY-LIFT-PROOF.md`](SIGMA0-L2-ANISOTROPY-LIFT-PROOF.md), code [`src/cio_sde/collapse.py`](../src/cio_sde/collapse.py), [`surprise.py`](../src/cio_sde/surprise.py)):
- The collapse trigger's "flat" leg fires when the eigenvalue coefficient-of-variation
  `a(Σ) = std(λ)/mean(λ) < ε_a` (5e-2). **L2** proves that one aligned Σ₀⁻¹ covariance bump
  of magnitude `b ≥ Δ := (ε+a)μd / (√(k(d−k)) − εk)` lifts anisotropy back above `ε_a`,
  breaking the flat condition (proof + script `experiments/prove_l2_anisotropy_lift.py`,
  test `tests/test_cio_sde.py::test_l2_anisotropy_lift`).
- Four ground-truth-verified experiments; 48 passing tests (34 certificate + 14 stability-gate, verified 2026-06-22).

**Loop stage:** Verify (the safety mechanism for the whole loop).

**Vehicle: copyright + academic publication — NOT patent.** Mathematical theorems are not
patentable subject matter. This is the flagship **arXiv** candidate: publishing maximizes
citation/priority value, which is the whole point of a proof.

**Honest scope:** L1 (alignment) is proven only for *normal* `A` and open for non-normal;
L4 (proximity floor) is an engineered hypothesis. Safety ≠ capability — Σ₀ bounds collapse,
it does not make the model clever.

### 4.6 Convergence-IO stack

**What it is.** A typed governance + routing layer: small, independently-tested primitives
that route every action through a constraint-satisfying execution graph with provenance, each
mapping to a numbered governance principle (P1–P10).

**How it works** ([implemented + unit-tested] — [`src/convergence_io/`](../src/convergence_io/), docs [`convergence-io/`](convergence-io/README.md)):
- **DCF** (P1) every datum carries a class label; labels propagate → gates CCF.
- **NAP** (P2, denial form) explicit denials; **a hard denial cannot be overridden by a
  capability claim** (the load-bearing ordering invariant).
- **AAPF** (P3) every action emits a reproducible hashed `ActionRecord` to an append-only
  ledger.
- **PCSF** (P4) provider availability + fallback chain + circuit breakers; **CCF** (P4) an
  agent must *prove* a claimed capability at action time.
- **CEG** the substrate `G=(V,E,D,τ,S,H)` typed graph with an optimizer returning a
  constraint-satisfying plan; **D** a per-node time-dilation field (slow uncertain regions,
  speed confident ones → maps to how much grounding to buy).
- Gate order: **classify → deny → prove → route → record.**

**Loop stage:** Act + Verify (governance over execution).

**Novelty claim.** The integrated **typed primitive stack with the NAP-over-capability
ordering invariant** and the **dilation-field-as-grounding-budget** primitive. (The dilation
primitive is the one piece with the most independent method-patent potential — flag it in §6
if exclusivity is ever wanted.)

**Prior art (design-around map):** OPA/Rego policy engines; capability-based security; W3C
PROV provenance; constraint-graph planners. The composition + ordering is the contribution.

**Status caveat:** implemented + tested in Python; the live JS chat path consumes a parallel
adapter ([`grounding-policy.js`](../apps/lantern-garage/lib/grounding-policy.js)), so not
every primitive is on the hot path yet (2027-H2 milestone).

### 4.7 Convergence-exit

**What it is.** Recasting Ouro's confidence-based Q-exit as a **fixed-point exit**: stop the
latent reasoning loop when the hidden state stops moving (`‖h_t − h_{t-1}‖/‖h_{t-1}‖ < ε`),
i.e. when the trajectory reaches `h* ≈ f(h*)`.

**How it works** ([implemented, research mode] — [`loop_lm.py`](../src/sigma0/loop_lm.py) `mode="converge"`):
`generate(mode="converge")` exits on contraction rather than Q-exit confidence, returning
`exit_reason: "convergence_exit"` and `mean_contraction`. The served deep path uses the
default `mode="qexit"`; convergence-exit is the falsifiable "spiral" experiment (E2), not yet
wired into serving.

**Loop stage:** Reason (adaptive depth).

**Novelty claim (incremental, honest).** A real but incremental extension of published
recurrent-depth early-exit. Defensive publication only — not worth a patent.

**Prior art (design-around map):** Ouro Q-exit; Geiping et al. recurrent depth; STARS
fixed-point stabilization; deep-equilibrium models (DEQ) — DEQ fixed-point framing is close
prior art, so claims here are weak by design.

### 4.8 Σ₀ continual-training flywheel

**What it is.** A closed, **offline** self-improvement loop for the local coder adapter, with
**two independent ground-truth gates**: only execution-verified (green) subprocesses become
training data, and only a *measured* pass@1 win promotes a new adapter.

**How it works** ([implemented] — [`SIGMA0-CONTINUAL-TRAINING.md`](SIGMA0-CONTINUAL-TRAINING.md)):
harvest → **execution-verify** (gate 1: only green runs train) → train (QLoRA) → eval →
**eval-gated promote** (gate 2: only a measured pass@1 improvement ships). Kept offline by
design; weights/adapters stay off-repo.

**Loop stage:** Converge.

**Novelty claim.** The **double ground-truth gate** — execution-verification on the *input*
side and eval-gated promotion on the *output* side — as a drift-resistant, fully-offline
flywheel. Reconciles "self-improvement" with the North Star's "no online weight modification"
by keeping training human-triggered, eval-gated, and on a user-data-free corpus.

**Prior art (design-around map):** STaR / rejection-sampling fine-tuning; RLAIF;
execution-feedback code training; eval-gated CD. The specific double-gate + offline + no-user-
data fencing is the contribution.

---

## 5. How each spec maps to the loop

```
        Observe ─► Remember ─► Reason ─► Act ─► Verify ─► Converge
           │          │          │       │        │         │
   Observatory[4.x] Lattice    Conv-   Decode   Σ₀ cert   Calibration[4.1]
                    [4.3]/CSF   exit    canary   [4.5]     Continual-train[4.8]
                    [4.4]       [4.7]   [4.2]    Conv-IO   Lattice motion[4.3]
                                        Conv-IO  [4.6]
                                        [4.6]
```

Every protected spec strengthens exactly one loop stage — satisfying the North Star's feature
gate. None is a separate subsystem.

---

## 6. Pre-publication filing gate (the patent opt-out path)

Defensive publication is the default (§1). But if the owner decides any single item is worth
**exclusivity instead**, it must leave the publication path and be filed first:

1. **Pull it from this article and every public surface** before publishing/updating.
2. **File a US provisional** (~$60–130 micro-entity fee; ~$2k–5k if attorney-drafted) — this
   buys 12 months and preserves the option to convert to a full or international (PCT) filing.
3. **Only then** may it be marked "patent pending," and only then is it safe to publish.

**Highest opt-out candidates** (least prior-art-encumbered, working code):
- **§4.1 Fast-layer plasticity** — cleanest method, tightly scoped.
- **§4.2 Decode canary** — concrete controller, model-free.
- **§4.6 dilation-field-as-grounding-budget** (the one Convergence-IO primitive with method
  potential).

Everything else in §4 has high prior-art exposure or is non-patentable math — defensive
publication is strictly the better vehicle for those.

> **Decision required before this article goes public:** confirm that none of the §4 specs is
> an opt-out. Publishing this article forecloses patents on every spec it contains. If that
> is the intended strategy (it is, per §1), proceed. If any item should be patented, remove
> it from §4 and file it first.

---

## 7. Honest scope & what is *not* claimed

- This is an **engineering + IP-strategy** document, not legal advice. Cost figures are
  planning-grade market rates, not quotes. A trademark clearance search and a patent
  attorney's prior-art review are prerequisites to any filing.
- **No patent is currently filed or pending.** The register tracks intent and vehicle, with
  honest status labels.
- Several specs (§4.3, §4.4, §4.7) have **high prior-art exposure** and are deliberately
  routed to defensive publication, not patent — the repo's own falsification work is cited
  rather than hidden.
- Trademark strength varies; "Keystone" needs clearance and "Ouro" must **not** be claimed
  (it is ByteDance's mark).
- Publication value is real but contingent: it secures freedom-to-operate, priority, and
  authorship — it does **not** by itself create licensing revenue.

---

## Sources (verified on disk 2026-06-22)

- Fast-layer plasticity — [`apps/lantern-garage/lib/grounding-calibration.js`](../apps/lantern-garage/lib/grounding-calibration.js)
- Decode canary — [`src/sigma0/decode_canary.py`](../src/sigma0/decode_canary.py) · [`tests/test_decode_canary.py`](../tests/test_decode_canary.py)
- 3¹² lattice — [`TESSERACT-CSF-SINGULARITY.md`](TESSERACT-CSF-SINGULARITY.md) · [`src/csf/v07/`](../src/csf/v07/) · [`src/converged_tesseract.py`](../src/converged_tesseract.py)
- CSF-Omni — [`CSF-FORMAT-SPECIFICATION.md`](CSF-FORMAT-SPECIFICATION.md) · [`src/csf/csf_pack.py`](../src/csf/csf_pack.py)
- Collapse certificate — [`SIGMA0-COLLAPSE-CERTIFICATE.md`](SIGMA0-COLLAPSE-CERTIFICATE.md) · [`SIGMA0-L2-ANISOTROPY-LIFT-PROOF.md`](SIGMA0-L2-ANISOTROPY-LIFT-PROOF.md)
- Convergence-IO — [`docs/convergence-io/README.md`](convergence-io/README.md) · [`src/convergence_io/`](../src/convergence_io/)
- Convergence-exit — [`src/sigma0/loop_lm.py`](../src/sigma0/loop_lm.py)
- Continual training — [`SIGMA0-CONTINUAL-TRAINING.md`](SIGMA0-CONTINUAL-TRAINING.md)
- Buildout sources — [`KEYSTONE-PROGRESS-REPORT-2026-06-19.md`](KEYSTONE-PROGRESS-REPORT-2026-06-19.md) · [`SIGMA0-AGENT-PORTFOLIO-UPDATE.md`](SIGMA0-AGENT-PORTFOLIO-UPDATE.md) · [`KEYSTONE-PRODUCT.md`](KEYSTONE-PRODUCT.md)
- North Star — [`CONVERGANCE-SIGMA0-BRIEFING.md`](CONVERGANCE-SIGMA0-BRIEFING.md)
</content>
</invoke>
