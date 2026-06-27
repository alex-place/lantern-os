### Cleanup: dead code, unused dependency, and runtime-log de-bloat

- **Dead code removed (~339 lines):** `lib/goal-engine.js` (landed as a `feat(wip)` working-tree dump, referenced nowhere) and `lib/image-pool.js` (residual from the Three-Doors removal — its only consumer, the deleted `routes/three-doors-image-pool.js`, is gone). Verified zero static *and* dynamic (`readdirSync`-loader) references before deleting; both server entrypoints still pass `node --check`.
- **Unused dependency dropped:** `@anthropic-ai/sdk` (`apps/lantern-garage`) is imported nowhere in the repo — chat calls Anthropic over `fetch`. Removed from `package.json` and reconciled the lockfile (−72 lines), keeping `npm ci` / dep-preflight green.
- **Stop committing runtime tool-logs:** untracked `apps/data/tool-logs/<date>.jsonl` (a dated daily log already tens of MB/day live) and ignored both `data/tool-logs/` and the `apps/data/tool-logs/` path the logger actually writes to. Tool traces have historically leaked API keys, so these stay local-only.
- **`.gitignore` hardening:** ephemeral runtime/scratch the automation can sweep into a commit (`auto-dispatch-state.json`, `convergence-test.jsonl`, `convergence/canary-events.jsonl`, root `steptoe_*` scratch).

Net: 6 files, +15 / −3647. The three-doors *image assets* were investigated and **kept** — `image-pool.js`'s keyword map made them look orphaned, but `image-generation.js` still writes that dir and the PNGs are served statically.
