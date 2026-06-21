---
author: Alex Place
created: 2026-06-02
updated: 2026-06-20
---

# CSF Format Specification (canonical, consolidated)

**CSF** = Convergence-Fitted Searchable Format — Keystone OS's binary container
family for memory, symbolic data, and (as of v0.8) **arbitrary files**.

This is the single canonical spec. It consolidates the previously-scattered CSF
documentation (whitepaper, backend notes, CADD, code docstrings).

> **v2 consolidation (2026-06).** CSF is now **one lossless, zstd-backed format**.
> The duplicate/legacy *writers* were deleted so they can't be called by mistake:
> the segmented `CsfArchive` v1 (+ `header/dictionary/sparse/search.py` and the
> `csf_compress/decompress/merge/search` CLIs), the root `csf_file.py` v0.3
> symbolic writer, and the lossy v0.7 symbolic *text* compressors
> (`csf_symbolic_compressor`, the `ClassicalCompressor` class). The public API is
> the package root [`csf/__init__.py`](../src/csf/__init__.py) over the engine
> [`csf/csf_pack.py`](../src/csf/csf_pack.py). Existing on-disk archives still open
> **read-only** via [`csf/legacy.py`](../src/csf/legacy.py). The 3¹² lattice
> primitives (`csf/v07/quantum_dust.py`, `qutrit_delta.py`) and the Status-Cube
> binary container (`csf/v07/csf_file.py`) are **kept** — CSF stores a point on
> that lattice; it is not the lattice (see §6).

> **Lattice view (singularity).** The symbolic v0.7 engine (`src/csf/v07/`) is the
> **storage face** of the `3**12` balanced-ternary Convergence Lattice — the same object the
> Converged Tesseract moves across. See [`TESSERACT-CSF-SINGULARITY.md`](TESSERACT-CSF-SINGULARITY.md)
> for the consolidation; §6 below is the short bridge.

---

## 1. Version lineage

| Version | Magic | Status | Reference code |
|---|---|---|---|
| **v0.8 — CSF-Pack (canonical)** | `CSF\0` | **Active. The one format.** Lossless arbitrary-file/blob container; zstd-19+LDM default | [`csf/csf_pack.py`](../src/csf/csf_pack.py) · API [`csf/__init__.py`](../src/csf/__init__.py) |
| v0.3 symbolic | `CSF\0` | **Removed (writer)** — read-only via `csf.legacy` | _retired_ |
| v1 segmented | `CSFv1\0\0\0` | **Removed (writer + CLIs)** — read-only via `csf.legacy` | _retired_ |
| v0.7 symbolic *text* compressors | — | **Removed** (lossy, non-invertible) | _retired_ |
| v0.7 lattice primitives | — | **Kept** — Tesseract storage face (§6) | [`csf/v07/`](../src/csf/v07/) |

> **Use the canonical core for everything.** `import csf; csf.pack(...)` /
> `csf.compress(...)`. The removed symbolic "compressors" were lossy and had no
> decoder — never a real format. Legacy on-disk archives open read-only through
> [`csf.legacy`](../src/csf/legacy.py).

---

## 2. CSF-Pack (v0.8) — arbitrary-file container

### 2.1 Binary layout

```
[Magic        4 bytes : b"CSF\x00"]
[Version      2 bytes : major, minor = 0, 8]
[Flags        2 bytes : bit0 = blobs zlib-compressed]
[ManifestLen  4 bytes : uint32 BE]
[Manifest     N bytes : UTF-8 JSON]
[Blob region  M bytes : concatenated (optionally compressed) file bytes]
[Footer      40 bytes : sha256(all preceding bytes) (32) + total size uint64 BE (8)]
```

### 2.2 Manifest JSON

```json
{
  "format": "csf-pack", "version": "0.8", "created_at": 1750000000.0,
  "compressed": true, "file_count": 3,
  "files": [
    {"path": "src/a.txt", "size": 1050, "csize": 60,
     "sha256": "…", "offset": 0, "compressed": true}
  ]
}
```
- `path` — POSIX-relative arc path (directory structure preserved on unpack).
- `size`/`csize` — original / stored byte length; `offset` is relative to the blob region.
- `sha256` — digest of the **original** bytes; verified on unpack.

### 2.3 Integrity & safety
- **Footer digest** (sha256 of everything before the footer) is verified *before*
  the manifest is parsed — any tampering fails with a clean integrity error.
- **Per-file sha256** is verified on extraction.
- **Path traversal** (`..`, absolute paths) is rejected on unpack (`_safe_join`).

### 2.4 API

```python
import csf

# archive (files or in-memory blobs); per-file SHA-256 + footer integrity
csf.pack(["mydir", "file.bin"], "out.csf")          # default codec = zstd-19+LDM
csf.pack(["mydir"], "out.csf", codec="zstd", use_dict=True)  # shared dict, keeps random access
csf.list_archive("out.csf")                          # manifest (no extract)
csf.unpack("out.csf", "dest_dir")                    # -> [written paths]
data = csf.read_file("out.csf", "file.bin")          # verified single member

# lightweight single-blob stream (1-byte codec header, no manifest)
blob = csf.compress(b"...")                           # -> bytes
raw  = csf.decompress(blob)
```

Codec is per-file and self-describing (`zstd` | `zlib` | `store` | `omni`); a missing
codec reads as `zlib`, so pre-codec archives still extract byte-for-byte. The opt-in
**`omni`** codec is the best-fit / max-ratio tier (see §2.7.1).

### 2.5 CLI

```bash
python -m csf.csf_pack pack <paths...> -o out.csf [--no-compress]
python -m csf.csf_pack unpack out.csf -d <dest_dir>
python -m csf.csf_pack list out.csf
```

Tests: [`tests/test_csf_pack.py`](../tests/test_csf_pack.py) (round-trip ×2,
list, tamper-detection, traversal).

### 2.6 App routes

Wired into the server alongside the legacy tesseract pack ([`routes/csf.js`](../apps/lantern-garage/routes/csf.js)):

```
POST /api/csf/pack    { paths: ["docs","README.md"], out: "data/exports/bundle.csf", compress?: true }
POST /api/csf/unpack  { archive: "data/exports/bundle.csf", dest: "data/exports/out" }
```
Both constrain paths to within `repoRoot` (no traversal) on top of the module's own guards.

### 2.7 Benchmark — does it work better?

`python scripts/csf_pack_benchmark.py` on 316 real repo files (2.8 MB):

| Format | Size | Ratio | Integrity / safety |
|---|---|---|---|
| **CSF-Pack v0.8** | 1.0 MB | 2.73× | **SHA-256 per file + whole-archive footer digest + path-traversal guard** |
| zip (DEFLATE-9) | 1.0 MB | 2.76× | CRC-32 only; no crypto hash; no path guard |
| tar.gz | 888 KB | 3.22× | no per-file checksum |
| legacy symbolic CSF | — | — | **cannot store arbitrary files** (255 B/record payload cap) |

**Verdict (honest):** CSF-Pack is **size-competitive with zip (within ~1%)** and **strictly safer** —
cryptographic per-file + whole-archive integrity and path-traversal protection that zip/tar don't
provide by default. `tar.gz` compresses better (solid stream) but offers no per-file integrity.
Against the **legacy symbolic CSF it's a categorical upgrade** — that format can't hold arbitrary
file bytes at all. Use CSF-Pack when integrity + safety matter; it's the format for general bundling.

### 2.7.1 CSF-Omni — the opt-in best-fit codec

The table above is the *archive-vs-zip* picture (text+code, ~30% spread). On the **append-only memory
log** the codec choice dominates. CSF already ships **zstd-19 + LDM** by default, which compresses a 4 MB
JSONL memory log **362×** (vs zlib's 14× before #835). **CSF-Omni** ([`src/csf/omni.py`](../src/csf/omni.py))
is a new opt-in codec (`codec="omni"`) that goes one better: it runs the whole panel per blob
(store · zlib · bz2 · lzma · zstd · brotli + a byte transform), **round-trip-verifies each**, and keeps
the smallest behind a 7-byte self-describing, CRC-checked header — deterministically (same input → same bytes).

Measured against the shipped zstd-19, every codec round-trip-verified lossless
([`experiments/csf_compression_benchmark.py`](../experiments/csf_compression_benchmark.py); full write-up:
[**CSF Compression Benchmark — Review v3 (PDF)**](/reports/csf-compression-benchmark.pdf)):

| Corpus (raw) | zstd-19 (ships) | brotli-11 | **CSF-Omni** | Omni vs zstd |
|---|---|---|---|---|
| text + code (3.07 MB) | 4.11× | 4.23× | **4.23×** | +2.8% |
| **JSONL memory log (4.0 MB)** | 362.6× | 422.1× | **421.8×** | **+16.3%** |
| cube delta stream (25 KB) | 16.0× | 17.15× | **17.07×** | +6.5% |

CSF-Omni **beats every other codec** (zlib/zstd/lzma/bz2) on every single stream and is the only
configuration that is best-or-tied everywhere. On the **multi-file archive** the picture is narrower:
`codec="omni"` reaches **3.06×** on the 340-file corpus, but master's existing **`zstd` + shared
dictionary** (`use_dict=True`) already reaches **3.00×** — so omni's archive edge is only **+2 %**, at
~7× the encode cost (omni ~31 s vs zstd+dict ~4 s vs plain zstd ~1 s). The dictionary recovers the
cross-file redundancy that per-file omni cannot, so **omni's durable win is on single streams**, not archives.

**Honest framing (Σ₀).** CSF-Omni is the *upper envelope*, not a new entropy coder: on these corpora
brotli is the frontier, so Omni *matches* it (payload-identical, +7-byte header) — it does **not** beat
brotli's raw bytes, and no library available here (PPMd, paq) does. Its value is guaranteed best-in-field
selection on any input **plus** integrity (the CRC catches corruption that zstd's default frame returns
silently) and a portable stdlib-only mode. Trade-off: the panel sweep makes the omni archiver ~31 s for
340 files, so **zstd stays the default** (hot paths) and omni is the opt-in max-ratio tier for
cold/archival single-stream blobs; decode is fast.

**Adversarially verified.** A six-agent fleet stress-tested it (fuzz round-trip — 3,817 checks · envelope ·
backward-compat · code review · decode-safety · honesty audit). Two defects were found and fixed: a corrupt
brotli payload could decode to silently-wrong bytes (→ CRC-32 + a `ValueError` decode contract), and a
docstring over-claim (→ reworded to the envelope framing above). CSF tests pass.

---

## 2.8 Per-user profile pack (one file per user, KB-grounded)

`src/csf/profile_pack.py` compacts **all of one user's CSF data into a single
file** — `data/profiles/<user>.csf` (CSF-Pack v0.8) — and grounds it in the base
Knowledge Center.

Archive contents:
- `user/…` — the user's cube (`data/cubes/<user>.private`), deltas, indexes,
  dreamer notebooks, `csf_memory`, profile json.
- `knowledge/index.jsonl` — the **embedded base KB grounding index** (so the file
  is self-contained *and* grounded), plus its `.meta.json`.
- `_profile.json` — sources, user file count, and the grounding reference (KB sha256 + section count).

```bash
python -m csf.profile_pack pack <user>            # -> data/profiles/<user>.csf
python -m csf.profile_pack info  <archive>        # embedded _profile.json
python -m csf.profile_pack unpack <archive> -d <dest>
```
Routes: `POST /api/csf/profile/pack {user}` · `GET /api/csf/profile/info?user=<id>`.
User profile archives are **gitignored** (user data — privacy). Tests:
[`tests/test_csf_profile.py`](../tests/test_csf_profile.py).

## 2.9 Base Knowledge Center grounding + cheaper routing

- **KB index** — `scripts/build_knowledge_index.py` turns the Knowledge Center
  source docs into `data/knowledge/index.jsonl` (one record per doc *section* with
  heading path + snippet). This is the base grounding corpus for "better LLM grounding."
- **Cheaper deterministic / near routing** —
  [`lib/knowledge-router.js`](../apps/lantern-garage/lib/knowledge-router.js)
  answers from the KB index **before** paying for an LLM:
  1. **deterministic** — exact heading match → that section verbatim ($0)
  2. **near** — TF-IDF nearest section above threshold → grounded answer ($0)
  3. **miss** — caller falls through to the provider chain
  Route: `GET|POST /api/knowledge/query { q }` → `{ tier, hit, source, text, score }`.

Rebuild the KB index after editing core docs: `python scripts/build_knowledge_index.py`.

---

## 3. Retired formats & the read-only bridge

The v2 consolidation removed every legacy *writer*. Nothing in the codebase
produces these formats anymore; existing archives open **read-only** through
[`csf.legacy`](../src/csf/legacy.py).

| Retired format | Was | Why removed | Reading it now |
|---|---|---|---|
| v0.3 symbolic (`csf_file.py`) | `CSF\0` baseline+dict+delta writer | superseded by the lossless core | `csf.legacy` (no on-disk files existed) |
| v1 segmented (`header.py` + `dictionary/sparse/search.py` + 4 CLIs) | `CSFv1\0\0\0` segment container | duplicate archive format | `csf.legacy` (no on-disk files existed) |
| v0.7 symbolic text (`csf_symbolic_compressor`, `ClassicalCompressor`) | lossy "ratio" projection | **lossy + no decoder** — never reversible | n/a (was never a real archive) |
| raw DEFLATE blobs (dream-journal previews, `archive-commons/*.csf`) | bare zlib streams | — (kept) | `csf.legacy.decode_bytes` (inflate) |

`csf.legacy.open(path)` sniffs and dispatches: modern `CSF\0` → core; zlib blob
→ inflate; anything else → `CsfLegacyError`.

### 3.1 Still-live v0.7 lattice (`v07/`) — kept
`quantum_dust`, `qutrit_delta`, `convergence_engine`, plus the binary container
`csf_file.py` (used by the Status-Cube store) and the lossless primitives in
`classical_compressor.py` (`SymbolicDictionary`, sparse CSR). These are the
**storage face of the 3¹² lattice** (§6), not a compression format.

---

## 4. Code map

| Path | Role |
|---|---|
| `src/csf/__init__.py` | **Canonical public API** (facade over the engine) |
| `src/csf/csf_pack.py` | **The format engine** — pack/unpack/read_file + codec layer |
| `src/csf/legacy.py` | **Read-only** decoders for retired/legacy on-disk archives |
| `src/csf/profile_pack.py` | per-user profile archive (over the core) |
| `src/csf/v07/` | 3¹² lattice primitives (Tesseract storage face) + Status-Cube container |
| `src/csf/status_cube.py` | StatusCube (player ImagniVerse) |
| `src/csf/memory_engine.py` | memory archive over CSF |
| `caad/README.md` | CADD (Context Archive for Dream Data) — built on CSF |

---

## 5. Consolidation pointers (previously scattered)
- `docs/CSF-Whitepaper-v0.3.pdf` — original whitepaper
- `docs/PHASE-1-CSF-BACKEND.md` — backend phase notes
- `caad/README.md`, `caad/dollhouse-csf-upgrade.md` — CADD layer
- `CSF-IMAGE-TRAINING.md` — image-LoRA training over CSF
- `csf/ingest/` — CSF *ingest* docs are the memory/task queue, **not** format specs

This spec is the authoritative format reference; the above remain for history.

---

## 6. The 3¹² lattice (storage face of the singularity)

The v0.7 symbolic engine is not a standalone compressor — it is the **storage face** of a
single `3**12 = 531,441`-cell **balanced-ternary lattice** that the project also reasons over
geometrically (the "Tesseract"). The two are one object; the full argument and grounding live
in [`TESSERACT-CSF-SINGULARITY.md`](TESSERACT-CSF-SINGULARITY.md). Bridge facts:

| Spec concept | Lattice role | Code |
|---|---|---|
| `NUM_DIMENSIONS = 12`, `TOTAL_POSITIONS = 3 ** 12` | 12 ternary axes (one per Convergence-12 component) | [`qutrit_delta.py`](../src/csf/v07/qutrit_delta.py) |
| `QutritState` (amp 0-7, phase 0-7) + `QutritDelta` (2 B) | a lattice cell + its signed change | [`qutrit_delta.py`](../src/csf/v07/qutrit_delta.py) |
| `QuantumDustField` baseline + active deltas + dust | a stored point; most cells implicit ("dust") | [`quantum_dust.py`](../src/csf/v07/quantum_dust.py) |
| observer-collapsed wavefront | the **motion face** (Tesseract) reads the same field | [`converged_tesseract.py`](../src/converged_tesseract.py) |

**Why base-3, not base-2:** ternary is the most economical integer radix (optimum is `e`,
nearest integer 3), and balanced ternary `{-1,0,+1}` gives symmetric arithmetic — the same
substrate as BitNet b1.58's ternary weights ([arXiv:2402.17764](https://arxiv.org/abs/2402.17764)).
The "no change is free" dust optimisation is the storage-side twin of BitNet's ~66 % zero-weight
sparsity. Citations and falsifiable experiments: see the singularity doc §5–6.
