# !convergance — CSF vs other products in its best-fit category

**Hypothesis:** CSF's best-fit category — *lossless compression of schema-homogeneous,
append-only structured (JSONL) logs* (the only regime where CSF-Col beats zstd-19,
measured this session) — is a defensible niche where CSF is competitive.

**Method:** external grounding (web search + source fetch, June 2026), not memory.
Every row carries `[claim, evidence, confidence, source]`. CSF's own numbers are this
session's lossless-verified benchmark (`experiments/csf_three_standards_benchmark.py`).

## The category is mature and crowded — CSF is not near the front

| product | category role | approach | lossless | searches compressed? | ratio (abs / vs zstd) | maturity |
|---|---|---|:--:|:--:|---|---|
| **CSF-Col / CSF-Omni** (ours) | embedded memory codec | schema row→column transpose + brotli/zstd best-fit envelope | ✓ | ✗ (branded "Searchable", not implemented) | ~15× / **1.13×** zstd on memory logs | solo lib, 1 schema at a time |
| **CLP-JSON (CLP-S)** — YScope/Uber, OSDI'21 | searchable compressed JSON logs | **same idea**: group same-schema events into column tables, then general compressor; KQL search w/o decompress | ✓ | ✓ (KQL, no decompress) | **94:1 / ~2×** zstd | OSS product, Python+Java appenders |
| **CLP (text)** — YScope/Uber | searchable compressed unstructured logs | dictionary + parsed-template encoding | ✓ | ✓ | **169×** on Uber Spark logs (2.16× zstd) | production at Uber (PB/day) |
| **Apache Parquet + zstd** | columnar storage standard | per-column dictionary/RLE/delta + zstd | ✓ | partial (predicate pushdown) | 70–90% vs raw; the baseline everyone benches against | ubiquitous |
| **BtrBlocks** — SIGMOD'23 | data-lake columnar | cascaded lightweight encodings + FSST strings (dict 7× then +51%) | ✓ | scan-time | beats Parquet on most datasets | research/OSS |
| **FastLanes** | columnar | expression encoding (FoR/Delta/Dict/FSST/ALP) + multi-column | ✓ | scan-time | ~2% better than Parquet+zstd, **43× faster decode** | research/OSS |
| **ClickHouse codecs** | columnar OLAP DB | Delta/DoubleDelta/Gorilla/T64 chained with ZSTD | ✓ | ✓ (it's a DB) | codec-dependent | production DB |

## Grounded claims

1. `["CLP-JSON uses the same schema-columnar design as CSF-Col — group same-schema JSON events into column-oriented tables, then compress — but reaches 94:1 (~2× zstd), is lossless, and searches without decompression", "YScope 'CLP on JSON' engineering blog + OSDI'21 paper", 0.9, "https://blog.yscope.com/clp-on-json-high-compression-and-fast-search-on-dynamically-structured-logs-cfe1d4957e6b"]`
2. `["CSF-Col's relative edge over zstd-19 (~1.13× on the realistic memory log, 1.37× on the best log) is far smaller than CLP-S's ~2× over zstd, on the same problem shape", "this session's lossless benchmark vs YScope's published 2× figure", 0.85, "experiments/csf_three_standards_benchmark.py + yscope blog"]`
3. `["CSF's 'Searchable' in the name is not implemented as compressed-domain search; CLP delivers exactly that (search/KQL on compressed logs without decompression)", "CSF code has no compressed-domain index; CLP docs + Uber blog state search-without-decompression", 0.8, "https://github.com/y-scope/clp + https://www.uber.com/blog/reducing-logging-cost-by-two-orders-of-magnitude-using-clp/"]`
4. `["The core CSF-Col technique (row→column transpose + per-column dictionary/RLE/delta + entropy backend) is established prior art, standard in Parquet and every columnar DB", "Parquet encoding docs + CMU 15-721 data-formats lecture + BtrBlocks/FastLanes", 0.9, "https://parquet.apache.org/docs/file-format/data-pages/compression/ + https://www.cs.cit.tum.de/.../btrblocks.pdf"]`
5. `["The compression frontier in this category (BtrBlocks, FastLanes) is cascaded lightweight encodings + FSST string compression + per-column scheme selection — none of which CSF-Col implements (it stores raw value substrings + one brotli pass)", "BtrBlocks SIGMOD'23, FastLanes, FSST PVLDB'20", 0.85, "dipankar-tnt.medium.com Parquet-vs-newer-formats + btrblocks.pdf"]`

## Verdict (Converge)

**On compression ratio, CSF is not competitive in its own best-fit category** — its closest
analog, CLP-JSON, is an existing OSS product that beats zstd by ~2× where CSF-Col beats it by
~13%, *and* delivers the compressed-domain search CSF only names. The transpose-then-compress
idea is textbook columnar prior art (Parquet, ClickHouse); the research frontier (BtrBlocks/
FastLanes/FSST) is a generation ahead.

**CSF's only honest differentiators are integration, not ratio:** a ~200-line embedded Python
codec with a self-describing best-fit envelope, wired directly into the local-first Convergence
Memory loop — no database, no service, no schema registry, lossless-verified, falls back to
brotli so it's never a regression. That is a real *simplicity/ownership* story consistent with
the Σ₀ "local ownership is a feature" principle — but it is **not** a "we beat the codecs" story.

**Recommendation:** stop framing CSF as a compression-ratio play. Two grounded options:
1. If ratio matters for memory at scale, **benchmark against and likely adopt CLP-S** rather than
   growing CSF-Col toward a worse reimplementation of it.
2. Keep CSF as the *embedded, zero-dependency, best-fit memory codec* and measure it on the axis
   it actually wins — integration simplicity + lossless local ownership — not bits/byte.

## Improvisation: can "best-in-slot across all sectors" peak the edge? (measured)

Follow-up to the convergence: if the frontier wins by per-column scheme selection, push
CSF-Omni's best-fit envelope down to the column. Prototype with full lossless round-trip:
[`experiments/csf_slot_prototype.py`](../../experiments/csf_slot_prototype.py). Measured on
the realistic `raw.jsonl` (22,002 B is the shipping CSF-Col→brotli baseline):

| approach | size | vs CSF-Col→brotli |
|---|--:|--:|
| v1 — per-column **separate** best-in-slot streams | 23,255 | **−5.4%** |
| v2 — per-column **transform** + one brotli (greedy proxy) | 22,758 | **−3.3%** |
| v3 — **isolate the incompressible sector**, shared brotli for the rest | **21,457** | **+2.5%** |

Findings (each grounded by the prototype's round-trip-verified numbers):
1. **Separate per-column streams lose (−5.4%)** — they forfeit brotli's cross-column context
   and add 22× framing; at 373 rows that exceeds the per-column fit gain.
2. **A standalone-smaller transform can enlarge the shared stream (−3.3%)** — un-hexing the
   checksum saves ~438 B in isolation but injects max-entropy bytes that flush brotli's
   context for neighbours. *Standalone-smallest ≠ joint-smallest; the greedy proxy selector
   is the wrong signal for a single-stream codec.*
3. **The only real win is isolating the incompressible sector (+2.5%)** — store the SHA-256
   checksum (53% of bytes) raw, keep the rest in one shared brotli. Ceiling is ~2.5%, not 2×,
   for the same reason #1596 failed: the archive is hash-saturated + content already at 0.3 bpb.

`["per-column best-in-slot yields only ~2.5% over the shipping single-stream CSF-Col on real memory logs, and only by isolating the incompressible checksum; naive per-column selection is a net regression because the data has no compressible per-sector headroom and single-stream context dominates at this scale", "csf_slot_prototype.py v1/v2/v3 lossless round-trips on data/csf_memory/raw.jsonl", 0.85, "experiments/csf_slot_prototype.py"]`

**Where best-in-slot WOULD peak edges:** corpora dominated by diverse-but-compressible columns
(timestamps→delta, ints→FoR, floats→Gorilla, enums→dict) **at scale** — CLP-S/BtrBlocks's home
turf, not Keystone's small hash-heavy logs. The grounded selector rule that pays: choose by
*measured joint size*, and isolate incompressible sectors (needs per-schema segmentation —
v3 isolated 0 on the mixed-schema concatenation because checksum lengths differ across logs).

## Sources
- CLP on JSON (CLP-S): https://blog.yscope.com/clp-on-json-high-compression-and-fast-search-on-dynamically-structured-logs-cfe1d4957e6b
- CLP (Uber, two orders of magnitude / 169×): https://www.uber.com/blog/reducing-logging-cost-by-two-orders-of-magnitude-using-clp/
- CLP OSDI'21: https://www.usenix.org/conference/osdi21/presentation/rodrigues · repo https://github.com/y-scope/clp
- Parquet compression/encoding: https://parquet.apache.org/docs/file-format/data-pages/compression/
- BtrBlocks (SIGMOD'23): https://www.cs.cit.tum.de/fileadmin/w00cfj/dis/papers/btrblocks.pdf
- Parquet vs BtrBlocks/FastLanes/Lance/Vortex: https://dipankar-tnt.medium.com/apache-parquet-vs-newer-file-formats-btrblocks-fastlanes-lance-vortex-cdf02130182c
- ClickHouse codecs: https://clickhouse.com/blog/optimize-clickhouse-codecs-compression-schema
