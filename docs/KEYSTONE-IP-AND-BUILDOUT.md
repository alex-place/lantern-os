---
author: Alex Place
created: 2026-06-22
updated: 2026-07-18
---

# unisona.ai — IP Register & Buildout Plan

> **One line:** the genuinely defensible inventions inside unisona.ai, the protection
> vehicle for each, and the plan that ships them — every claim tagged by the External
> Reality Rule, with the weak/overlapping claims consolidated out rather than puffed up.

> **Reading contract.** This document follows unisona.ai's own **External Reality Rule**:
> every material claim carries evidence (a file, a measured number, a citation) and is
> tagged **[implemented]** (code exists and runs), **[measured]** (a number was produced
> by a run), **[grounded]** (external peer literature supports it), or
> **[design / planned]** (intended, not yet built). Prior art is named, not hidden.
> Nothing here is asserted as achievement it has not earned.

> **2026-07-18 consolidation.** The prior 8-item register scattered its signal: four of the
> eight claims were prior-art-heavy or were the *systems framing* of textbook estimators
> dressed as inventions. This pass **cuts and folds** those into the primitives where they
> are actually load-bearing, **promotes the one thing that is genuinely unoccupied ground**
> (the accountability layer) to the top, and **adds the primitives built since 2026-06-22**.
> Net: 7 consolidated inventions, honestly graded, plus an explicit "what was cut" ledger.

---

## ⚠️ Strategy decision record (read first)

**This article is a defensive publication.** It is published openly, with full enabling
detail, on a publicly reachable surface. That choice has deliberate consequences:

1. **Publishing establishes a priority / prior-art date** — it timestamps these inventions
   as public knowledge, which **blocks others from patenting them** and protects
   unisona.ai's freedom to operate.
2. **Publishing forecloses unisona.ai's own patents on the disclosed specs** — outside the
   US entirely (absolute-novelty bar), and in the US after a 12-month grace period.
3. **Therefore the protection stack is: defensive publication + trademark + copyright**,
   *not* a patent portfolio — the right fit for a solo, local-first project.

**False-marking note.** Nothing here is *patent pending* — no application has been filed.
The register uses honest status labels and reserves the **Pre-publication filing gate** (§6)
for any item deliberately pulled *out* of publication to patent instead. Raw invention
**candidates** (the SCAMPER ideation set) are held in a **private ideation doc kept OFF this
public repo** — because this repo is public, committing them would itself be the disclosure
that forecloses the patent option. They are triaged in §6.

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

## 2. The moat is not the parts

The honest baseline ([OSS-BASELINE.md](OSS-BASELINE.md), 8-agent / 178-lookup audit,
2026-07-06): **unisona.ai is assembly, not invention** — proven OSS components (OpenHands,
Aider, LiteLLM, Ollama, Ouro, SWE-bench harness, MiniCheck) plus one accountability layer
nobody ships. Because the parts are copyable, **the moat is execution quality + the
compounding owned data** (approvals, rejections, per-repo outcome history, receipts, the
convergance-record ledger), not any single algorithm. Every invention below is judged
against that reality: the ones that matter are *systems and formalizations*, not new math.

---

## 3. IP register (consolidated)

### 3.1 Inventions / methods (defensive-publication register)

Status: **DP** = covered by defensive publication · **DP-pending** = will be when published ·
**opt-out** = candidate to pull and patent instead (§6). Novelty graded honestly against the
prior art *named in each spec* — a **product-moat** grade means the value is execution + data,
not a patentable method.

| # | Invention (consolidated) | Folds in | Novelty | Vehicle | Spec |
|---|---|---|---|---|---|
| **1** | **Accountability layer** — owned memory + HOLD-for-approval + verifiable receipts + per-repo outcome routing over stateless coding agents | *(new; the OSS-BASELINE thesis, now implemented)* | **Highest — but product-moat, not algorithm** | Defensive pub + trade-secret data | [§4.1](#41-accountability-layer) |
| **2** | **Closed-loop decode/verify controller** — model-free NIS surprise → decode actuator, + commit-first (de-anchored) acceptance | old §4.2 decode canary · ADR-0017 surprise-gated · de-anchored verifier · two canary axes | **Medium — most patent-viable** | Defensive pub (opt-out candidate) | [§4.2](#42-closed-loop-decodeverify-controller) |
| **3** | **Grounding economy** — grounding priced/scheduled/budgeted as an append-only, replayable trust ledger that substitutes for fine-tuning | old §4.1 fast-layer plasticity · Σ_G Grounding Ledger | **Medium** | Defensive pub | [§4.3](#43-grounding-economy) |
| **4** | **Convergence-IO governance primitives** — NAP-over-capability ordering invariant + dilation-field-as-grounding-budget | old §4.6 (sharpened to the 2 real deltas) | **Medium (dilation primitive = opt-out candidate)** | Defensive pub | [§4.4](#44-convergence-io-governance-primitives) |
| **5** | **Verified-gated self-improvement** — double ground-truth gate + both-class honest convergance-record ledger mined from session history | old §4.8 flywheel · convergance-record discipline · session→records | **Medium** | Defensive pub | [§4.5](#45-verified-gated-self-improvement) |
| **6** | **Σ₀ collapse certificate + Lemma L2** — Lyapunov-bounded anti-collapse; machine-checked | old §4.5 (unchanged) | **Medium — as *formalization*, not mechanism** | Copyright + arXiv (not patent) | [§4.6](#46-σ₀-collapse-certificate--l2) |
| **7** | **CSF** — one integrity-checked best-fit lossless container on a ternary lattice substrate | old §4.3 lattice + §4.4 CSF-Omni (merged, honestly downgraded) | **Low — format identity + integrity, not algorithm** | Defensive pub + trademark (name) | [§4.7](#47-csf-convergence-fitted-format) |

**Cut / downgraded in this pass (the "trash" ledger — honesty, not deletion of history):**
- **Convergence-exit** (old §4.7) — a real but *incremental* extension of Ouro Q-exit / DEQ
  fixed-points. **Not a standalone invention.** Retained only as a one-line adaptive-depth
  note under Reason; DEQ is close prior art, claims were always weak.
- **3¹² ternary-lattice "novelty"** — the substrate is base-3/BitNet/HDC, all published; the
  repo's *own* falsification showed the BitNet-sparsity match was a population coincidence.
  Folded into #7 as engineering, novelty claim **dropped** to the wavefront/dust data
  structure only.
- **Fast-layer plasticity as a standalone** — Beta posterior + Brier are textbook. Folded
  into #3 where the *ledger economy* (price/schedule/budget) is the actual delta.
- **CSF-Omni "422×"** — corpus-specific (repetitive JSONL); multi-codec best-fit is a known
  technique. Kept as integrity/format value in #7, headline-number puffery removed.

### 3.2 Trademarks

| Mark | Type | Strength | Status | Note |
|---|---|---|---|---|
| **unisona.ai** | Word mark | Strong (arbitrary in context) | **File first** | Clearance search — check prior software marks |
| **CSF** / **Convergence-Fitted Searchable Format** | Word mark | Strong (coined) | File | Clean coinage; the one part-name worth defending |
| **Σ₀ Collapse Certificate** · **Convergence Core** | Word marks | Moderate | File w/ brand | Protect the compound, not the glyph |
| **Convergence-IO** · **Status Cube** · **Observer Mesh Cube** | Word marks | Weaker (descriptive) | Optional | Brand-family, budget-permitting |
| ⚠️ **"Ouro" / "Ouro Coder"** | — | **Do NOT claim** | **Avoid** | "Ouro" is **ByteDance's** model (Apache-2.0). Brand the coder as **"Σ₀ Coder"**; describe the integration ("Σ₀ runs on Ouro"), don't ride the mark. |

### 3.3 Copyright

- **Automatic** on all source + specs from authorship. Add a repo-root `LICENSE` + per-file
  headers; **register** the two flagship written works (the [CSF spec](CSF-FORMAT-SPECIFICATION.md)
  and the [Collapse Certificate](SIGMA0-COLLAPSE-CERTIFICATE.md)) if statutory-damages leverage
  is wanted (~$45–65 each).

---

## 4. Per-spec breakdown (full enabling detail)

### 4.1 Accountability layer

**What it is.** The four-part control plane that no mature OSS coding agent ships, sitting
*over* any stateless executor (OpenHands / Aider / a cloud coder): (1) **owned, cross-session
memory the user controls**; (2) a **policy gate that HOLDS consequential actions until
approval**; (3) **verifiable receipts** (diff + test + source + cost + why-this-model); and
(4) **outcome-based routing** that learns which backend wins on *the user's own* repos.

**How it works** ([implemented] — [`lib/coding-backend/index.js`](../apps/lantern-garage/lib/coding-backend/index.js) `propose → HOLD → verify → receipt`; [`routes/coding.js`](../apps/lantern-garage/routes/coding.js) operator-gated HTTP seam; [`lib/council-review.js`](../apps/lantern-garage/lib/council-review.js) Δ + answerability gate; [`lib/pr-watcher.js`](../apps/lantern-garage/lib/pr-watcher.js) green-+-APPROVE auto-merge; provider routing `data/provider.pcsf.json`):
- A backend **proposes** a change; the plane **holds** it (never applies immediately, unlike
  Aider/OpenHands), attaches a **verifier verdict** (exec-verify + council Δ + canaries), and
  emits a **receipt** to an append-only ledger. Approval is operator-gated.
- Routing is **outcome-based per-repo** — the leaderboard learns which provider wins on this
  user's repos, not a global average.

**Loop stage:** Act + Verify + Converge.

**Novelty claim (honest).** **Not a method — a systems position.** The individual parts
(policy gates, provenance, routing) all exist; the contribution is the *integrated, HOLD-first,
receipted, per-repo-learning* layer over commodity executors, and the **compounding owned data**
it accrues (approvals, rejections, outcomes). That data is the real, non-copyable moat.

**Prior art (design-around map):** OpenHands/Aider (stateless executors); RegTech approval
workflows; SLSA/in-toto build attestations; RouteLLM/Martian routing. The composition + owned
data is the delta. Protect by defensive pub (freedom-to-operate) + trade-secret on the data.

### 4.2 Closed-loop decode/verify controller

**What it is.** A model-free controller that closes the **instrument → actuator** loop on the
Verify stage: live decode-health + a mean-reverting Kalman/NIS surprise frame drive decode
knobs *and* a commit-first acceptance test — so a degenerating or confidently-wrong generation
is detected and corrected in real time, not measured after the fact.

**How it works** ([implemented] — [`src/sigma0/decode_canary.py`](../src/sigma0/decode_canary.py) + [`tests/test_decode_canary.py`](../tests/test_decode_canary.py); ADR-0017 surprise-gated decoding; de-anchored acceptance [`experiments/deanchored_verifier.py`](../experiments/deanchored_verifier.py)):
- Per token, self-repeat + n-gram echo + argmax margin + realized exit depth + a two-sided
  softmax-entropy z-score fold (w=0.6/0.3/0.1) into a **1-D Kalman observation**, mean-reverting
  to a *healthy* prior so sustained looping yields sustained high **NIS** (never adapts to the
  collapse). High NIS → `sigma0_proximity()→1` → `knobs()` actuate: suppress repetition, inject
  novelty, exit the latent loop sooner. Pure-CPU, consumes ids + scalars, never model tensors.
- **De-anchored acceptance** (the Verify half): a judge **commits its own answer before seeing
  the candidate**, accepting iff they match — measured to cut the reward-hacking false-positive
  basin (mock: FPR 0.72→~0.0). This is the *second* canary axis (confident-but-unanchored) made
  actionable.

**Loop stage:** Act (decode) + Verify (surprise + acceptance).

**Novelty claim (honest).** The **closed-loop coupling**: a model-free NIS controller
mean-reverting to a health prior that converts multi-signal degeneration into one proximity
scalar which *actuates* the decoder, unified with commit-first acceptance. Each ingredient is
known; the per-token controller + the anchor-breaking accept are the contribution. **Highest
patent-viability item → §6 opt-out candidate.** (The de-anchor step itself *implements*
published prior art [arXiv:2607.05904], so the patentable core is the controller, not the
de-anchor.)

**Prior art:** repetition penalty / no-repeat-ngram; entropy-aware & contrastive decoding;
Kalman NIS fault detection (aerospace); reference-free-judge failure (arXiv:2607.05904).

### 4.3 Grounding economy

**What it is.** Treating grounding as something with a **price, a schedule, and a budget** —
an append-only, replayable trust ledger whose folds substitute for fine-tuning: real-time
per-loop adaptation that is instant, reversible, and never touches weights.

**How it works** ([implemented] — [`lib/grounding-calibration.js`](../apps/lantern-garage/lib/grounding-calibration.js); economics [SIGMA0-GROUNDING-LEDGER.md](SIGMA0-GROUNDING-LEDGER.md)):
- A grounding event `{key, predicted, outcome}` with `outcome` = **external** truth (web check,
  settled market, passing test — never the model's say-so) appends to
  `data/convergence/grounding-calibration.jsonl`. Fast weight = Beta posterior mean
  `(1+hits)/(2+n)`; quality = Brier. The **ledger** (Σ_G) adds the economics: grounding has a
  *cost* (latency/$/exclusivity), a *schedule* (when to re-ground — self-triggered), and a
  *budget* (how much to spend where), composable across surfaces.

**Loop stage:** Verify → Converge → (consumed by) Reason/route.

**Novelty claim (honest).** Not the Beta/Brier estimators (textbook). The delta is the
**economic framing** — grounding as a priced/scheduled/budgeted resource over a replayable
ledger — as a *fine-tuning substitute* honoring "learning via retrieval + experience, not
weight modification." **Prior art:** Beta-Bernoulli; Brier (1950); online calibration;
value-of-information; self-triggered control. Integration + economics is the contribution.

### 4.4 Convergence-IO governance primitives

**What it is.** A typed governance layer routing every action through a constraint-satisfying
graph with provenance. After consolidation, **two** primitives carry the novelty (the rest is
composition of OPA/PROV/capability-systems prior art):
- **NAP-over-capability ordering invariant** — a hard denial **cannot** be overridden by a
  capability claim. Gate order: **classify → deny → prove → route → record.**
- **Dilation-field-as-grounding-budget** — a per-node time-dilation field `D` over the typed
  graph `G=(V,E,D,τ,S,H)` that *slows uncertain regions, speeds confident ones* → mapping
  directly to how much grounding to buy where.

**How it works** ([implemented + unit-tested] — [`src/convergence_io/`](../src/convergence_io/); live JS adapter [`grounding-policy.js`](../apps/lantern-garage/lib/grounding-policy.js)).

**Loop stage:** Act + Verify.

**Novelty claim (honest).** The **NAP-over-capability ordering** and the
**dilation-as-grounding-budget** primitive. The dilation primitive is the single piece with
the most independent method-patent potential → **§6 opt-out candidate.** **Prior art:**
OPA/Rego; capability security; W3C PROV; constraint-graph planners.

### 4.5 Verified-gated self-improvement

**What it is.** A closed, **offline** self-improvement loop with **two independent ground-truth
gates** *and* an honest, both-class record ledger it learns from — reconciling "self-improvement"
with "no online weight modification."

**How it works** ([implemented] — [SIGMA0-CONTINUAL-TRAINING.md](SIGMA0-CONTINUAL-TRAINING.md); ledger [`lib/convergence-records.js`](../apps/lantern-garage/lib/convergence-records.js) → `data/convergence/records.jsonl`; grader [`lib/convergence-outcome-grader.js`](../apps/lantern-garage/lib/convergence-outcome-grader.js); miner [`scripts/session_to_convergence.py`](../scripts/session_to_convergence.py); repair [`scripts/repair_convergence_records.py`](../scripts/repair_convergence_records.py)):
- **Gate 1 (input):** only execution-verified (green) subprocesses become training data.
  **Gate 2 (output):** only a *measured* pass@1 win promotes a new adapter. Offline, no user data.
- The **convergance-record ledger** is the calibration/selection corpus: `[claim, evidence,
  confidence, verified/refuted]`, kept **both-class** on purpose (refutations retained, not
  discarded), mined from Claude session history, and honesty-repaired (verified-laundering
  demoted). This is what makes the flywheel drift-*resistant*: it learns from being wrong.

**Loop stage:** Converge.

**Novelty claim (honest).** The **double ground-truth gate + both-class refute-then-correct
record ledger** as a drift-resistant, offline, no-user-data flywheel. **Prior art:** STaR /
rejection-sampling FT; RLAIF; execution-feedback code training. The double-gate + both-class
honesty fencing is the contribution.

### 4.6 Σ₀ collapse certificate + L2

**What it is.** A Lyapunov-contraction theorem (scoped to normal operators) + the Σ₀ trigger +
**Lemma L2** (a closed-form, machine-checked one-step anisotropy lift) that bound the reasoning
loop against collapse into confident nonsense.

**How it works** ([proven] + [implemented] — [SIGMA0-COLLAPSE-CERTIFICATE.md](SIGMA0-COLLAPSE-CERTIFICATE.md), [SIGMA0-L2-ANISOTROPY-LIFT-PROOF.md](SIGMA0-L2-ANISOTROPY-LIFT-PROOF.md), [`src/cio_sde/collapse.py`](../src/cio_sde/collapse.py); 48 passing tests).

**Loop stage:** Verify (the safety mechanism for the whole loop).

**Novelty claim (honest — formalization, not mechanism).** The 2026-07 novelty audit concluded
the cert has **no novel *mechanism*** — it rigorously **formalizes and measures** a known
phenomenon (grounding prevents self-referential collapse), with its corners mapping to
established methods (simulated-annealing de-ratcheting, self-triggered control, bounded-input
reachability). The genuine contributions are the **machine-checked proof** and the **closed-form
L2 lemma** (a real, small theorem). Math is not patentable → **arXiv is the vehicle.** Honest
scope: L1 proven only for *normal* A; L4 is an engineered hypothesis; **safety ≠ capability.**

### 4.7 CSF (convergence-fitted format)

**What it is.** unisona.ai's one lossless binary container — deterministic best-fit codec
selection + built-in integrity (per-file SHA-256 + footer CRC) — on a balanced-ternary lattice
substrate.

**How it works** ([implemented] — [CSF-FORMAT-SPECIFICATION.md](CSF-FORMAT-SPECIFICATION.md), [`src/csf/csf_pack.py`](../src/csf/csf_pack.py); lattice substrate [`src/csf/v07/`](../src/csf/v07/)): try candidate codecs (zlib/bz2/lzma/zstd/brotli), keep the smallest, round-trip-verify lossless; the v07 lattice stores a cell as a 12-vector of qutrit states with a minimal observer-collapsed **wavefront/dust** read path.

**Loop stage:** Remember.

**Novelty claim (honest — LOW).** Multi-codec best-fit is a *known* technique; base-3/ternary
substrates are published; the repo's own falsification retired the sparsity-equivalence claim.
**The value is the format *identity* (a coined name worth a trademark), the integrity guarantees,
and the reproducible benchmark — not a compression algorithm.** Defensive publication + the CSF
trademark are the right (and only sensible) vehicles.

**Prior-art record (2026-07-22).** A live patent search confirms this grade with named prior
art for *every* CSF technique (best-fit selection US8111704/US6804238/US5953503; seed/regeneration
US20040267773/US11967975; byte-shuffle = HDF5/Blosc open standard; BCJ = xz standard; framed
random-access US20120109909/US9503123 + the zstd seekable format) — and finds **freedom-to-operate
is clean** (the blocking-looking patents are packet-header-specific or term-expired). Full review +
citations: [`research/2026-07-22-csf-patent-prior-art.md`](research/2026-07-22-csf-patent-prior-art.md).
It supplies the §7 prior-art record CSF needs before any (defensive) publication.

---

## 5. How each spec maps to the loop

```
      Observe ─► Remember ─► Reason ─► Act ─► Verify ─► Converge
                    CSF[4.7]  (adaptive  Account- Decode/  Grounding-econ[4.3]
                              depth —    ability  verify   Verified-gate[4.5]
                              folded)    layer    ctrl[4.2] Σ₀ cert[4.6]
                                         [4.1]    Conv-IO   Account. receipts[4.1]
                                         Conv-IO  [4.4]
                                         [4.4]
```

Every retained spec strengthens exactly one loop stage — the North Star feature gate. The moat
(#1) spans Act→Converge because accountability *is* the through-line of the loop.

---

## 6. Pre-publication filing gate (patent opt-out path)

Defensive publication is the default. If any item is worth **exclusivity instead**, it must
leave the publication path and be filed first: (1) pull it from this article and every public
surface; (2) file a US provisional (~$60–130 micro-entity); (3) *only then* mark "patent
pending" and publish.

**Highest opt-out candidates** (least prior-art-encumbered, working code):
- **§4.2 the decode/verify *controller*** (not the de-anchor step — that's published prior art).
- **§4.4 dilation-field-as-grounding-budget** (the one Convergence-IO primitive with method potential).
- Any **SCAMPER candidate** flagged `opt-out` in the **private ideation set** (held OFF this
  public repo) — currently **C1** (epistemic provenance attestation) and **C2** (VOI-priced
  grounding auction). Kept unpublished for exactly this reason; file a provisional before any
  public mention.

> **Decision required before this article goes public:** confirm none of §4 (or a promoted
> SCAMPER candidate) is an opt-out. Publishing forecloses patents on everything it contains.

---

## 7. Honest scope & what is *not* claimed

- This is an **engineering + IP-strategy** document, not legal advice. Cost figures are
  planning-grade. A trademark clearance search and an attorney prior-art review precede any filing.
- **No patent is filed or pending.**
- unisona.ai is **assembly, not invention** (§2). No fundamental algorithm is claimed — the
  defensible value is the **accountability layer + compounding owned data**, two novel *systems*
  primitives (decode/verify controller, dilation-budget), and rigorous *formalizations* (the
  collapse cert). Everything with high prior-art exposure (§4.6 non-normal case, §4.7, folded
  convergence-exit) is routed to defensive publication, not patent — and the repo's own
  falsifications are cited, not hidden.
- Publication secures freedom-to-operate, priority, and authorship — it does **not** by itself
  create licensing revenue.

---

## Sources (verified on disk 2026-07-18)

- Accountability layer — [`lib/coding-backend/index.js`](../apps/lantern-garage/lib/coding-backend/index.js) · [`routes/coding.js`](../apps/lantern-garage/routes/coding.js) · [`lib/council-review.js`](../apps/lantern-garage/lib/council-review.js) · [`lib/pr-watcher.js`](../apps/lantern-garage/lib/pr-watcher.js) · [OSS-BASELINE.md](OSS-BASELINE.md)
- Decode/verify controller — [`src/sigma0/decode_canary.py`](../src/sigma0/decode_canary.py) · [`experiments/deanchored_verifier.py`](../experiments/deanchored_verifier.py)
- Grounding economy — [`lib/grounding-calibration.js`](../apps/lantern-garage/lib/grounding-calibration.js) · [SIGMA0-GROUNDING-LEDGER.md](SIGMA0-GROUNDING-LEDGER.md)
- Convergence-IO — [`src/convergence_io/`](../src/convergence_io/) · [`docs/convergence-io/README.md`](convergence-io/README.md)
- Verified-gated self-improvement — [SIGMA0-CONTINUAL-TRAINING.md](SIGMA0-CONTINUAL-TRAINING.md) · [`lib/convergence-records.js`](../apps/lantern-garage/lib/convergence-records.js) · [`scripts/session_to_convergence.py`](../scripts/session_to_convergence.py)
- Collapse certificate — [SIGMA0-COLLAPSE-CERTIFICATE.md](SIGMA0-COLLAPSE-CERTIFICATE.md) · [SIGMA0-L2-ANISOTROPY-LIFT-PROOF.md](SIGMA0-L2-ANISOTROPY-LIFT-PROOF.md)
- CSF — [CSF-FORMAT-SPECIFICATION.md](CSF-FORMAT-SPECIFICATION.md) · [`src/csf/csf_pack.py`](../src/csf/csf_pack.py) · [`src/csf/v07/`](../src/csf/v07/)
- North Star — [CONVERGANCE-SIGMA0-BRIEFING.md](CONVERGANCE-SIGMA0-BRIEFING.md)
- Invention candidates (unpublished, held OFF this public repo) — private ideation doc (§6)
