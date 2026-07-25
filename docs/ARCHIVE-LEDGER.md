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

### 2026-07-24 (batch 2 — operator directive: "in CI and not on an actual UI → remove")

| Removed | Why | Notes |
|---|---|---|
| `assets/brand`, `caad`, `config`, `manifests`, `models`, `research`, `surfaces`, `notebooks` | Legacy scaffolding (shareholder/foundry/dream-journal era), CI-referenced or non-product-UI | Fail-soft server reads confirmed (mesh→empty, status.js→defaults); references + CI gates patched |
| `lib/pr-watcher.js` + `routes/pr-review.js` | PR-watcher dead — merges are manual now | server.js wiring + surface-registry entry removed |
| Docker stack (`Dockerfile`, `docker-compose.yml`, `.dockerignore`) | Old — deploy is gh-pages + cloud (`node server.js`) + GCE, not docker | Kept `src/*_rust/Dockerfile` (rust build containers) |
| `Makefile` | Windows-first; `npm run` scripts replace it | CLAUDE/README/QUICKSTART patched off `make` |
| `scripts/Deploy-{AWS-ECS,LanternGarageCloud,DiscordBotCloud}.ps1`, `status.ps1`, `eval_humaneval_plt_direct.py`, `.github/workflows/static-surface-ci.yml` | Depend on removed docker/dirs | — |

### 2026-07-24 (batch 3 — same directive)

| Removed | Why | Notes |
|---|---|---|
| All 12 Windows scheduled tasks | Tunnel sunset; bot migrated; arxiv/reaper are skills now | XMLs archived to `F:/…/scheduled-tasks/`; deletion needs an elevated shell (block handed to operator) |
| `src/discord_lounge_bot/` (+ launchers, MCP curator registrations) | Migrated to `alex-place/three-doors` PR #2 | Deregistered: MCP, surface-registry, server spawn/shutdown, requirements, env |
| Task installers/autostarts (`Register-*`, `*-autostart.ps1`, `Schedule-*`) | Their tasks are gone | Archived to `F:/…/deleted-dirs/task-installers/` |
