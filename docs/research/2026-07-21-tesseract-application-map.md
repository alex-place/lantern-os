# The Tesseract, applied — what survived the kill, and where it works across CSF · Convergence-IO · Chat · Trade · Explore

**Date:** 2026-07-21
**Type:** Review + status update + application map. **No new subsystem; no revival of killed claims.**
**Status:** Living application register for the (closed) tesseract research thread.
**Loop stages:** Remember (CSF retrieval) · Verify (grounding budget, surprise leak) · Observe (adaptive polling) · Reason (explore/exploit policy)

**Grounding contract — External Reality Rule.** Every load-bearing claim is tagged
**[implemented]** (code exists and runs), **[measured]** (a number was produced by a run),
**[grounded]** (external peer literature, verified), **[killed]** (run and refuted — cited,
never re-argued), or **[design — falsifiable]** (proposed here with a kill criterion).

**Reads first:**
[`2026-06-28-csf-tesseract-novelty-and-e1-kill.md`](2026-06-28-csf-tesseract-novelty-and-e1-kill.md) (the close) ·
[`../TESSERACT-CSF-SINGULARITY.md`](../TESSERACT-CSF-SINGULARITY.md) (the lattice) ·
[`2026-06-20-lapse-tesseract.md`](2026-06-20-lapse-tesseract.md) (the field) ·
[`2026-06-29-csf-beating-zstd.md`](2026-06-29-csf-beating-zstd.md) (the codec verdict) ·
[`2026-06-30-pumped-lossy-resonator.md`](2026-06-30-pumped-lossy-resonator.md) (the leak) ·
[`../KEYSTONE-IP-AND-BUILDOUT.md`](../KEYSTONE-IP-AND-BUILDOUT.md) §3.1/§4.4 (the honest grading)

---

## TL;DR

> The tesseract thread was **closed with evidence on 2026-06-28** and stays closed — this doc
> revives nothing. What it does instead: **(1) review** the whole thread in one verdict ledger;
> **(2) update** — since the kill, the thread's surviving primitives have quietly become *live
> product code* on three surfaces (chat's dilation→grounding budget, trade's send-on-delta
> polling, Convergence-IO's `D` field), a fact scattered across five docs and never stated in
> one place; **(3) expand** — map the four surviving primitives onto the five surfaces the
> project actually operates (CSF, Convergence-IO, chat, trade, explore), each application
> carrying its loop stage, its live-today evidence, and a kill criterion.
>
> The through-line: what survived every falsification is not geometry and not compression. It
> is **one scalar field discipline** — *spend bits/compute/attention/grounding where surprise
> is high; spend nothing where prediction is confirmed* — plus one projection (the
> Status-Cube), one data structure (wavefront/dust), and one method (the kill-criteria
> harness). The field now has **three independent live incarnations**; the remaining
> applications are extensions of those, not new machinery.
>
> An addendum (§5) answers the follow-up asks — *qutrit ↔ binary compression* and the
> *higher-dimensional binary compression* landscape — with a web-verified brief and a graded
> brainstorm. A companion slate of **owned-math conjectures** (M1–M6, first tests already run,
> issues #2786–#2791) lives in
> [`2026-07-21-owned-math-conjectures.md`](2026-07-21-owned-math-conjectures.md). Trit-packing is a solved 99% craft whose one real home here is the **ADR-0026
> ternary serving artifact** (llama.cpp TQ1_0, 1.6875 bpw); ternary's honest wins are
> hardware/serving economics (GDDR7 PAM-3, BitNet kernels), never codecs. The 2026
> higher-dimensional literature adds two more: a **RaBitQ 1-bit/dim embedding cache** for the
> memory reranker, and **neutral grading of CSF-Omni on the AITDCC-2026 benchmark**. Three
> build/bench candidates, four honest closures.

---

## 0. What is real vs. what this note contributes

| Claim | Status | Source |
|---|---|---|
| The tesseract/lapse compression thread is closed (E1/E2 run and refuted) | **[killed — cited]** | [kill doc](2026-06-28-csf-tesseract-novelty-and-e1-kill.md) §3–4 |
| The lapse **field** `L(x)=−log₂p` is real and strongly non-uniform on repo data | **[measured]** (E3: std 1.28–3.03 b/B; 62–70% horizon cells on structured data) | [lapse doc](2026-06-20-lapse-tesseract.md) §4 |
| Dilation→grounding budget is **live in chat** | **[implemented]** | [`lib/grounding-policy.js`](../../lib/grounding-policy.js) (JS mirror of [`src/convergence_io/dilation.py`](../../src/convergence_io/dilation.py)) |
| Per-token surprise primitive exists; **valve closed** (no production logprobs flow) | **[implemented, unwired]** | [`lib/token-surprise.js`](../../lib/token-surprise.js); [resonator doc](2026-06-30-pumped-lossy-resonator.md) |
| Send-on-delta market polling (spend polls where variance is high) | **[implemented, flag-gated]** | [`lib/kalshi-adaptive-poll.js`](../../lib/kalshi-adaptive-poll.js) (`KALSHI_ADAPTIVE_POLL=1`) |
| Status-Cube (belief × observer × state) + Convergence-IO primitive stack | **[implemented + unit-tested]** | [`src/convergence_io/`](../../src/convergence_io/), [`../convergence-io/README.md`](../convergence-io/README.md) |
| 3¹² wavefront/dust store — engineering kept, **novelty claim dropped** | **[implemented; graded]** | IP register [§3.1](../KEYSTONE-IP-AND-BUILDOUT.md) ("folded into CSF as engineering") |
| The application map + per-surface kill criteria | **[contribution — this doc]** | §3–4 |

---

## 1. Review — the thread ledger

Seven documents, one verdict column. This is the part you read instead of re-opening the thread.

| Doc | Load-bearing claim | Verdict today |
|---|---|---|
| [2026-06-19 spiral](2026-06-19-convergence-tesseract-spiral.md) | Convergence-exit (`‖Δh‖/‖h‖<ε`) beats Q-exit; the loop spirals to a fixed point | **[killed]** E2 on real Ouro-1.4B: no contraction in 4 steps; exit never fires at ε=0.05. Salvage: the **trained Q-exit gate** — 25–43% recurrent-compute cut at 95–98% fidelity **[measured]** |
| [2026-06-19 singularity](../TESSERACT-CSF-SINGULARITY.md) | CSF ≡ Tesseract: one 3¹² lattice, storage face + motion face | **Stands as consolidation** (vocabulary + code unification). X3 **refined**: dust/BitNet sparsity match = population coincidence. X4: instrument semantics validated. X1/X2 never run. Novelty **dropped** by the IP pass |
| [2026-06-20 lapse](2026-06-20-lapse-tesseract.md) | Compute-depth *is* the code-length warp; Ouro-as-coder beats CSF-Omni | **[killed]** E1: loses on structured data raw, ~6 orders adjusted; E2: `corr(depth, bits)` ~0/negative. **E3 passed** (the field is real). **E4 never run** (MDL-geodesic retrieval — picked up in §3.1) |
| [2026-06-28 kill](2026-06-28-csf-tesseract-novelty-and-e1-kill.md) | Branch close + external validation (25/25 claims adjudicated) | **Closed.** Carry-forward named there: the per-token surprise signal → groundedness canary |
| [2026-06-29 zstd verdict](2026-06-29-csf-beating-zstd.md) | What actually beats zstd-19 on repo data | CSF-Col (#1593) is the one build; RKD/GRC/hybrid deferred or refuted at current scale; **"pure tesseract geometry … adds zero bits"** — the door stays closed |
| [2026-06-30 resonator](2026-06-30-pumped-lossy-resonator.md) | The loop is a pumped lossy resonator; surprise is the leak | Design principle adopted; **the valve is still closed** (no production logprobs reach `modelUncertainty`) |
| [2026-07-18 IP register](../KEYSTONE-IP-AND-BUILDOUT.md) | Honest grading of everything above | Ternary-lattice novelty → **engineering only**; convergence-exit → folded, not standalone; **dilation-field-as-grounding-budget → one of two patent opt-out candidates** (§4.4) — the thread's one idea graded *up*, not down |

Two review observations this pass fixes elsewhere:
1. [`../TESSERACT-CSF-SINGULARITY.md`](../TESSERACT-CSF-SINGULARITY.md) carried no supersession
   banner (the spiral and lapse docs both do) — added 2026-07-21.
2. [`../RESEARCH-CANON.md`](../RESEARCH-CANON.md) still called dust-sparsity "the storage twin"
   of BitNet zero-sparsity — the repo's own X3 refined that to a population coincidence; the
   canon line now says so, and the convergence-dynamics section now records the E2 verdict.

### 1.1 The name is occupied outside and overloaded inside

**Outside (web-verified 2026-07-21):** on arXiv, "Tesseract" already names — a **quantum-error-correction
decoder** from Google Quantum AI ([arXiv:2503.10988](https://arxiv.org/abs/2503.10988), with a 2026
acceleration follow-up [arXiv:2602.02985](https://arxiv.org/pdf/2602.02985) and an open-source repo
[quantumlib/tesseract-decoder](https://github.com/quantumlib/tesseract-decoder)) — a **tensor-parallelism
scheduler** ([arXiv:2105.14500](https://arxiv.org/abs/2105.14500), ICPP 2022) — a **4D multi-resolution
hash encoding** for time-varying volume visualization (F-Hash, [arXiv:2507.03836](https://arxiv.org/abs/2507.03836),
the closest usage to "4D encoding" and still unrelated) — a **4D embodied world model** (TesserAct,
[arXiv:2504.20995](https://arxiv.org/abs/2504.20995), ICCV 2025) — and, dominating all search relevance,
the **Tesseract OCR engine** (e.g. [arXiv:2209.09118](https://arxiv.org/abs/2209.09118)). **No arXiv
thread uses "tesseract" for data compression** — searching `tesseract compression` returns OCR-of-compressed-TIFFs
and tensor-decomposition results. This independently corroborates the kill doc's §2.5 ("higher-dimensional
compression" is an occupied name) and the IP register's choice to trademark **CSF**, not "tesseract."

**Inside (mapped 2026-07-21):** the repo itself uses the word for **seven different objects**:

| # | Referent | What it actually is | Status |
|---|---|---|---|
| 1 | `TesseractEngine` ([`src/convergence_io_engine.py:1616`](../../src/convergence_io_engine.py)) | The **live runtime orchestrator** — a 4-layer × 4-axis grid (SURFACE/INTERFACE/CONVERGENCE/CORE), circuit breakers, CSF+RAG enrichment, streaming; plus the 20-phase `ConvergenceLoop` | **LIVE** (wired via [`convergence-adapter.js`](../../lib/convergence-adapter.js), CI, operator routes) |
| 2 | `ConvergedTesseract` ([`src/converged_tesseract.py`](../../src/converged_tesseract.py)) | The 3¹² observer-collapsed wavefront prototype (this thread's object) | **Test-only orphan** (14 passing unit tests; no runtime caller; its route hook is a stub) |
| 3 | [`src/csf/v07/`](../../src/csf/v07/) lattice | The storage-face primitives (qutrit deltas, dust field, Status-Cube binary container) | **Dormant library** (imported by experiments/tests/#2; product compresses via `csf` v2 zstd) |
| 4 | `TradingTesseract` ([`lib/signal-engine/tesseract.js`](../../lib/signal-engine/tesseract.js)) | 5-dimension asset evaluator (time/market/signal/layer/asset_state) | **LIVE advisory** inside the scan ([`scan.js:241`](../../lib/signal-engine/scan.js)) — but **triplicated** (Python + module + inline route copy) and no UI consumes its cube |
| 5 | Research-library pool ([`data/tesseract/manifest.json`](../../data/tesseract/manifest.json) via [`routes/csf.js`](../../routes/csf.js)) | PDF→`.csf` research pool injected into chat prompts | **LIVE plumbing, EMPTY pool** (`count: 0` since 2026-07-03) |
| 6 | [`src/csf_rust/src/wavefront.rs`](../../src/csf_rust/src/wavefront.rs) | Rust port of the wavefront concept | **CI-built, runtime-orphan** (no JS/Python binding loads it) |
| 7 | `cadd_rust/src/assess.rs:216` | A comment meaning **Tesseract OCR** | Pure name collision |

And **three different objects answer to "Status-Cube"**: the research cube (belief × observer × state —
the spiral/singularity 3³ projection, design vocabulary only), the implemented
[`src/convergence_io/status_cube.py`](../../src/convergence_io/status_cube.py) (a **4D nav matrix**:
location × lane × boundary × timeline, + Bayesian belief dims), and the Three-Doors player cube
([`src/csf/status_cube.py`](../../src/csf/status_cube.py)).

**Naming verdict [design — adopted by this doc]:** "tesseract" stays an **internal shorthand only** —
the brand guidelines already ban it on user surfaces ([`../KEYSTONE-BRAND-GUIDELINES.md`](../KEYSTONE-BRAND-GUIDELINES.md)
principle 1), and outside the repo the word belongs to a QEC decoder and an OCR engine. External-facing
names are **CSF** (the trademark-worthy coinage), **Status-Cube**, **Convergence-IO**. Everywhere below,
referents are qualified (#1–#7), never bare "the tesseract."

---

## 2. The surviving kernel — four primitives

Everything applicable below reduces to four things. Each is stated once here and referenced by
the map in §3.

### K1 — The field (the one big survivor)

A per-unit scalar measuring **how surprising this unit is under a predictive model**, spent as
a budget:

```
L(x)   = −log₂ p(x | context)      bits         (lapse field / code length / surprise)
D(v)   = f(uncertainty, cost, confidence)        (dilation — the governance form)
σ²ₘ    = measured per-market variance            (send-on-delta — the market form)
NIS    = normalized innovation squared           (decode-canary — the control form)
```

These are one discipline in four dresses: **predictable ⇒ spend ~nothing (horizon/dust cell,
fast node, slow poll); surprising ⇒ spend heavily (flat cell, dilated node, fast poll, hard
grounding)**. E3 measured the field real and strongly non-uniform on repo data
**[measured]**; Shannon/Kraft make `L` the uniquely correct price **[grounded]**; the
relativity dress stays dead **[killed — metaphor]**.

Three live incarnations today: [`grounding-policy.js`](../../lib/grounding-policy.js)
(chat, live), [`kalshi-adaptive-poll.js`](../../lib/kalshi-adaptive-poll.js)
(trade, flag-gated), [`src/convergence_io/dilation.py`](../../src/convergence_io/dilation.py)
(governance, unit-tested; JS adapter live). One installed-but-closed valve:
[`token-surprise.js`](../../lib/token-surprise.js).

### K2 — The cube (the projection)

The **Status-Cube** idea: a small, human-readable projection of system state. Precision matters
here because three cubes share the name (§1.1): the *research* cube (belief × observer × state,
the spiral/singularity 3³ projection) remains **design vocabulary**; the **implemented** cube is
[`src/convergence_io/status_cube.py`](../../src/convergence_io/status_cube.py) — a 4D nav
matrix (location × lane × boundary × timeline + Bayesian belief dims), currently engine-internal
/ CLI-only. The map's cube applications (A4–A6) target the implemented one. The 12-axis
generalization stays a **design proposal** (singularity doc §2.2) — nothing here depends on it.

### K3 — The store (the data structure)

The **wavefront/dust sparse-delta store** ([`src/csf/v07/`](../../src/csf/v07/) +
[`src/converged_tesseract.py`](../../src/converged_tesseract.py)): baseline + active deltas,
everything else implicit ("no change is free"), reads via a minimal observer-collapsed
wavefront. **Engineering value only** — the IP register dropped every novelty claim; its
`base3_cyclic` codec measurably loses to `delta+varint+zstd` **[measured]**. Kept because it is
the shipped substrate of the Status-Cube container and CSF's v0.7 lineage.

### K4 — The method (the harness)

The **teacher-forced kill-criteria harness** (kill doc §3–5): state the kill criterion before
running; report raw *and* adjusted (model-counted) numbers; round-trip-verify; let the table
overrule the prose. This is the repo's standard for vetting any candidate technique before it
touches product code — reused for every `[design — falsifiable]` row in §4.

---

## 3. The application map

Each surface: **live today** (evidence) → **apply next** (numbered `A#`; every experimental
claim reappears in §4 with its kill criterion). Wiring facts below were re-mapped from source
on 2026-07-21.

### 3.1 CSF — *Remember*

**Live today.** Canonical compression is `csf` v2 (zstd best-fit + integrity) — the lattice
plays no part in it. Live chat retrieval is keyword-IDF candidate selection + a
**nomic-embed-text cosine rerank** ([`csf-memory.js:254-269`](../../lib/csf-memory.js),
[`semantic-reranker.js`](../../lib/semantic-reranker.js), keyword fallback);
the benchmarked number is LongMemEval multi-signal **recall@5 0.709 vs keyword 0.222**
([`../BENCHMARKS.md`](../BENCHMARKS.md)). The v07 store (K3) is dormant substrate.

**Apply next.**
- **A1 — refill the research pool [operational].** The "tesseract library" prompt-injection
  pipe is live end-to-end ([`routes/csf.js`](../../routes/csf.js) →
  `queryResearchLibrary` → chat prompt) but the pool is **empty** — `data/tesseract/manifest.json`
  has `count: 0` since 2026-07-03. Repack via `scripts/csf_research_tesseract.py`, seeding with
  this thread's own seven ledger docs. (The tesseract research pool does not currently contain
  the tesseract research.)
- **A2 — run E4's honest successor [design — falsifiable].** The lapse doc's E4 (field-ranked
  retrieval) was never run. Its two shipped-adjacent forms: **(a)** enable
  `CSF_RECALL_PROMOTION=1` on the Python engine and test whether the **+22pp@5** promotion win
  (#1685, measured once, left unwired — [`memory_engine.py:537-555`](../../src/csf/memory_engine.py))
  reproduces on the current corpus; **(b)** A/B a surprise-weighted candidate scorer against the
  shipped rerank on the LongMemEval harness. Kill criteria in §4.
- **A3 — X1/X2 demoted to library hygiene.** Round-trip integrity and wavefront minimality stay
  unrun; they only earn compute if the v07 store ever reaches a product path.

**Honest gap.** The benchmarked engine (Python `MemoryEngine`, tier ladder, promotion) and the
live retriever (JS `csf-memory.js`) are **different code**. The "0.709" and the "+22pp" live on
different paths; converging them is Remember-stage work under the one-memory law — the map
proposes convergence of the two, never a third.

### 3.2 Convergence-IO — *Act + Verify + Converge*

**Live today.** The **actually-live** thing named tesseract: `TesseractEngine.converge()`
routes every adapter-guarded turn through 4 layers with circuit breakers and CSF+RAG enrichment
(#1 in §1.1). The **`D` dilation field** ([`src/convergence_io/dilation.py`](../../src/convergence_io/dilation.py) +
[`../convergence-io/DILATION.md`](../convergence-io/DILATION.md)) is the thread's one idea the
IP register graded **up** — `grounding_policy(D)` is the load-bearing bridge, and the register
holds it as a patent opt-out candidate (§4.4). The convergance-record ledger
(`data/convergence/records.jsonl`, JS/Python byte-compatible shape) is canonical.

**Apply next.**
- **A4 — one cube [hygiene].** `ConvergenceLoop` phases 12–14 reimplement cube navigation
  inline ([`convergence_io_engine.py:1406-1474`](../../src/convergence_io_engine.py)) instead of
  importing [`status_cube.py`](../../src/convergence_io/status_cube.py); fold onto the class
  (extension-over-addition; removes a duplicate). Parity-gated.
- **A5 — field-stamped records [design — falsifiable].** At emit, stamp each ConvergenceRecord's
  `grounding_signals` with the node's `D(v)` (and cube coordinate once A4 lands) — today those
  fields are empty at JS emit and only the Python Verify pass fills them. Then measure on the
  both-class ledger whether **D at birth predicts verification outcome** (Brier lift over
  `confidence` alone). If the field can't predict which claims survive verification, it is
  decoration at the record level — that is this proposal's kill.
- **A6 — cube surfacing [operational].** Expose a read-only `StatusCube.snapshot()` through the
  existing `/api/status` aggregation ([`lib/status.js`](../../lib/status.js))
  — today the cube has **no** HTTP or MCP surface at all. No new route family.

### 3.3 Chat — *Observe + Remember + Verify*

**Live today.** The field runs on chat's hottest path: `chatDilation(message)` →
`groundingPolicy(D)` → web breadth / corroboration floor / deep-mode
([`grounding-policy.js`](../../lib/grounding-policy.js)), plus the
**boiling-frog hard cadence** (mandatory external re-grounding every 30 min regardless of
proximity — the #1012 defense). `recall_memory` is a native tool. The **surprise valve stays
closed**: [`token-surprise.js`](../../lib/token-surprise.js) is plumbed to
the canary but no production caller parses provider logprobs, so `modelUncertainty` is always 0.

**Apply next.**
- **A7 — open the valve [design — falsifiable; specified 2026-06-30].** Parse local/OSS-provider
  logprobs → `surpriseField` → `modelUncertainty` (raise-only sharpening; Anthropic-safe no-op).
  This is the resonator doc's hypothesis, unbuilt for three weeks; it rides entirely on existing
  primitives.
- **A8 — measured dilation [design — falsifiable; depends on A7].** Today's `chatDilation` is a
  regex heuristic over the *prompt*. With A7's plumbing, augment it with **measured** per-token
  surprise of the *draft* — the model's own uncertainty replacing keyword guesses in
  `collapseProximity`/uncertainty.

### 3.4 Trade — *Observe + Act*

**Live today.** The Σ₀ EV verdict + adaptive signal weights run inside the scan; the Kalshi
suggest engine gates on **measured resolved-ledger expectancy** (not win-rate) and **emits a
ConvergenceRecord per tradeable entry** ([`kalshi-suggest.js:415-427`](../../lib/kalshi-suggest.js))
— the Trade→Converge link already exists. The field's market form —
**send-on-delta polling, `dt = β/σ²ₘₐₓ`** ([`kalshi-adaptive-poll.js`](../../lib/kalshi-adaptive-poll.js),
grounded in arXiv:1707.02531 / arXiv:1609.07534) — is implemented, wired into the collector, and
**default OFF** (`KALSHI_ADAPTIVE_POLL=1`). The `TradingTesseract` 5-dim evaluator (#4 in §1.1)
runs as an advisory cross-check but exists in **three parallel copies** and no UI shows its cube.

**Apply next.**
- **A9 — turn the send-on-delta flag on for a measured week [design — falsifiable].** This is
  literally K1 over market time: poll where variance is high, idle where it is low. Measure
  delta-detection latency + 429 rate vs the fixed 6 s clock; flip the default only on a win.
- **A10 — de-triplicate [hygiene].** Fold the Python and inline-route copies of the evaluator
  onto the signal-engine module. Parity-gated. (Surfacing the cube in a UI is a product call,
  out of scope here.)

### 3.5 Explore — *Observe + Reason*

**Live today.** Explore is a first-class surface: `explore.html` (top-nav dashboard) +
[`routes/explore.js`](../../routes/explore.js) serving a **PCSF-ranked
merged feed** with an interaction leaderboard (`data/explore/interactions.jsonl`) and CTR
metrics ([`../research/explore-content-machine.md`](explore-content-machine.md)).

**Apply next.**
- **A11 — explore/exploit as the field over the feed [design — falsifiable].** The feed ranks by
  an engagement leaderboard — pure exploitation. Add the K1 discipline: per-item **Beta
  posterior** over interactions (the grounding-economy math the repo already ships,
  [`../KEYSTONE-IP-AND-BUILDOUT.md`](../KEYSTONE-IP-AND-BUILDOUT.md) §4.3) plus an uncertainty
  bonus (Thompson-sample or UCB term) in [`explore-feed.js`](../../lib/explore-feed.js)
  scoring: **exploit wells** (known-high-CTR items), **probe flats** (wide-posterior items).
  An extension of the existing ranker — no new subsystem. Offline-replayable against
  `interactions.jsonl` before any live A/B.
- The 12-axis "Dream/explore" semantics (singularity §2.2) stays a design proposal; A11 does
  not depend on it.

---

## 4. Falsification table — the new claims

Per K4: kill criteria stated before any build. Operational/hygiene items (A1, A3, A4, A6, A10)
are tasks, not claims, and carry parity gates instead of kill rows.

| # | Claim under test | Method | Kills the claim if… |
|---|---|---|---|
| **A2a** | Retrieval-triggered promotion still buys recall | `CSF_RECALL_PROMOTION=1`, LongMemEval harness, current corpus | recall@5 gain < +10pp over the same engine unpromoted (i.e. the one-time +22pp does not meaningfully reproduce) |
| **A2b** | Surprise-weighted candidate scoring beats the shipped rerank | A/B on the LongMemEval harness at equal k | ≤ shipped multi-signal 0.709 recall@5 / 0.486 MRR |
| **A5** | `D` at emit predicts verification outcome | Stamp `D(v)` into `grounding_signals`; Brier on the both-class ledger after ≥200 verified/refuted records | no Brier lift over `confidence` alone |
| **A7** | Opening the surprise valve improves verified-pass-rate | Held-out tasks, valve-open vs `modelUncertainty=0` (resonator doc's stated test) | no verified-pass-rate gain **and** no canary-firing reduction |
| **A8** | Measured surprise beats regex dilation | A/B `chatDilation` regex vs surprise-augmented on the same eval set | no reduction in unsupported-claim rate at equal latency budget |
| **A9** | Send-on-delta beats the fixed 6 s clock | `KALSHI_ADAPTIVE_POLL=1` for one measured week vs baseline week | delta-detection latency **or** 429 rate worsens |
| **A11** | An uncertainty bonus improves feed discovery | Offline replay on `interactions.jsonl`, then 2-week A/B | no lift in discovered-winners (items reaching top-CTR after first exposure) at ≤noise overall-CTR cost |
| **Q1** | TQ1_0 packing is the right serving-artifact format (§5) | Bench TQ1_0 vs TQ2_0 (+ DBF/BiSCo watch arms, B9) on the 8 GB target when the ADR-0026 artifact exists | TQ1_0 tokens/s < 0.85× TQ2_0 and the ~0.33 GB RAM saving unlocks nothing (context/model size) |
| **A12** | A 1-bit/dim RaBitQ embedding cache preserves rerank quality (§5, B7) | Cache + bitwise prefilter vs the live float rerank on the LongMemEval harness | recall@5 or MRR drops > 1 pt, **or** no measured latency/RAM win |
| **Q2** | CSF-Omni's "ties-brotli envelope" survives neutral grading (§5, B8) | Run CSF-Omni over the AITDCC-2026 public corpus; compare leaderboard references (ratio + Weissman) | CSF-Omni lands below the **zstd-19 reference** on ratio → the spec's envelope claim gets a corpus-scope caveat |

---

## 5. Addendum (2026-07-21) — qutrit ↔ binary & higher-dimensional compression: research brief + brainstorm

Requested mid-review: *"research qutrit binary compression and brainstorm"*, then *"higher
dimensional binary file compression."* The brief below is web-verified; the brainstorm is
graded against the kill doc's floor so nothing dead is revived.

### 5.1 The settled floor (not relitigated)

Base-3 confers **zero entropy advantage** — Shannon's bound is radix-invariant, radix economy
is about digit/hardware cost, and the v07 `base3_cyclic` codec measurably **lost** to generic
`delta+varint+zstd` by 1–8% (kill doc §1–2). Any ternary idea below must pay somewhere *other*
than entropy.

One overdue naming correction **[implemented — checked against source]**: the v07 "qutrit" cell
is not base-3 at all — `QutritState` is an **octal pair** (amplitude 0–7 × phase 0–7, 6 bits).
The genuinely ternary object is the **lattice address** (12 coordinates over `{-1,0,+1}` — a
12-trit word). "Qutrit" in this repo is legacy decoration on a 6-bit slot.

### 5.2 What the literature actually offers (verified 2026-07-21)

**(a) Trit-in-bit packing is a solved, near-lossless craft.** 5 trits into one byte
(3⁵ = 243 ≤ 256) stores trits at 1.6 bits vs the log₂3 ≈ 1.585 ideal — **99.06% packing
efficiency** ([Compilade, *How to pack ternary numbers in 8-bit bytes*](https://compilade.net/blog/ternary-packing);
[IOTA TIP-5](https://iotaledger.github.io/tips/tips/TIP-0005/tip-0005.html) is production prior
art; general treatment [arXiv:1807.06419](https://arxiv.org/pdf/1807.06419)). The shipping form
is **llama.cpp's ternary quants** ([PR #8151](https://github.com/ggml-org/llama.cpp/pull/8151)):
**TQ1_0 = 1.6875 bpw** (5 elements/byte) and **TQ2_0 = 2.0625 bpw** (2 bits/element, usually
faster kernels) — built exactly for BitNet b1.58 / TriLM weights
([bitnet.cpp, arXiv:2502.11880](https://arxiv.org/pdf/2502.11880); post-training ternarization
[PT²-LLM, arXiv:2510.03267](https://arxiv.org/pdf/2510.03267)).

**(b) Hardware is where ternary genuinely wins — as signaling, not entropy.** **GDDR7 ships
PAM-3**: three voltage levels `{-1,0,+1}`, ~1.5 bits/cycle — 50% more data per cycle than
binary NRZ with better voltage margin than PAM-4
([Micron](https://www.micron.com/about/blog/memory/dram/unveiling-the-next-generation-of-graphics-memory-gddr7) ·
[Rambus](https://www.rambus.com/blogs/all-you-need-to-know-about-gddr7/) ·
[Keysight compliance tooling, 2026](https://www.keysight.com/us/en/about/newsroom/news-releases/2026/0217-pr-26-025-keysight-introduces-pam3-signaling-with-new-gddr7-transmitter-compliance-solution-for-next-generation-graphics-memory.html)).
The honest ternary story for this repo is the same one: **ternary pays in hardware/serving
economics (BitNet add-only matmul, PAM-3 wires, packed weights), never in codecs.**

**(c) Actual qutrits (quantum) exist and do not transfer.** Schumacher compression generalizes
to d-level systems (S(ρ) per state; [quant-ph/0207069](https://arxiv.org/pdf/quant-ph/0207069)),
and intermediate-qutrit circuit compression is a real research line
([ACM ToQC](https://dl.acm.org/doi/10.1145/3406309)). All of it requires quantum hardware; the
repo's "qutrit" is a classical 6-bit slot (§5.1). Door closed, with citations rather than vibes.

### 5.3 The "higher-dimensional binary compression" landscape (verified 2026-07-21)

In the 2025–2026 literature the phrase resolves to **four live programs** — none of which is
the killed geometric-arrangement claim, and two of which directly serve this project's surfaces:

**(a) Binary / extreme-low-bit weight compression.** **DBF** — *Addition is almost all you
need* ([arXiv:2505.11076](https://arxiv.org/abs/2505.11076), ICML 2025): factor a dense weight
matrix into **two binary sign matrices + scaling vectors**; best-in-class at 1 bpw, competitive
with QuIP#/QTIP at 2 bpw, with a continuous ratio dial (the intermediate dimension).
**BiSCo-LLM** ([arXiv:2607.08643](https://arxiv.org/pdf/2607.08643), 2026-07): codebook-free
**binary spherical coding** — weight chunks mapped to a unit hypersphere and stored as a
bit-packed sign stream + residual BSQ stage, no lookup tables. Lattice VQ is also active
(Leech-lattice quantization, [arXiv:2603.11021](https://arxiv.org/pdf/2603.11021)). *Relevance:
these are the 1–2 bpw alternatives sitting right next to ternary TQ packing for the ADR-0026
serving artifact — watch items for Q1's bench, not separate builds (B9).*

**(b) High-dimensional vector quantization with guarantees.** **RaBitQ**
([arXiv:2405.12497](https://arxiv.org/abs/2405.12497), SIGMOD 2024): quantize a D-dim vector to
**D bits** with an **unbiased distance estimator and a sharp theoretical error bound**;
**Extended-RaBitQ** generalizes to B bits/dim with an asymptotically optimal space–accuracy
trade-off ([library](https://vectordb-ntu.github.io/RaBitQ-Library/)). This is what
"higher-dimensional binary compression" means when it works: compress the *embedding*, keep the
*distance*. *Relevance: the memory reranker's embedding side (A12).*

**(c) Neutral lossless benchmarking.** The **2026 AIT Data Compression Challenge**
([arXiv:2606.17712](https://arxiv.org/abs/2606.17712)): 16 heterogeneous files, public-train /
hidden-test split, **117 submitted compressors** graded on ratio, time, Weissman score, and
Pareto frontier, under ≤8 GB RAM + ≤1 MB decompressor rules; open leaderboard
([aitdcc.github.io](https://aitdcc.github.io)). *Relevance: exactly the External-Reality-Rule
instrument for CSF-Omni's "ties-brotli upper envelope" claim — grade it on someone else's
corpus (Q2).*

**(d) Compression as measurement.** **CID** — computable information density as an
information-theoretic collective variable ([arXiv:2602.22440](https://arxiv.org/abs/2602.22440)):
a compression-based per-configuration entropy estimate that needs **no hand-chosen order
parameters**, validated across molecular systems. An independent field arriving at K1's
conclusion — *a compressor is an instrument, not (only) a store* — which is precisely the
surviving reading of the lapse field (E3). Corroboration, not a build.

Boundary notes: tensor decomposition (Tucker/TT) remains the occupied academic meaning of
"higher-dimensional compression" (kill doc §2.5), and compression-for-clustering of discrete
data ([arXiv:2606.10593](https://arxiv.org/abs/2606.10593)) is lossy analytics — neither
touches the lossless archive path, and neither rescues geometry-as-compression.

### 5.4 Brainstorm — graded

| # | Idea | Grade | Why |
|---|---|---|---|
| **B1** | **Pack the ADR-0026 ternary serving artifact as TQ1_0** (1.6875 bpw): on a 7B-class 1.58-bit distill that is ~1.48 GB of weights vs ~1.80 GB at TQ2_0 — ~0.33 GB back on the 8 GB box | **Build when the artifact exists** → **Q1** in §4 | The one place trit-packing meets a binding constraint (serving RAM). Kernel speed decides: TQ2_0's bit-aligned kernels are usually faster |
| **B2** | Re-pack v07 lattice addresses as true trit-words (12 trits → 20 bits vs int32, −37.5% pre-compression) | **Defer — probably dead** | zstd's entropy stage already erases this; the bar is `delta+varint+zstd`, which base3_cyclic failed. Only worth running if v07 ever reaches a product path (A3's condition) |
| **B3** | Adopt PAM-3/GDDR7 as the canon's external anchor for "where ternary pays" | **Adopt (docs)** | Constructive replacement for the killed base-3-compression story; folds into RESEARCH-CANON's lattice section |
| **B4** | Trit-pack the convergance-record verdict stream (verified/refuted/unknown is a literal trit) | **Reject** | A second binary memory format = the forbidden second memory system; JSONL + zstd already at the floor. Anti-sprawl fence applies |
| **B5** | Quantum-qutrit compression transfer | **Closed** | §5.2(c) — requires quantum hardware; nothing transfers to a classical store |
| **B6** | Ternary-aware column coding inside CSF-Col (#1593) | **Free — already implied** | A 3-symbol enum column hits H ≤ 1.585 bits/symbol automatically via zstd's FSE entropy stage; no ternary-specific code needed. Lesson: hand-rolled trit packing only matters where an entropy coder is absent (weights, wire formats, RAM layouts) — inside a compressor it is redundant |
| **B7** | **RaBitQ-packed embedding cache for the memory reranker**: persist candidate embeddings once (768-dim nomic ≈ 3 KB fp32 → **96 B at 1 bit/dim, ~32×**), bitwise-estimator prefilter before the exact rerank | **Build candidate** → **A12** in §4 | The one high-dimensional-binary technique with a guarantee (unbiased estimator + error bound) meeting a real cost on the Remember path (per-query re-embedding today). Graceful float fallback preserved |
| **B8** | **Grade CSF-Omni on the AITDCC-2026 corpus** — someone else's 16 files, someone else's leaderboard | **Adopt (bench)** → **Q2** in §4 + a 📋 Planned row in [`../BENCHMARKS.md`](../BENCHMARKS.md) | The spec's "ties brotli as upper envelope" claim has only ever been measured on our own corpora; this is the neutral instrument for it |
| **B9** | DBF / BiSCo-LLM as 1–2 bpw alternatives for the ADR-0026 serving artifact | **Watch — folds into Q1** | Same bench matrix as TQ1_0/TQ2_0 when the artifact exists; no separate build. Keeps "models are interchangeable" honest at the packing layer too |

The brainstorm's net: **three build/bench candidates (B1/Q1, B7/A12, B8/Q2), one docs adoption
(B3), one watch item (B9), and four honest closures.** Ternary's future in this project is the
serving artifact, not the archive — and the binary-side wins are the embedding cache and the
neutral benchmark, not a new codec.

---

---

## 6. What is NOT proposed (anti-sprawl fence)

- **No revival of killed claims.** No compression-by-geometry, no depth-as-code-length, no
  base-3-as-compression, no relativity framing. Any future re-open must first beat the kill
  doc's tables with new evidence, per K4.
- **No new subsystem.** Every §3 item extends an existing module on an existing surface;
  nothing adds a top-level thread. (Feature-gate check: each row names its loop stage.)
- **Models stay interchangeable.** Every application consumes the field through model-agnostic
  interfaces (logprobs, variance, NIS scalars) — never model internals. Where a provider
  exposes no logprobs (Anthropic), the consumer degrades to no-op, exactly as
  [`token-surprise.js`](../../lib/token-surprise.js) already does.
- **No physics.** "Dilation" names a scalar multiplier on latency/budget; "horizon" names a
  zero-bit cell. Both are bookkeeping terms over Riemannian/information-theoretic math
  **[grounded]**, and decorative beyond that.

---

## Sources

**Internal (all read on disk 2026-07-21):** the seven ledger docs (§1) ·
[`../convergence-io/README.md`](../convergence-io/README.md) ·
[`../convergence-io/DILATION.md`](../convergence-io/DILATION.md) ·
[`../CSF-FORMAT-SPECIFICATION.md`](../CSF-FORMAT-SPECIFICATION.md) ·
[`../BENCHMARKS.md`](../BENCHMARKS.md)

**External (carried from the ledger docs, all previously verified):** Shannon source coding /
Kraft–McMillan; DeepMind *Language Modeling Is Compression* ([arXiv:2309.10668](https://arxiv.org/abs/2309.10668));
Rissanen MDL / Balasubramanian / Chentsov (Fisher–Rao); BitNet b1.58
([arXiv:2402.17764](https://arxiv.org/abs/2402.17764)); Ouro LoopLM
([arXiv:2510.25741](https://arxiv.org/abs/2510.25741)); Farquhar et al., semantic entropy,
*Nature* 2024; send-on-delta sampling ([arXiv:1707.02531](https://arxiv.org/abs/1707.02531),
[arXiv:1609.07534](https://arxiv.org/abs/1609.07534)); Boiling Frog Threshold
([arXiv:2603.08455](https://arxiv.org/abs/2603.08455)).

**External (newly verified for §1.1 and §5, web-checked 2026-07-21):** Tesseract QEC decoder
([arXiv:2503.10988](https://arxiv.org/abs/2503.10988) · accelerator
[arXiv:2602.02985](https://arxiv.org/pdf/2602.02985) ·
[quantumlib/tesseract-decoder](https://github.com/quantumlib/tesseract-decoder)); Tesseract
tensor parallelism ([arXiv:2105.14500](https://arxiv.org/abs/2105.14500)); F-Hash 4D tesseract
encoding ([arXiv:2507.03836](https://arxiv.org/abs/2507.03836)); TesserAct 4D world models
([arXiv:2504.20995](https://arxiv.org/abs/2504.20995)); Tesseract-OCR-adjacent
([arXiv:2209.09118](https://arxiv.org/abs/2209.09118)); ternary packing
([Compilade blog](https://compilade.net/blog/ternary-packing) ·
[IOTA TIP-5](https://iotaledger.github.io/tips/tips/TIP-0005/tip-0005.html) ·
[arXiv:1807.06419](https://arxiv.org/pdf/1807.06419) ·
[llama.cpp PR #8151](https://github.com/ggml-org/llama.cpp/pull/8151)); bitnet.cpp
([arXiv:2502.11880](https://arxiv.org/pdf/2502.11880)); PT²-LLM
([arXiv:2510.03267](https://arxiv.org/pdf/2510.03267)); GDDR7 PAM-3
([Micron](https://www.micron.com/about/blog/memory/dram/unveiling-the-next-generation-of-graphics-memory-gddr7) ·
[Rambus](https://www.rambus.com/blogs/all-you-need-to-know-about-gddr7/) ·
[Keysight 2026](https://www.keysight.com/us/en/about/newsroom/news-releases/2026/0217-pr-26-025-keysight-introduces-pam3-signaling-with-new-gddr7-transmitter-compliance-solution-for-next-generation-graphics-memory.html));
qutrit/quantum source coding ([quant-ph/0207069](https://arxiv.org/pdf/quant-ph/0207069) ·
[Intermediate qutrits, ACM ToQC](https://dl.acm.org/doi/10.1145/3406309)); DBF
([arXiv:2505.11076](https://arxiv.org/abs/2505.11076)); BiSCo-LLM
([arXiv:2607.08643](https://arxiv.org/pdf/2607.08643)); Leech-lattice LLM VQ
([arXiv:2603.11021](https://arxiv.org/pdf/2603.11021)); RaBitQ
([arXiv:2405.12497](https://arxiv.org/abs/2405.12497) ·
[library](https://vectordb-ntu.github.io/RaBitQ-Library/)); AITDCC-2026
([arXiv:2606.17712](https://arxiv.org/abs/2606.17712) · [aitdcc.github.io](https://aitdcc.github.io));
CID collective variable ([arXiv:2602.22440](https://arxiv.org/abs/2602.22440));
compression-for-clustering ([arXiv:2606.10593](https://arxiv.org/abs/2606.10593)).
