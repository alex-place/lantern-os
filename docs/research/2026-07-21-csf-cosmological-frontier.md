# CSF at cosmological scale — the honest frontier map (observer slices, generative members, and the Library of Congress)

**Date:** 2026-07-21
**Type:** Vision → frontier translation. Takes the ask — *"a CSF store containing an observer
slice of the tesseract of the multiverse… compressed with novel higher-dimensional tesseract
compression… compress every PDF in the Library of Congress"* — and maps it onto what the
mathematics permits, what shipped **today**, and what the gated research ladder is.
**Status:** F1 (generative members) **shipped** in this PR; F1b–F3 are gated research rows.
**Loop stage:** Remember (cold storage tiers).

**Grounding contract — External Reality Rule.** Tags as usual. Metaphor is labeled metaphor.
**Reads first:** [`2026-06-28-csf-tesseract-novelty-and-e1-kill.md`](2026-06-28-csf-tesseract-novelty-and-e1-kill.md) ·
[`2026-07-21-tesseract-application-map.md`](2026-07-21-tesseract-application-map.md) §5 ·
[`../CSF-FORMAT-SPECIFICATION.md`](../CSF-FORMAT-SPECIFICATION.md) §2.2.1–2.2.2

---

## 0. What stays dead — restated once, then built around

**"Novel higher-dimensional tesseract compression" as a codec is permanently closed.** The
Shannon/Kolmogorov counting bound is scale-invariant: geometric re-arrangement of bytes buys
zero entropy at 4 MB and zero at 21 PB, and the repo killed its own version of this claim with
run experiments (E1/E2, 2026-06-28). Nothing below reopens it.

What the vision's words CAN honestly mean — and this is where the frontier really is:
1. **"Contain the universe"** = store the *description* (laws + seed), materialize *observer
   slices* on demand, verify each materialization against a recorded hash. Description-length,
   not entropy-defeating: lawful data was never random.
2. **"Tesseract observer slice"** = the wavefront pattern (materialize only what is observed)
   applied to a generatively-defined space — the one part of the old tesseract design that was
   always sound engineering.
3. **"Every PDF in the Library of Congress"** = corpus-scale tiering where dedup and
   **amortized** shared-model coding become honest — the exact regime where the E1 kill's
   model-accounting objection mathematically dissolves.

---

## 1. Defining a frontier (the specifics)

A compression frontier is a **Pareto surface**, not a number. CSF's axes:

| Axis | Values |
|---|---|
| Fidelity class | lossless · error-bounded (ε-guaranteed) · **generative** (exact by recomputation) |
| Ratio | measured, per corpus class |
| Access granularity | per-member random access · whole-stream (solid) · slice-of-generator |
| Amortization base | none · per-archive dict · corpus-shared model |
| Throughput | hot path · cold pack · glacial (recompute/neural) |

**Enhancing the frontier** = moving one measured point outward under a pre-stated kill
criterion, without regressing another axis silently. **CSF's measured frontier today:**

| Tier | Technique | Measured |
|---|---|---|
| Hot | zstd-19 + LDM (default) | baseline; random access |
| Warm | CSF-Col v2 (shape-keyed transform, omni-selected) | **+5.2–5.8%** on real ledgers |
| Cold | **solid** (one stream) | **+18.4–30.8%** over per-file |
| Cold-max | solid + omni | **+6.4–9.3%** more |
| Generative | **generative members** (shipped today) | 16 MiB lawful stream in a **<4 KB** archive (~4,300×; description-length class) |
| External check | AITDCC-2026 grading | 📋 pending (application map Q2) |

---

## 2. The observer-slice universe, honestly (F1 — seed shipped)

**Shipped today [implemented]:** *generative members* (spec §2.2.2, format v0.9). An archive
entry stores a tiny JSON generator spec instead of bytes; readers **materialize** the member
deterministically and **verify against its recorded sha256**. Closed registry only — `zeros`,
`repeat`, `sha256-ctr` (counter-mode SHA-256 DRBG: stdlib-pure, deterministic forever) — no
eval, no user code, 1 GiB materialization guard. Measured: a 16 MiB lawful stream + siblings
in a **3.5 KB** archive, tamper-flip of the seed detected by hash.

This is the *entire honest core* of "the archive contains an observer slice of a generated
universe": **observation = verified materialization of a slice of a lawful process.** The
archive holds the laws + seed; the bytes exist when observed; the hash pins the observation.
("Multiverse" reading, labeled metaphor: each seed is one universe of the family; the registry
is the physics; none of this is physics.)

**The ladder up [design — falsifiable]:**
- **F1b — slice-addressable generators.** `read_slice(member, offset, len)` without full
  materialization — `sha256-ctr` is already block-random-access; per-slice Merkle hashes make
  *partial* observations verifiable. This is the wavefront made real: observe a window of a
  universe-sized stream at O(window) cost. Kill: slice reads must not regress whole-read
  throughput or integrity coverage.
- **F1c — registered scientific generators.** The cosmology community already lives this way:
  simulations emit **terabytes per timestep**, and the field's answer is seeds + parameters +
  **error-bounded recompression** (SZ3 ~**300×** on cosmology fields, newer methods to
  ~**3,000×** with bounded error — [ACM survey](https://dl.acm.org/doi/10.1145/3733104) ·
  [arXiv:2503.20031](https://arxiv.org/pdf/2503.20031) ·
  [GPU cosmology compression, arXiv:2004.00224](https://arxiv.org/pdf/2004.00224)). A
  registered `nbody-emulator` generator kind (spec + seed + version-pinned code hash) would
  put "a universe run, beginning to end" in a CSF store *as its recipe*, with observer slices
  as verified snapshots. Kill: a registered generator whose regeneration drifts across
  versions is removed — determinism is the contract.

---

## 3. The Library of Congress program (F2–F3)

**Scale, verified:** the Library manages **21 PB of digital collections across 914 million
files** (2022; [LoC digital collections FAQ](https://www.loc.gov/programs/digital-collections-management/about-this-program/frequently-asked-questions/)),
within a catalog of ~170M items.

- **F2 — corpus-scale dedup tier [design].** Content-defined chunking before the coder:
  FastCDC-class chunkers run **3–10× faster** than classic CDC at equal-or-better dedup
  ([USENIX ATC'16](https://www.usenix.org/system/files/conference/atc16/atc16-paper-xia.pdf)).
  Digitized-scan corpora carry massive cross-file redundancy (re-scans, editions, embedded
  fonts, shared plates) that per-file *and* solid modes both miss beyond one archive. Kill:
  measured chunk-store ratio on a real multi-GB PDF corpus must beat solid+omni by ≥10% at
  acceptable index overhead, or the tier stays unbuilt.
- **F3 — amortized neural cold tier [design; the E1 verdict flips].** E1 killed
  model-as-compressor at 4 MB because the 2.87 GB model dwarfed the data. The canon's own
  threshold ([arXiv:2601.02875](https://arxiv.org/html/2601.02875v1)): LM coding pays past
  **~100 GB**. At LoC scale a 10 GB shared model is **0.00005%** overhead — the DeepMind
  class ([arXiv:2309.10668](https://arxiv.org/abs/2309.10668)) becomes honest arithmetic.
  Kill (pre-stated, K4 pattern): on a ≥100 GB held corpus, model+coder must beat solid+omni
  **including model bytes** at a decode throughput a cold tier can live with — else it stays
  research-front. This is the same claim E1 tested, at the scale where the math says it can
  finally win; nothing about the kill is relitigated below its threshold.

---

## 4. Corpus gap (checked, as asked)

The local arXiv corpus (`arxiv_query.js`; AI/ML abstracts 2025-07+, control-eng +
survivorship tranches) has **no compression tranche** — only two adjacent hits
(diffusion-based lossless transmission [arXiv:2606.06273](https://arxiv.org/abs/2606.06273);
information-theoretic tokenization [arXiv:2512.16975](https://arxiv.org/abs/2512.16975)).
**Action row:** harvest a `cs.IT`/compression tranche via `scripts/arxiv_harvest.py` so the
next frontier pass grounds locally; until then AITDCC-2026 (Q2) remains the external
instrument.

## 5. Falsification table

| # | Claim | Kill |
|---|---|---|
| F1b | Slice-addressable generative reads are O(window) with verifiable partial integrity | slice path regresses whole-read throughput or leaves slices unverifiable |
| F1c | A version-pinned scientific generator regenerates byte-identically | any cross-version drift → kind removed |
| F2 | CDC chunk-store beats solid+omni ≥10% on a real PDF corpus | it doesn't, at acceptable index overhead |
| F3 | Amortized model+coder beats solid+omni **including model bytes** at ≥100 GB | it doesn't, or decode throughput is unusable |

## 6. Honest scope

- No entropy claims: generative members are **description-length** wins on recipe-bearing
  data; F3 is amortization arithmetic, not new coding theory.
- "Universe/multiverse/tesseract" are labeled metaphors over one shipped mechanism:
  deterministic generators + verified materialization + (next) sliced observation.
- All tiers are opt-in extensions of the one canonical module (no new subsystem); LoC-scale
  is an ambition benchmark for F2/F3, not a roadmap commitment.
