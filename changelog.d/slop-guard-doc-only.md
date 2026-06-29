### Fixed
- Autowork patch guard now rejects "doc-only slop" — a patch whose changes are entirely markdown/text under `issues/` or `workspace/`, or a `*placeholder*` file — so a weak model dumping the issue text instead of writing code no longer opens a draft PR. (#1520)
