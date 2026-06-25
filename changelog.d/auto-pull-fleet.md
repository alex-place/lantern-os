### Orchestration: auto-pull fleet loop with dashboard kill switch

- The gated auto-pull loop (`lib/auto-dispatch.js`) gains **runtime control** — a kill switch on the orchestration board flips the autonomous loop on/off live (no restart), persisted across restarts, overriding the env default.
- New **one-PR-per-lane guard**: the loop skips a tick if the claude lane already has an open PR, so it never wastes a run the monoworkstream rule would block.
- Truthful status: last pick/result, run history, next-run, and the active guardrails, via `GET /api/convergence/auto-dispatch/status` + `POST .../toggle`, surfaced in an "Auto-Pull Fleet" panel.
- Still off by default; serialized (one in flight), cloud-paused, draft-PRs-only, nothing auto-merges.
