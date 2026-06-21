### Added
- Orchestration dashboard (`/orchestration.html`) is now a real Convergence
  surface, not stubs. The Act half shows live queue counts (from the on-disk
  work-queue dirs) and the real 11-slot agent roster (from `.claude/agent-slots.json`).
  The Verify half adds **CI Lanes** (live `gh` PR status per monoworkstream lane,
  shell-free via `safeExec`) and **Provider Merit** (the `compositeScore`
  leaderboard that routes the swarm). A new **Needs Human** panel surfaces the
  Reason/Converge gate — open PRs awaiting review and pending work to route —
  each with a one-click hand-off to **Keystone Chat** (`/dream-chat.html?seed=`)
  or a copy-ready prompt for **Claude Code**.
- Dream-chat composer accepts a `?seed=` query param: other surfaces can pre-fill
  a task prompt for the human to review/edit (never auto-sent).

### Changed
- `/api/queue/status` and `/api/queue/agents` now read real data (queue dirs +
  agent-slots config) instead of returning hardcoded zeros and a single fake
  `claude` slot. New `/api/queue/pr-lanes` endpoint exposes per-lane CI status.
- **Pending work is now sourced from open GitHub issues** (the single source of
  truth), not a hand-maintained local file store that goes stale. Priority is
  derived from `p0`/`p1`/`p2` labels; issues already claimed by an agent
  (tracked in `assigned/`) are excluded. assigned/completed/failed remain
  file-based — that's in-flight execution state GitHub doesn't track.

### Fixed
- Orchestration work-queue list called the non-existent `/api/queue/list/pending`
  path (always 404'd, showed "no pending work"); now uses `?status=pending`.
- Stale `sigma0-coder-slot` model in `.claude/agent-slots.json`
  (`lantern-sigma0-coder-v2` → `ouro:latest`), matching the Σ₀-K1 kernel spec and
  the #874 Ouro default-coder deprecation.
