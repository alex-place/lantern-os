# Third-Party Notices

Keystone OS incorporates functionality ported or adapted from third-party
open-source projects. This file records each component, its upstream source, its
license, and what was lifted — the attribution required to stay compliant with
permissive licenses (Apache-2.0 / MIT / BSD).

## Porting policy

- **Permissive only.** Only Apache-2.0, MIT, and BSD-family code may be ported
  into Keystone. **GPL / AGPL / LGPL code must NOT be ported** — copyleft would
  relicense Keystone. When in doubt, re-implement clean-room from the docs.
- **Two compliant forms:**
  1. *Vendored verbatim* — place under `vendor/<name>/` with the upstream
     `LICENSE` file preserved unmodified, and add an entry below.
  2. *Clean-room re-implementation* — credit the source + license in the file's
     module docstring (see `src/keystone/repo_map.py`), and add an entry below.
- Every entry records: source repo, license, the upstream version/commit if
  vendored, what was taken, and where it lives in this repo.

## Components

### Aider — repository map approach

- **Source:** https://github.com/Aider-AI/aider (https://aider.chat/docs/repomap.html)
- **License:** Apache-2.0
- **Form:** Clean-room re-implementation (no upstream source copied).
- **What was adapted:** The repo-map *concept* — extract symbols defined and
  referenced per file, build a graph where edges follow symbol references, and
  rank files with PageRank to select the most relevant context slice.
- **Where:** `src/keystone/repo_map.py` (stdlib-only; regex symbol extraction
  in place of tree-sitter, hand-rolled PageRank in place of networkx).
- **Issues:** #1409, #1413; convention: #1412.
