# Beating zstd-19 in CSF — a grounded theorization

**Date:** 2026-06-29 · **Status:** design + external/internal grounding; no production claim yet.
**Loop stage:** Remember (memory encoding). **Tracking:** issues #1593 (CSF-Col), #1594 (RKD), #1595 (GRC), #1596 (hybrid).

This note records what can actually beat the shipping `zstd-19` / CSF-Omni stack on the project's real
data (append-only JSONL memory logs, agent-cache JSON), grounded in both the external compression
literature and the project's own research, including the Σ₀ collapse/entropy corpus.

## 0. The single lever

Compressed size ≈ the cross-entropy of your *model* of the data. `zstd-19`'s model is LZ77
match-finding (bounded window) + an FSE/Huffman entropy stage. The entropy stage is already
near-optimal — beating zstd means modeling structure or statistics that LZ cannot express. The lapse
field already measured the target: on the 1 MB JSONL memory log the per-symbol code length
`L(x) = −log₂ p(x|ctx)` averages **0.82 bits/byte with 70.4 % "horizon" cells (L < 1 bit)**
([`experiments/lapse_field_demo.py`](../../experiments/lapse_field_demo.py)). That 70 % is structural
redundancy waiting to be exposed.

The project has four assets a generic compressor lacks, and each technique weaponizes one:
**(1)** a rigid record schema (the four canonical objects), **(2)** a retrieval index over all prior
memory, **(3)** a resident grounded model, **(4)** the Σ₀ collapse instrumentation.

## 1. Technique 1 — schema-columnar transform, known schema (CSF-Col) · #1593

Reversible row→column transpose of JSONL records of the four canonical objects, then per-column typed
coding (epoch-delta+varint timestamps, dictionary for low-cardinality `source`/`agent`/`tool`, raw-FP for
`confidence`) → zstd/omni backend. **Lossless, CPU, hot-path-viable.** Beats zstd-19 *and* omni because
omni only swaps whole-blob entropy coders — neither reshapes records. **Novelty vs OpenZL/DataCortex:**
they infer schema at runtime; our records have a *known* schema, so the transform is cheaper and tighter.
External grounding: Meta **OpenZL** (2025, structure-aware reversible transforms beat zstd on ratio+speed),
**DataCortex** (2–3× over zstd on NDJSON). Internal: "sparsity+redundancy wins, low-rank fails"
([`sigma0_compressibility.py`](../../experiments/sigma0_compressibility.py)). **Prediction:** 1.5–2.5× over
zstd-19 on `data/csf_memory/*.jsonl`. **Build first.**

## 2. Technique 2 — retrieval-keyed lossless delta (RKD) · #1594

At compaction, find the nearest prior record via the memory retrieval index and store a *lossless*
structured delta against it (not semantic merge — fully reconstructable). zstd cannot reference a match
outside its window; retrieval can reach an arbitrarily distant base, so the delta is often near-empty.
The lossless, retrieval-indexed form of the Σ₀ "no-change is free / dust" observation. Index exists in
[`memory_engine.py`](../../src/csf/memory_engine.py) (unwired). **Constraint:** base record must be retained
and decompression deterministic.

## 3. Technique 3 — grounded residual coding with Σ₀-gated adaptive depth (GRC = corrected E1) · #1595

Use the **already-resident** model as the arithmetic-coding predictor for **cold** archives. Three moves:
(a) weight cost is **zero** because the model is already loaded for reasoning — the project-specific escape
from the "LLM compression only pays at TB scale" wall ([Revisiting Data Compression with LM, 2026](https://arxiv.org/html/2601.02875v1));
(b) feed it **retrieved grounding context** so the representation does not collapse; (c) use the **Σ₀
NIS/anisotropy canary as the per-token recurrence-depth exit**.

### The Σ₀ correction (load-bearing — this is what `?did you apply sigma0 research` surfaced)
"Deeper recurrence → fewer bits" is **false in the ungrounded regime.** Theorem 1
([`SIGMA0-COLLAPSE-CERTIFICATE.md`](../SIGMA0-COLLAPSE-CERTIFICATE.md), PROVEN for normal `A`, closed for
non-normal via the dichotomy) shows ungrounded contraction (spectral abscissa `α < 0`) decays the latent
trajectory onto a null manifold — rank vanishes, covariance goes isotropic (`a(Σ) → 0`), prediction-error
signal disappears, and the coder's predictions trend toward uniform `1/V`, i.e. **maximal** entropy. So past
the collapse threshold, more depth makes the coder *worse*. The STARS T=4 cliff is consistent with exactly
this transition (`cond_rank` / `a(Σ) < 5e-2` firing).

The same instrumentation that *constrains* GRC also *supplies its control signal*: the χ²-calibrated **NIS
canary** spikes at collapse onset, and anisotropy `a(Σ)` / abscissa `α` give a per-token "stop looping"
signal — a *measured* depth ceiling instead of a fixed `T`. This is the same exit gate as
[`2026-06-29-sigma0-nested-adaptive-reason.md`](2026-06-29-sigma0-nested-adaptive-reason.md). "Entropy" in
the Σ₀ corpus means covariance **anisotropy**, not Shannon code length — do not conflate them.

External: DeepMind ["Language Modeling Is Compression"](https://arxiv.org/abs/2309.10668) (3.2M transformer
beats LZMA2, 17.7 % vs 23 %); FineZip ~24 min/MB → **cold-only**. **Prediction:** beats brotli-11 on cold
archives **iff grounded**; ungrounded it underperforms zstd (proven). Honesty gates: report vs brotli-11 not
just zstd; instrument `a(Σ)`/NIS as the exit; stamp model id+version (recompress on model swap — tension with
"models are interchangeable").

## 4. Technique 4 — hybrid GRC over a CSF-Col residual · #1596

CSF-Col strips the ~70 % structural redundancy at zero compute; GRC drives only the high-`L` residual to the
entropy floor. No external work combines a *known-schema* structural transform with a *resident grounded*
predictor. Because most tokens never reach the model, this is also the **fastest** neural variant. Best
ceiling; build last (blocked by #1593, #1595).

## 5. Doors that stay closed (theorized and refuted/impractical)

- **Low-rank / SVD / PCA** — refuted: the log stays high-rank even in its optimal basis
  ([`sigma0_compressibility.py`](../../experiments/sigma0_compressibility.py)).
- **Kolmogorov / generator coding** — 6,666× on π, but real logs have no compact generator; the no-free-lunch
  offset result confirms it does not generalize ([`sigma0_pi_kolmogorov.py`](../../experiments/sigma0_pi_kolmogorov.py)).
- **Pure tesseract geometry** — the lapse-field metric is a measurement/routing tool (Fisher–Rao/Chentsov),
  not a codec; it adds zero bits on its own.
- **cmix / PAQ context mixing** — best-known text ratio, but ~1000× slower than zstd; not viable even cold.

## 6. Verdict

**Technique 1 (CSF-Col) is how you beat zstd-19 in production today.** Techniques 3/4 are the entropy-floor
ceiling, reachable only offline, only grounded, and only because the model is already resident — and the Σ₀
non-collapse certificate is what converts "is it safe to go deeper" from a guess into a measured boundary.
