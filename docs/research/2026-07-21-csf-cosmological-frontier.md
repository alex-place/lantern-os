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

## 2.5 The organizational reading of the geometry (the steelman, adopted)

The tesseract/qutrit design's durable value — stated by the project owner and adopted here —
is **organizational, not entropic**: *restructure data so compression and dedup can act.* This
is the half of the old geometry that every measurement this session vindicated, and it splits
cleanly:

- **The dust principle is the real inheritance.** The lattice's deep idea was never base-3 —
  it is *"absence is free: store a baseline, pay only for deviations."* That principle,
  extracted from the geometry, is what Col v2 does across fields (+5.2–5.8%), what solid mode
  does across files (+18.4–30.8%), what generative members do in the limit (a lawful stream is
  one large duplicate of its recipe, 16 MiB → 3.5 KB), and what F2's chunk store does at
  corpus scale (canonical chunk + references = baseline + dust). RKD (#1594) is the same body
  in delta clothing.
- **The trit types *state*, not *storage*.** `{-1, 0, +1}` is the natural type for what the
  system tracks — refuted/unknown/confirmed; superseded/baseline/novel — and makes a clean
  lifecycle vocabulary for a chunk store (retired / dust-reference / live delta). Measured
  fact: a 3-symbol column costs the entropy stage ≤ log₂3 bits automatically, so this elegance
  is free — and worth exactly zero extra compressed bytes. Use the trit because it is the
  right type; never expect it to compress.
- **Where base-3 pays in bytes it is already registered elsewhere:** trit-packing for the
  ternary serving artifact (application map Q1) and PAM-3 signaling — regimes with no entropy
  coder in the path. Inside an archive, hand-rolled ternary arrangement measurably adds
  nothing (base3_cyclic lost to delta+zstd; re-verified this cycle).

One line: **the geometry earns its keep as a discipline — baseline-plus-deviation,
observe-only-the-slice, three-state lifecycle — and the discipline now has measured hardware
under it; base-3 is the notation, not the mechanism.**

**Companion question, graded (owner, 2026-07-21): "use the infinite values between 0–2 as
space to shrink bytes."** The pure form dies on distinguishability: storage holds states, not
reals — n bits of precision distinguish exactly 2ⁿ points of any interval (precision *is*
bytes), and analog level-packing is taxed by noise (Shannon–Hartley; why PAM-3 stops at 3
levels and flash at ~16). But the rigorous form of the intuition **is arithmetic coding** —
the whole message as one point in an interval, narrowed per-symbol by probability, code length
= −log₂P = the Shannon optimum — which is exactly the FSE/ANS/range-coder stage inside every
CSF backend codec. The continuum is load-bearing three ways here already: as probability space
(shipped in every codec), as precision-priced floats (F1c error-bounded tier: bits ∝
log(range/ε)), and as the home of the surviving field/budget instruments (lapse, dilation,
water-filling). Verdict: not a new lever — the **mechanism of the existing floor**, which is
precisely why nothing hand-rolled beats that floor.

## 2.6 The optimum number of levels — why the wire stopped at 3 and the cell at 16 (researched)

One law governs both, and it is the physical twin of the archive's entropy floor:
**distinguishable levels are linear in the physical budget, information is logarithmic in the
levels, and the cost of one more bit is exponential.** With window W and *lifetime* noise σ
(jitter over a symbol on a wire; ten years of charge leakage in a cell), usable levels are
M ≈ 1 + W/(kσ), bits = log₂M — and holding one more bit means doubling W or halving σ.

**The wire (GDDR7 = PAM-3, verified):** eye height shrinks as 1/(M−1) ⇒ required SNR grows
~6 dB per halving. NRZ baseline; **PAM-3: −6.0 dB for 1.5 bits/symbol** (2 symbols = 9 states
≥ 8 ⇒ 3 bits/2 clocks, 94% packing); PAM-4: **−9.5 dB** for 2 bits
([ProLabs](https://www.prolabs.com/understanding-nrz-vs-pam4-modulation-techniques) ·
[Samtec](https://blog.samtec.com/post/understanding-nrz-and-pam4-signaling/) ·
[I-PEX](https://www.i-pex.com/library/article/what-is-pam)); PAM-300 would need ≈ −49.5 dB —
categorically beyond a 24 Gbaud single-ended memory channel's capacity (Shannon–Hartley:
usable bits/symbol = log₂(1+SNR) ≈ 1.5 here). Best margin-per-bit at speed picked 3
([Micron](https://www.micron.com/about/blog/memory/dram/unveiling-the-next-generation-of-graphics-memory-gddr7) ·
[Rambus](https://www.rambus.com/blogs/all-you-need-to-know-about-gddr7/)). Under linear
cost-per-level the optimal radix is **e ≈ 2.718** (radix economy, in canon) — the fastest bus
on earth landed on its nearest integer.

**The cell (NAND ≤16 levels, verified):** fixed ~5–6 V window; σ_lifetime = years of leakage +
P/E oxide damage + disturb + temperature
([TechTarget](https://www.techtarget.com/searchstorage/definition/TLC-flash-triple-level-cell-flash) ·
[arXiv:1706.08642](https://arxiv.org/pdf/1706.08642)). Measured ladder: SLC 2 levels
~100k P/E → MLC 4 ~10k → TLC 8 ~3–10k (3D) → **QLC 16 ~150–1,000**
([Flexxon](https://www.flexxon.com/nand-flash-explained/) ·
[Lexar](https://lexarenterprise.com/comparing-nand-flash-slc-mlc-tlc-qlc-industrial-application/)).
Each added bit buys a shrinking capacity gain (+100% → +50% → +33% → +25%) at ~10× endurance
cost + heavier ECC — QLC is the economic knee. PLC (32 levels) has been in pilot since 2023
([IEEE](https://ieeexplore.ieee.org/document/10873308/) ·
[Kioxia/WD](https://blocksandfiles.com/2019/12/17/kioxia-twin-bics-plc-nand-flash-meanufacture/))
and the 2026 flagship push is **more layers, not more levels**
([Tom's Hardware](https://www.tomshardware.com/pc-components/ssds/kioxias-next-gen-3d-nand-production-gets-expedited-to-2026-report-claims-high-capacity-332-layer-bics10-devices-to-sate-growing-demand-from-ai-data-centers)) —
the market's revealed optimum: buying more cells beats buying more distinguishability per cell.

**Unified:** both maximize `value(log₂M) − cost(M)` with convex-to-exponential cost ⇒ optima
are tiny (2–4 on wires, 8–32 in cells). The levers that escape the law are exactly this doc's
ladder: **organization** (states you never spend — dedup, restructuring, dust) and
**amortization** (one generator/model shared across a corpus).

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
