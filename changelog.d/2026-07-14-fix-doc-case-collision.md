### Fixed

- docs: removed the case-colliding duplicate `docs/convergence-routing-architecture.md` — the repo tracked BOTH casings of the convergence-routing doc, so on case-insensitive filesystems (Windows/macOS) one always showed as modified, permanently dirtying every checkout and blocking rebase/stash. Canonical UPPERCASE path kept with the newer (brand-swept) content; knowledgecenter + doc-catalog references updated.
