# Third-Party Notices

unisona.ai incorporates functionality ported or adapted from third-party
open-source projects. This file records each component, its upstream source, its
license, and what was lifted — the attribution required to stay compliant with
permissive licenses (Apache-2.0 / MIT / BSD).

## Porting policy

- **Permissive only.** Only Apache-2.0, MIT, and BSD-family code may be ported
  into unisona.ai. **GPL / AGPL / LGPL code must NOT be ported** — copyleft would
  relicense unisona.ai. When in doubt, re-implement clean-room from the docs.
- **Two compliant forms:**
  1. *Vendored verbatim* — place under `vendor/<name>/` with the upstream
     `LICENSE` file preserved unmodified, and add an entry below.
  2. *Clean-room re-implementation* — credit the source + license in the file's
     module docstring (see `src/keystone/repo_map.py`), and add an entry below.
- Every entry records: source repo, license, the upstream version/commit if
  vendored, what was taken, and where it lives in this repo.

## Components

None at present. The Aider-derived repository map (`src/keystone/repo_map.py`, clean-room,
Apache-2.0 concept) was removed with `src/keystone/` on 2026-09-29.
