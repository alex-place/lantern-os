### CSF corpus archive split — commit a public, PII-free archive

- Split the condensed corpus into a **public archive** (`corpus-public-*.csf`, research/report
  PDFs — committed for durability) and a **local-only ingest archive** (`corpus-ingest-*.csf`,
  the `data/ingest` PII pool — gitignored, never committed to this public repo).
- `pdfs.js` now loads **all** manifests in `data/csf_archives` and ties each PDF to its own
  archive, so the public archive serves everywhere and the ingest archive serves only where the
  local `.csf` is present (503 `archived` otherwise).
- `scripts/csf_split_archive.py` performs the split losslessly by extracting members from the
  source archive (originals already removed) and repacking per group, SHA-256 verified.
