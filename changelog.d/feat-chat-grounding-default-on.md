### Added
- **Σ₀ chat grounding is ON by default** and operator-toggleable. New
  `isVerifyEnabled()` gate (lib/dream-chat.js): an explicit `SIGMA0_VERIFY=true|false`
  env var still wins, otherwise the `chat_grounding` admin flag decides — defaulting
  ON via `isFlagEnabledOr` (same pattern as the Patreon auth gate). Turn it off in
  admin-flags.html or `data/admin/feature-flags.json` without a redeploy. Previously
  the whole verify/refute+revise pass was dark unless `SIGMA0_VERIFY=true` was set.
- Chat responses now feed the fast-layer **grounding calibration** (per-agent
  Brier/trust, lib/grounding-calibration.js) — previously only `/api/convergence`
  wrote that log. Only claims that got an external signal (codebase grep / web search /
  Gemini) record an outcome (`refuted → 0`, confirmed `→ 1`); ungrounded claims are
  skipped (absence of evidence is not an outcome).

### Fixed
- `verifyResponse` was writing convergence records to a stray `apps/data/convergence/`
  tree — its `REPO_ROOT` was one `..` short of the repo root. Records now land in the
  canonical `data/convergence/records.jsonl`, and the codebase grep runs from the real
  repo root.
- The codebase-grep grounding step is now **shell-free and non-blocking** (async
  `execFile`, `shell:false`) — necessary now that grounding runs on every turn: the old
  synchronous `git grep` would block the Node event loop up to 3s/claim, freezing all
  concurrent requests (and the interpolated command string was the kind of exec #873
  set out to eliminate).

### Tests
- `tests/test_chat_grounding.js` (hermetic, `node:test`): gate precedence (env vs
  flag), `calibrationEventsFor` record→event mapping, and the `recordGrounding`→Brier
  round-trip.
