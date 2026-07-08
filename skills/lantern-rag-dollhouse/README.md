# lantern-rag-dollhouse — kept intentionally (asset store, not a live skill)

This directory is NOT a runnable skill (no implementation is registered for it).
It is kept because its assets are live inputs elsewhere:

- `assets/pdfs/*.pdf` are the Comet-Leap master PDFs consumed by
  `scripts/build_library_thumbs.py`, which emits
  `apps/lantern-garage/public/library-thumbs/` (referenced by its `index.json`).

The other unimplemented design-contract skill dirs were removed in #2096.
If you implement this as a real skill, register it per CLAUDE.md's skill rules.
