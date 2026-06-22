### Fixed
- Update two stale Playwright tests (`work-intent queries` + `!ask`) that were testing the old direct `/api/convergence/agent` POST path; Stage 3 of the stream unification moved both flows through `/api/dream/chat/stream` so the mocks and assertions now reflect that. Fixes a pre-existing CI failure present on master and all PRs.

### Cleanup
- Delete root-level orphan doc copies (`AGENT.md`, `PRIVACY_GOVERNANCE.md`, `ACCESSIBILITY.md`) that were left behind when the canonical versions were moved to `docs/`; the three files were identical to their `docs/` counterparts.
