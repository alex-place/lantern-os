# Dollhouse CSF Upgrade — CADD Intake Flow

## CADD Phases for Dollhouse Content

### Capture
- Recursively scan `data/dollhouse/` for `.md` source documents
- Preserve directory structure (books/, skills/, root docs)
- Extract raw text and front-matter metadata
- Tag each document with its symbolic anchors (Fleet, RAG, Convergence, etc.)

### Assess
- Run CSF v0.7 symbolic compressor in analysis mode
- Measure per-file compression ratio — high ratio = dense symbolic content
- Identify shared anchors across documents (cross-reference map)
- Flag documents with low symbolic density for manual review
- Score documents by anchor overlap with Dream Journal entries

### Distill
- Compress each document **losslessly** via `csf.csf_pack` (per-file zstd-19,
  optional `use_dict=True` shared dictionary across the dollhouse corpus).
- For symbolic *analysis only* (anchor coverage, dictionary overlap), run
  `SymbolicCompressor.compress_text()` — but note it is **lossy and
  non-invertible** (`lossless=False`, no decoder); its ratio is a symbolic
  projection, not a real compression ratio, so do not use it for storage.
- Recurring concepts (Fleet, Agent, MCP, Convergence) map to short dictionary
  IDs in the analysis pass; actual byte savings come from the zstd backend.
- Output individual `.csf` files preserving the source directory layout

### Dock
- Merge individual CSF segments into `dollhouse-merged.csf` via `CsfArchive`
- The merged archive supports segment-level search across all dollhouse docs
- Register the archive in the Lantern Garage agent status endpoint
- Connect to Dream Journal: the CSF preview in dream entries can reference
  dollhouse anchors, creating a bidirectional symbolic link

## Symbolic Anchors Across Dollhouse Documents

| Anchor          | Documents                                    |
|-----------------|----------------------------------------------|
| Fleet / Agent   | ACTIVE-FLEET-PROCESSING, RAG-DOLLHOUSE-ARCH  |
| Convergence     | ACTIVE-FLEET-PROCESSING, MODEL-CONTEXT       |
| MCP             | ACTIVE-FLEET-PROCESSING, CHAT-HANDOFF        |
| Self-Correcting | SELF-CORRECTING-SKILLS, ACTIVE-FLEET         |
| RAG / Memory    | RAG-DOLLHOUSE-ARCH, BOOK-LEARNING-ENGINE     |
| Learning / Book | BOOK-LEARNING-ENGINE, SELF-CORRECTING-SKILLS |
| Handoff / Chat  | CHAT-HANDOFF-INTEGRATION, ACTIVE-FLEET       |
| Model / Context | MODEL-CONTEXTUALIZATION, RAG-DOLLHOUSE-ARCH  |

## CSF Compression ↔ CADD Mapping

- **Capture** = file discovery + raw read → `Path.rglob("*.md")`
- **Assess** = anchor extraction + ratio analysis → `find_anchors()` + `CompressionResult`
- **Distill** = symbolic compression → `SymbolicCompressor.compress_text()`
- **Dock** = archive merge + registration → `CsfArchive.add_bytes()` + `_write_to()`

## Connection to Dream Journal CSF Preview

Dream Journal entries in `data/dream_journal/` already store CSF preview
hashes. When dollhouse documents share anchors with dream entries (e.g.,
"Convergence", "Memory", "Learning"), the CSF dictionary encodes them
identically — enabling cross-archive search between dreams and dollhouse
knowledge. The merged dollhouse archive can be converged with a dream
archive via `CsfArchive.converge()` for unified symbolic retrieval.

## Operational Notes

- Run `scripts/csf_dollhouse_ingest.py` to execute the full CADD pipeline
- Output lands in `data/dollhouse/csf/` (individual + merged)
- Re-run after adding new dollhouse documents to update the archive
- Monitor CSF health via `scripts/agent_self_monitor.py`
