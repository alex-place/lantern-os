### Repo cleanup: archived mined captures + dead one-offs outside the tree

Removed from the working tree (nothing lost — git history for tracked files, SHA-256 manifest
for blobs): 9 zero-referenced pre-July one-off scripts (`scripts/*.js`,
`experiments/kalshi_grounding_demo.js`); 4.6 GB of fully-mined Kalshi tight-band captures moved to
the external archive. Byte-level code dedup found 0 exact duplicates (CI duplication gate already
enforces it). New `docs/ARCHIVE-LEDGER.md` records what moved, why, and how to recover it.
