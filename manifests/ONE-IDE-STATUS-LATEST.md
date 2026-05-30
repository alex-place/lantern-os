# Lantern One IDE Status Receipt

Generated: 2026-05-30T01:41:39.2032885Z

Mode: read-only preflight.

## Boundary

- No reset, clean, sync, force-push, dispatch, wallet action, trade execution, or private-data mutation happened in this receipt.
- Local repo state, live health URLs, actual MCP tool state, and dirty worktrees override cached status.
- Cloud URLs remain untrusted until root, health, and mirror checks pass.

## Summary

| Surface | Result |
|---|---|
| Lantern repo | Dirty on `master...origin/master`, dirty count 11. |
| HFF scan repo | Clean on `codex/plan-safe-multicoin-mining`. |
| Orchestrator repo | Dirty on `master...origin/p0/four-agent-fleet-baseline`, dirty count 6. |
| Local services | `gpt-web-api`, `dashboard`, `lantern`, and `mcp` health checks passed. |
| Ngrok | No health URL configured; tunnel is not trusted from this receipt. |
| MCP connector | `ready_tools_visible`; advertised-vs-actual must still be checked before dispatch. |
| Agent worktrees | 14 found; 3 dirty. |
| Failed services | 0. |

## Current Recommendation

Hold mutation and reconcile dirty worktrees in the One IDE board first.

## Receipts

| Artifact | Path |
|---|---|
| JSON receipt | `manifests/validation/ONE-IDE-STATUS-LATEST.json` |
| Baseline model | `data/baseline-model/v1.json` |
| Baseline report | `manifests/LANTERN-BASELINE-MODEL-v1.md` |
| Kalshi stats report | `reports/KALSHI-KOFI-WATCHLIST-REVENUE-REPORT.md` |

## Human Approval Gates

- Agent dispatch remains held while dirty worktrees exist.
- Kalshi output remains research-only with executable trade recommendations at 0.
- AWS/cloud route remains held until a verified AWS service URL passes root and health checks.
