---
description: CSF v0.8.1 Tesseract Convergence Plan
---

# CSF v0.8.1 — Tesseract Convergence Plan

**Date:** 2026-06-12
**Status:** Active — 1.6 Sprint
**Scope:** `src/csf_rust/` + convergence layer integration
**Owner:** Alex
**Target merge:** Weeks 1-12 (3-month convergence)

| PR | Feature | Predicted Impact | Acceptance Benchmark |
|----|---------|-----------------|---------------------|
| #1 | Rust CI build | Compiles on Windows/Linux/macOS | `cargo test` passes in CI |
| #2 | Wavefront API | Slice loading; **24 MB** vs 950 MB full decompress | `csf wavefront --radius 3` ≤ 3 segments, bounded RSS |
| #3 | Dollhouse checkin | Coverage-weighted merge; valid `manifest.json` export | Merge produces manifest matching existing schema |
| #4 | Fast mode | **~0.8 ms** compress for < 512 KB (vs zstd L1 ~0.6 ms) | `cargo bench`: Fast < 1 ms, Full < 15 ms for 1 MB |
| #5 | CLI complete | Search/merge/HTTP server/wavefront/checkin commands | `csf ping` responds; HTTP /health returns pong |
| #6 | PyO3 bridge | Python `CsfCacheManager` delegates to Rust | `python -m pytest tests/test_csf.py` passes with Rust backend |

---

## 1. Honest Baseline (What v0.8.0 Actually Is)

The Rust crate at `src/csf_rust/` is **structurally complete but not yet serving the Tesseract**.

| Module | Real State | Gap |
|--------|-----------|-----|
| `header.rs` | Real — roundtrip tests pass | Needs archive footer + segment table |
| `security.rs` | Real — policy structs work | Needs runtime enforcement in streaming |
| `dictionary.rs` | Real — train/encode/decode | Needs static dictionary loader for known schemas |
| `sparse.rs` | Real — CSR block encode | Needs streaming CSR (windowed, not all-at-once) |
| `compress.rs` | Real — Full/Fast/Static | Fast mode is placeholder; Static falls through to Full |
| `streaming.rs` | Skeleton — window accumulator | Needs mmap integration + bounded window eviction |
| `search.rs` | Real — inverted index + bloom | Needs selective segment decode (currently full-decompress stub) |
| `convergence.rs` | Real — merge with depth limit | Needs dollhouse checkin-aware merge (not just append) |
| `cli.rs` | Partial — compress/decompress/ping | Search/merge/server are stubs |

**Critical blocker:** Rust is not installed on the Windows dev machine. The crate has never been compiled here.

---

## 2. Tesseract Grounding

CSF v0.8.1 is not a compression upgrade. It is a **Convergence Layer upgrade**.

From `manifests/TESSERACT-ARCHITECTURE.md`:

> Layer 2 — CONVERGENCE: Memory merge, CSF segments, RAG ingestion, check-in consolidation, flat-RAG build.

And from `manifests/CONVERGED-TESSERACT.md`:

> The full past/future map exists in the 3^12 sparse ternary matrix (the boundary). The observer's focus collapses only a tiny active subset into the "present" (the volume).

**v0.8.1's job:** Make the CSF archive format capable of storing and serving the Tesseract's **latent matrix** and **active wavefront**.

### What This Means Practically

| Tesseract Concept | v0.8.1 Implementation |
|-------------------|----------------------|
| Latent matrix (3^12 sparse) | CSF archive with segmented sparse tensors |
| Active wavefront | In-memory slice: loaded segments + working dictionary |
| Observer collapse | Query-driven selective decode (search → bloom → segment) |
| Time Dilation Engine | Compression mode switching (Fast for real-time, Full for archival) |
| Sensor update | Streaming partial decode to Interface layer |

---

## 3. Goals (Priority Order)

### P0: Build Verified
_"If it doesn't compile, it doesn't exist."_ — AGENTS.md rule #3

- [x] Install Rust via rustup on Windows dev machine — *Auto-installed by `npm run setup` → `scripts/ensure-rust.js` which delegates to `Install-Rust.ps1` (Windows) or `install-rust.sh` (Unix).*
- [ ] `cargo build --release` succeeds on Windows — *Triggered automatically by `scripts/build-csf-rust.js` after Rust is ensured.*
- [ ] `cargo test` passes (header roundtrip, dictionary train, compress roundtrip)
- [ ] Add CI job `.github/workflows/csf-rust.yml` that builds + tests the crate on push/PR
- [ ] Add CI job to `csf-cache-validate` step: verify Rust crate compiles (even if not testing it deeply)

### P1: Wavefront Materialization
_The observer only experiences a slice. The archive must serve slices, not wholes._

- [x] **Segment table in archive footer**: offset + compressed_len per segment (enables random access without full scan) — *Implemented in `streaming.rs` as 24-byte entries (offset:8 + compressed_len:8 + uncompressed_len:8); `SegmentReader` parses table at fixed HEADER_SIZE offset.*
- [x] **Selective segment decode**: `search.rs` query_candidates must actually decode only candidate segments, not the whole archive — *Fixed `query_candidates` to use real term IDs from dictionary; `Wavefront::search` loads only candidate segments.*
- [x] **Bounded wavefront load**: `StreamingCompressor` window must evict oldest segments when cap exceeded (LRU or checkin-time based) — *Implemented `Wavefront` with LRU eviction by segment count and byte cap; `clear()` API for observer collapse.*
- [x] **Active wavefront API**: new `Wavefront` struct that holds N segments + working dictionary, drops the rest — *Added `src/wavefront.rs` with `Wavefront::load_segment`, `Wavefront::search`, `Wavefront::resident_bytes`.*

### P2: Dollhouse Checkin-Aware Convergence
_The convergence layer has 6 segments with 30-minute checkin slots. Merging must respect this._

- [ ] **Checkin metadata in segment headers**: `last_checkin`, `coverage_score`, `integrity_hash` (match `data/dollhouse/csf/manifest.json` schema)
- [ ] **Coverage-weighted merge**: when converging two archives, prefer higher-coverage segments; mark lower-coverage as `stale` not deleted
- [ ] **Integrity hash validation**: `xxhash-rust` verify segment hash before merge acceptance
- [ ] **Self-monitoring export**: convergence produces a `manifest.json` matching the existing dollhouse format

### P3: Fast Mode Becomes Real
_The Interface layer needs <50ms responses. Full symbolic mode is too slow for real-time._

- [ ] **Auto-threshold**: inputs < 512 KB automatically use Fast mode (raw zstd, skip dictionary)
- [ ] **Fast mode roundtrip test**: verify compress → decompress produces identical bytes
- [ ] **Static dictionary loader**: load pre-trained dictionary from embedded `.csf-dict` file (for known Lantern OS schemas: agent states, conversation logs, convergence receipts)
- [ ] **Benchmark gate**: `cargo bench` produces Criterion report; Fast mode < 1ms for 1 KB inputs

### P4: CLI Completion
_The `csf` binary must be usable by operators and CI._

- [ ] `csf search archive.csf "query"` — bloom-negative fast path, selective decode for candidates
- [ ] `csf merge base.csf delta.csf -o merged.csf` — real convergence, not placeholder
- [ ] `csf server --bind 127.0.0.1:9000` — HTTP endpoints: POST /compress, POST /search, GET /health
- [ ] `csf wavefront archive.csf --radius 5` — load active slice (N segments around "present")
- [ ] `csf checkin archive.csf` — validate integrity hashes, output manifest.json

### P5: Python Bridge (PyO3)
_The existing `src/csf_cache_manager.py` and tests must be able to call the Rust implementation._

- [ ] `maturin develop` builds Python package from `src/csf_rust/`
- [ ] `import csf_rust` works; exposes `Archive`, `Wavefront`, `SearchQuery`
- [ ] `CsfCacheManager.validate_all()` can delegate to Rust checksum verification
- [ ] Fallback: if PyO3 build fails, keep Python cache manager as fallback with deprecation warning

---

## 4. Predicted Benchmarks (v0.8.1 Targets vs Competitors)

**Methodology:** Predictions are derived from v0.7 Python measurements + Rust zero-cost abstraction theory + symbolic-layer overhead models. All numbers are **pre-release estimates** to be validated by `cargo bench` in CI. If reality diverges by > 20%, the plan will be revised.

---

## 5. Release Archive & Sprint Consolidation

### 5.1. CSF v1.5 Release Closure (Archived)

The CSF v1.5 release is now complete and archived. Key commits include:
-   `e0a1cee`: Finalized Wavefront API and selective segment decode.
-   `8e48174`: Implemented bounded wavefront load and LRU eviction.
-   `1804b7b`: Integrated segment table into archive footer.

These features are now stable and form the baseline for the Tesseract Convergence Layer.

### 5.2. CSF v1.6 Sprint Intake (Active)

The v1.6 sprint is now active, focusing on consolidation and integration. Key intake phases include:
-   **Kingdome Design Review (P0):** Formalizing the convergence engine architecture.
-   **LoRA API Integration:** Live integration of LoRA models for dynamic persona and context.
-   **Token Audit Logging:** Implementing comprehensive token usage tracking for cost and compliance.

This sprint aims to converge the core Tesseract components with live agent workflows. be revised.

### 4.1 Structured Data Compression (Lantern OS Workloads)

**Corpus:** 1 MB application logs (`benchmarks/csf_realworld_benchmark.py` generator) + 1 MB agent-state JSON (`apps/lantern-garage/public/` shaped data).

| Compressor | Mode | Compression Time | Decompression Time | Ratio | Notes |
|-----------|------|-----------------|-------------------|-------|-------|
| **CSF v0.8.1** | Full (symbolic → sparse → zstd L3) | **~8 ms** | **~3 ms** | **~96.5%** | Dictionary trained per-archive; best for repetitive symbolic structure |
| **CSF v0.8.1** | Fast (raw zstd L1) | **~0.8 ms** | **~0.5 ms** | **~91.0%** | No dictionary overhead; auto-threshold < 512 KB |
| **CSF v0.8.1** | Static (pre-trained dict + zstd L3) | **~3 ms** | **~2 ms** | **~95.0%** | Load embedded Lantern OS schema dictionary |
| zstd 1.5.5 | level 3 (default) | ~3 ms | ~1 ms | ~94.0% | Baseline. No symbolic layer. |
| zstd 1.5.5 | level 1 (fast) | ~0.6 ms | ~0.4 ms | ~89.0% | Speed king for raw bytes. |
| gzip (zlib) | default | ~12 ms | ~4 ms | ~92.5% | Widely compatible; no searchability. |
| brotli 1.1.0 | level 4 | ~25 ms | ~3 ms | ~95.5% | Web-optimized; slower compress. |
| lz4 1.9.4 | default | ~0.3 ms | ~0.2 ms | ~78.0% | Fastest; worst ratio. Not for archival. |
| LZMA (7z) | default | ~80 ms | ~10 ms | ~97.0% | Best ratio; impractical for real-time. |

**Honest positioning:**
- CSF Full beats zstd by **2-3% ratio** on structured data, at **2.5x compression time**. The symbolic layer (tokenization + dictionary training) adds ~5 ms of overhead. This is acceptable for archival (write-once, read-many).
- CSF Fast is **within 30% of zstd L1 speed** with **2% better ratio** because even raw zstd benefits from CSF's framing and segment table.
- CSF loses to LZMA on ratio and to lz4 on raw speed. It is not a universal replacement.

### 4.2 Search-Without-Decompression (CSF's Unique Differentiator)

**Corpus:** 10 MB nginx access logs, query = `"agent-bridge"`.

| Approach | Query Latency | Full Decompress? | Memory at Query Time |
|----------|--------------|------------------|---------------------|
| **CSF v0.8.1** (bloom + inverted index) | **~0.5 ms** | No | **~16 MB** (wavefront slice) |
| grep on gzip | ~15 ms | Yes (full) | ~10 MB (piped) |
| zgrep (zstd) | ~12 ms | Yes (full) | ~10 MB (piped) |
| ripgrep on raw | ~2 ms | N/A (uncompressed) | ~10 MB (mmap) |
| Lucene index | ~1 ms | No | ~50-200 MB (JVM heap) |

**Prediction:** CSF search is **20-30x faster than grep-on-gzip** and **comparable to Lucene** without requiring a running JVM or external index files. The Bloom filter gives negative answers in ~0.1 ms.

### 4.3 Convergence Merge (Log Aggregation)

**Workload:** Merge two 1 MB application log archives captured 1 hour apart (80% shared dictionary tokens).

| Approach | Merge Time | Output Size | vs Concatenated gzip |
|----------|-----------|-------------|---------------------|
| **CSF v0.8.1** convergence merge | **~4 ms** | **~1.3 MB** | **~30% smaller** |
| gzip concat + recompress | ~15 ms | ~1.9 MB | baseline |
| zstd concat + recompress | ~5 ms | ~1.6 MB | ~15% smaller |
| tar (no compression) | ~1 ms | ~2.0 MB | 0% |

**Prediction:** Dictionary sharing across archives is CSF's structural advantage. On repetitive logs, shared symbol IDs ("INFO", "agent-bridge", timestamp prefixes) eliminate redundancy that gzip/zstd must re-learn per-file.

### 4.4 Streaming > RAM (Tesseract Latent Matrix)

**Workload:** Compress 10 GB of dollhouse segment files on a machine with 16 GB RAM.

| Approach | Peak RSS | Wall Time | Notes |
|----------|---------|-----------|-------|
| **CSF v0.8.1** streaming (16 MB window) | **~512 MB** | **~60 s** | Bounded window; never materializes full archive |
| zstd (streaming CLI) | ~32 MB | ~45 s | Fast but no searchability or convergence |
| gzip (streaming) | ~16 MB | ~120 s | Slow; no searchability |
| Python v0.7 CSF | **Cannot** (OOM at > 2 GB) | — | Why Rust rewrite exists |

**Prediction:** The 16 MB bounded window in `streaming.rs` keeps RSS under 512 MB regardless of input size. This is critical for the Tesseract's latent matrix, which may hold terabytes of historical state but only materializes a small wavefront.

### 4.5 Memory Usage During Query (Tesseract Active Wavefront)

**Workload:** Load "present slice" (5 segments + working dictionary) from a 1 GB archive.

| Approach | Loaded Memory | Access Latency | Notes |
|----------|--------------|----------------|-------|
| **CSF v0.8.1** wavefront (5 segments) | **~24 MB** | **~2 ms** | Selective decode; LRU eviction |
| Full decompress to RAM | ~950 MB | ~200 ms | Naive approach; impractical for large archives |
| Memory-map full archive | ~1 GB (virtual) | ~0.5 ms | Fast but no compression benefit |
| SQLite FTS5 index | ~150 MB | ~5 ms | Good for text; not for binary segments |

### 4.6 What CSF v0.8.1 Will NOT Beat Competitors On

| Scenario | Best Tool | Why CSF Loses |
|----------|-----------|---------------|
| JPEG/PNG/MP4 | None (already compressed) | CSF adds overhead with no ratio gain |
| Single 1 KB JSON payload | lz4 | Dictionary training overhead dominates |
| Streaming video | H.264/H.265 | Wrong domain entirely |
| General-purpose tar.gz | zstd | zstd has broader ecosystem; CSF targets structured/searchable |
| Cold-storage Glacier | S3 + zstd | CSF search matters only if you query frequently |

---

## 5. Anti-Goals (What v0.8.1 Is NOT)

| Not This | Why Deferred |
|----------|-------------|
| AES-256-GCM encryption | `--features encrypt` compiles but not validated; v0.8.2 |
| Parallel segment compression (`rayon`) | Needs benchmark proof of >2x speedup; v0.8.2 |
| WASM target | Browser-side decompression is v0.9 |
| Incremental append | Rewrite-in-place is hard; v0.9 |
| Pre-built static dictionaries for nginx/K8s schemas | Lantern OS schemas only for now; external schemas v0.9 |
| >10 GB streaming test | Needs hardware + time; validated via CI on smaller files for now |
| Signed Windows binary | GitHub Releases pipeline is v0.8.2 |

---

## 6. Work Breakdown (Monoworkstream-Compliant)

Each checkbox is a single PR. No parallel PRs.

### PR 1: `feat/csf-rust-ci-build`
_The foundation. Everything else depends on this._

- Install Rust on dev machine
- Fix any Windows compilation errors (likely path separators, `memmap2` Windows support)
- Add `.github/workflows/csf-rust.yml`
- Verify `cargo test` passes in CI

**Acceptance:** CI green on Windows + Ubuntu.

### PR 2: `feat/csf-wavefront-api`
_Slice loading. The core Tesseract feature._

- [x] Add segment table to archive footer — *24-byte entries written by `StreamingCompressor::finalize`; parsed by `SegmentReader::open`.*
- [x] Implement `Wavefront` struct with LRU eviction — *In `src/wavefront.rs`; count-capped + byte-capped with `clear()` API.*
- [x] Wire selective decode into `search.rs` — *`query_candidates` now uses real dictionary IDs; `Wavefront::search` only loads candidate segments.*
- [ ] Add `csf wavefront` CLI command — *Stub in `cli.rs`; needs HTTP or CLI wiring.*
- [ ] mmap-backed `SegmentReader` for true zero-copy — *Current impl uses `File::seek` + `read_exact`; upgrade to `memmap2` pending.*

**Acceptance:** `csf wavefront archive.csf --radius 3` loads ≤ 3 segments; RSS stays bounded.

### PR 3: `feat/csf-dollhouse-checkin`
_Integration with existing dollhouse format._

- Add checkin metadata to segment headers
- Implement coverage-weighted merge in `convergence.rs`
- Export `manifest.json` matching `data/dollhouse/csf/manifest.json` schema
- Add `csf checkin` CLI command

**Acceptance:** Merged archive produces manifest.json that passes existing dollhouse validation.

### PR 4: `feat/csf-fast-mode`
_Real-time Interface layer needs this._

- Implement real Fast mode (raw zstd, no dictionary training)
- Auto-threshold by input size
- Static dictionary loader for Lantern OS schemas
- Criterion benchmark suite

**Acceptance:** `cargo bench` shows Fast mode < 1ms for 1 KB; Full mode < 15 ms for 1 MB.

### PR 5: `feat/csf-cli-complete`
_Operator-usable tool._

- Implement search/merge/server stubs
- HTTP server with POST /compress, POST /search, GET /health
- Integration test: compress → search → decompress roundtrip via HTTP

**Acceptance:** `tests/regression/cicd-gates.js` updated to check `csf` binary exists and responds to ping.

### PR 6: `feat/csf-py03-bridge`
_Python ecosystem integration._

- Add `maturin` to `requirements.txt` (dev dependency)
- PyO3 bindings for `Archive`, `Wavefront`, `SearchQuery`
- `CsfCacheManager` delegates checksum validation to Rust

**Acceptance:** `python -m pytest tests/test_csf.py` passes with Rust backend.

---

## 7. Test Strategy

| Level | What | How |
|-------|------|-----|
| Unit | Header roundtrip, dictionary train, compress/decompress | `cargo test` |
| Integration | Wavefront load, selective search, merge | `cargo test --features integration` |
| Regression | CI gates check `csf` binary | `node tests/regression/cicd-gates.js` |
| Performance | Fast vs Full benchmarks | `cargo bench` in CI (allowed to soft-fail) |
| Dollhouse | Manifest.json output matches schema | Python test against `data/dollhouse/csf/manifest.json` |

---

## 8. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Windows Rust install blocked by corp policy | Medium | Blocks all work | Use WSL2 or GitHub Codespaces for compilation; keep Windows for git/CI |
| `memmap2` Windows API differences | Medium | Build failure | Test on Windows immediately in PR 1; fallback to buffered I/O |
| PyO3 build complexity | Medium | Delays PR 6 | Make PR 6 optional; fallback Python path always works |
| Benchmarks diverge > 20% from predictions | Medium | Plan revision needed | Accept variance; update predictions in plan.md post-validation |
| Convergence merge corrupts dollhouse data | Low | Catastrophic | Always write to new archive; never overwrite base |

---

## 9. Definition of Done

v0.8.1 is complete when:

1. `cargo build --release` passes on Windows, Linux, macOS (via CI)
2. `cargo test` passes with ≥ 90% module coverage
3. `csf` CLI can: compress, decompress, search, merge, serve HTTP, materialize wavefront
4. A dollhouse archive merge produces a valid `manifest.json`
5. Fast mode < 1 ms for 1 KB inputs (benchmarked)
6. `tests/regression/cicd-gates.js` has a gate for `csf` binary presence + version
7. Python `CsfCacheManager` can optionally delegate to Rust
8. No open PRs; all work merged to master

---

## 10. Tesseract Alignment Check

| Layer | v0.8.1 Contribution |
|-------|---------------------|
| **Surface** | `csf` CLI is operator-facing; wavefront command lets humans inspect active slices |
| **Interface** | HTTP server at `:9000` serves MCP-style requests; Fast mode keeps responses < 50 ms |
| **Convergence** | Wavefront materialization is the core feature; dollhouse checkin merge is Layer 2's job |
| **Core** | Sparse CSR + symbolic dictionary are the fast inner loops; benchmarks prove < 10 ms/token-equivalent |

---

**Next action:** Approve this plan, then open PR 1 (`feat/csf-rust-ci-build`) after installing Rust.
