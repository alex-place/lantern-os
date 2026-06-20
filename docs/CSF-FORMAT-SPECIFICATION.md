# CSF Format Specification (canonical, consolidated)

**CSF** = Convergence-Fitted Searchable Format — Lantern OS's binary container
family for memory, symbolic data, and (as of v0.8) **arbitrary files**.

This is the single canonical spec. It consolidates the previously-scattered CSF
documentation (whitepaper, backend notes, CADD, code docstrings) and supersedes
the dead `CSF-FORMAT-SPECIFICATION.md` reference that `header.py` and the
Knowledge Center pointed at.

> **Lattice view (singularity).** The symbolic v0.7 engine (`src/csf/v07/`) is the
> **storage face** of the `3**12` balanced-ternary Convergence Lattice — the same object the
> Converged Tesseract moves across. See [`TESSERACT-CSF-SINGULARITY.md`](TESSERACT-CSF-SINGULARITY.md)
> for the consolidation; §6 below is the short bridge.

---

## 1. Version lineage

| Version | Magic | Purpose | Reference code |
|---|---|---|---|
| **v0.3** | `CSF\0` | Symbolic memory: world-model anchors + delta stream + dictionary | [`src/csf/csf_file.py`](../src/csf/csf_file.py) |
| **v0.7** | — | Symbolic compression engine (quantum-dust, base-3, qutrit delta) | [`src/csf/v07/`](../src/csf/v07/) |
| **v1 (segmented)** | `CSFv1\0\0\0` | Segment-table container (index, converged, encrypted, streaming flags) | [`src/csf/header.py`](../src/csf/header.py) |
| **v0.8 — CSF-Pack** | `CSF\0` | **General-purpose archive: pack/unpack arbitrary files** | [`src/csf/csf_pack.py`](../src/csf/csf_pack.py) |

> The symbolic formats (v0.3 / v0.7) encode Lantern's memory model. **CSF-Pack
> (v0.8) is the new Σ₀ release for wrapping *any* bytes** — code, data, models,
> exports — with hashing, optional compression, and an integrity footer.

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
from csf import csf_pack
csf_pack.pack(["mydir", "file.bin"], "out.csf", compress=True)   # -> manifest
csf_pack.list_archive("out.csf")                                  # -> manifest (no extract)
csf_pack.unpack("out.csf", "dest_dir")                            # -> [written paths]
```

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

## 3. Legacy / symbolic formats (brief)

### 3.1 v0.3 symbolic (`csf_file.py`)
`[Magic CSF\0][Version 2][Flags 2][Baseline][Dictionary][Delta stream][Footer]`.
Encodes world-model anchors (Garden, Lantern, Convergence…) via a
`SymbolicDictionary` + `DeltaStream`. Used for memory exports.

### 3.2 v1 segmented (`header.py`)
72-byte header (`CSFv1\0\0\0`, version, flags, segment_count, sizes, checksum) +
segment table + `ENDCSF`+CRC-32C footer. Flags: `HAS_INDEX`, `CONVERGED`,
`ENCRYPTED`, `STREAMING`.

### 3.3 v0.7 engine (`v07/`)
Symbolic compression research: `quantum_dust`, `base3_positions`,
`qutrit_delta`, `csf_symbolic_compressor`, `convergence_engine`.

---

## 4. Code map

| Path | Role |
|---|---|
| `src/csf/csf_pack.py` | **v0.8 arbitrary-file pack/unpack (new)** |
| `src/csf/csf_file.py` | v0.3 symbolic writer/reader |
| `src/csf/header.py` | v1 segmented header/segment table |
| `src/csf/v07/` | v0.7 symbolic compression engine |
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
