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

### BED-LLM Animals targets (data, copied verbatim)

- **Source:** [DeeproChoudhury/BED-LLM](https://github.com/DeeproChoudhury/BED-LLM),
  `bedllm_20q/data/animals.txt` at commit `476d6df917d7b91ad8869667192b06a2e0f22b80`.
- **License:** MIT, Copyright (c) 2025 Deepro Choudhury. The license text is in
  `data/question_machine/BEDLLM-LICENSE.txt`, under a header that names the source.
- **What was taken:** the list of 100 animals, used as the 20 Questions targets.
- **Where it lives:** `data/question_machine/bedllm_animals.txt`, read by
  `experiments/question_machine_20q.py`. It is not under `vendor/`.

The Aider-derived repository map (`src/keystone/repo_map.py`, clean-room, Apache-2.0 concept)
was removed with `src/keystone/` on 2026-09-29.
