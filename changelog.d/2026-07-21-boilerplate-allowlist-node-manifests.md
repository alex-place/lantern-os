### Fixed

- ci: the **Boilerplate / duplication check** (`.github/workflows/pr-gates.yml`) now treats Node manifests — `package.json`, `package-lock.json`, `tsconfig.json` — as `UBIQUITOUS`, the same standard-filename allowlist that already exempts `pyproject.toml` / `setup.py` / `index.html`. Every sub-package or tool directory legitimately carries its own manifest, so flagging a new one as a "duplicate" of the root/app manifests was a false positive (surfaced when #2744's `scripts/reports/leap-video-2026-07/package.json` failed the gate). Unblocks any PR that adds a scoped Node package.
