### Repo consolidation — CSF corpus condense (Remember stage)

- Add `scripts/csf_condense_corpus.py`: a repeatable Remember-stage pass that folds the
  intake/research **dump corpus** (`data/ingest`, `data/rag-intake`, `data/reports`,
  `docs/research-papers`, `csf/ingest`) into ONE lossless, SHA-256-verified CSF archive,
  deduplicating byte-identical files, then removes the loose originals.
- Condensed **338 tracked dump files (191 unique, 862 MB)** into a single 373 MB CSF archive
  (gitignored local store — it holds the `data/ingest` PII pool, never re-committed).
  Per-member round-trip verified lossless (191/191).
- Committed an auditable manifest (`data/csf_archives/*.manifest.json`) mapping every original
  path → archive member + SHA-256 for restore, plus a Convergence Record in
  `data/convergence-records.jsonl`.
- App-served / skill / test binaries (`apps/**/public`, `data/images/three-doors`,
  `skills/lantern-rag-dollhouse/assets`, `tests/screenshots`) are deliberately untouched.
- Wire CSF-backed PDF serving: `pdfs.js` reconstructs the Knowledge Center research-PDF
  library from the committed manifest and streams individual PDFs straight out of the CSF
  archive via `scripts/csf_read_member.py` (shell-free `execFile`). List works on every node;
  byte serving needs the local `.csf` present (returns 503 `archived` if absent).
