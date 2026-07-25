# Archive ledger — work moved outside the repo

Files removed from the working tree to keep the repo lean. **Nothing is lost:** code
removals stay in git history; large data blobs and untracked one-offs are copied to the
external archive with a SHA-256 manifest before removal.

- **External archive root:** `F:/lantern-os-archive/<date>/`
- **Per-batch manifest:** `F:/lantern-os-archive/<date>/MANIFEST.jsonl` — one line per file:
  `{file, sha256, bytes, archived_to, reason, date}` (git-history note for tracked files).

## 2026-07-24

| Batch | What | Why | Recover |
|---|---|---|---|
| `data/kalshi/` captures | 4.6 GB of raw 6s tight-band JSONL (Jul 16–19) | Fully mined — census + trajectory + weather forward tests (PR #2901); untracked/gitignored | copy back from `F:/lantern-os-archive/2026-07-24/data/kalshi/` |
| dead experiments (9) | zero-referenced one-off `scripts/*.js` + `experiments/kalshi_grounding_demo.js`, all pre-2026-07 | Superseded / never imported / never in build config | `git show <sha>:<path>` or `F:/…/dead-experiments/` |
| `.bak` junk (4) | stale `*.jsonl.bak` at the main checkout | Untracked backups of tracked files | `F:/…/dead-experiments/` |

**Byte-level code dedup:** 0 exact duplicates in the tree (enforced by the CI duplication gate).
