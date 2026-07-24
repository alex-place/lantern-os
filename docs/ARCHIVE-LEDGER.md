
### 2026-07-24 (batch 2 — operator directive)

| Removed | Why | Notes |
|---|---|---|
| `assets/brand`, `caad`, `config`, `manifests`, `models`, `research`, `surfaces` | Legacy scaffolding (shareholder/foundry/dream-journal era), CI-referenced or non-product-UI | Fail-soft server reads confirmed (mesh→empty, status.js→defaults); references patched |
| `apps/lantern-garage/lib/pr-watcher.js` + `routes/pr-review.js` | PR-watcher dead — merges are manual now | server.js wiring + surface-registry entry removed |
| Docker stack (`Dockerfile`, `docker-compose.yml`, `.dockerignore`) | Old — deploy is gh-pages + Railway (`node server.js`) + GCE, not docker | Kept `src/*_rust/Dockerfile` (rust build containers) |
| `Makefile` | Windows-first; `npm run` scripts replace it | CLAUDE/README/QUICKSTART patched off `make` |
| `scripts/Deploy-{AWS-ECS,LanternGarageCloud,DiscordBotCloud}.ps1`, `status.ps1`, `eval_humaneval_plt_direct.py`, `.github/workflows/static-surface-ci.yml` | Depend on removed docker/dirs | — |

**Not touched (flagged for the operator):** Windows scheduled tasks — several are LIVE production
(`LanternCloudflareTunnel`, `LanternDiscordBot`, `KeystoneArxivHarvest`, `KeystoneClaudeReaper`);
deleting them is a system-state change outside the agent boundary. See the session report for the
dead/live split + exact `schtasks /delete` commands.
