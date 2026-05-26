# AGENTS

This repository is the clean Lantern OS v1.0.0 staging repo.

## Operating Rules

- Inspect before editing.
- Keep changes small and reviewable.
- Do not import dirty worktree state blindly from source repos.
- Do not mutate boot configuration, partitions, firmware boot order, or disks.
- Do not claim v1.0.0 readiness without operator approval.
- Use the Innovator evidence method for promotion decisions.

## Source Repos

- HFF scan repo: `C:\tmp\human-flourishing-frameworks-scan`
- Orchestrator repo: `C:\Users\alexp\Documents\gm-agent-orchestrator`

Both may be dirty. Treat their working tree state as evidence, not as something
to overwrite or reset.

## Promotion Criteria

An artifact can move into this repo when it has:

- source path;
- purpose;
- claim IDs or clear claim summary;
- validation status;
- blockers and rollback notes;
- operator approval status.

## Branching

Use `codex/` branch names for agent work unless the operator asks otherwise.

