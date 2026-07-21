# docs/archive/

Docs kept for **historical reference only** — they no longer describe the live system. Do
not follow setup steps here or treat these designs as active. A doc lands here when the code
or feature it documented was **removed or superseded**, so the reasoning + git history survive
without cluttering the canonical docs set (blessed by `data/knowledge/doc-catalog.json`).

Archiving policy: only archive a doc when its subject is **verifiably gone** (the code it
documents is deleted on `master`) or **explicitly superseded** by a newer canonical doc. Dated
research notes (`docs/research/`), ADRs (`docs/adr/`), and Σ₀ design records are the project's
grounding record and are **not** archived by age — they stay as the External-Reality-Rule trail.

## creator-v10/

Setup / quickstart guides for the **creator-V10 shorts collection + training pipeline**, whose
scripts (`filter_gaming_shorts.py`, `v10_training_loop.py`, `youtube_shorts_*`, …) were removed
in **PR #2734** (zero live wiring; abandoned since 2026-06). The live creator-intelligence
*scoring* surface (`src/creator-intelligence/scoring/*-v10.js`) and its design docs
(`docs/creator-v10/*`) are unaffected and remain canonical.

- `V10-TRAINING-QUICKSTART.md` — how to run the (removed) training loop.
- `YOUTUBE-API-SETUP.md` — how to configure the (removed) shorts collector daemon.
