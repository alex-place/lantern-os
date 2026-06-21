---
author: Alex Place
created: 2026-05-26
updated: 2026-06-20
---

# Keystone OS Convergence Loop

This is the operating method for Keystone OS. It replaces skeleton-only staging
and the legacy Seven smoke check as the release decision path.

## Rule

Every loop must fix the first 2-4 actionable issues before adding new surfaces,
unless the operator explicitly holds them.

## The 12 Steps

1. Inspect current repo state.
2. Identify source repos and dirty state.
3. Read manifests and open issues.
4. State the next safest objective.
5. Retire old stuff: remove, hold, or label deprecated surfaces so they do
   not look release-ready.
6. Map claims to evidence.
7. Classify capability, boundary, and rollback path.
8. Run the cheapest validation checks.
9. Fix the first 2-4 actionable failures.
10. Re-run validation.
11. Record evidence and remaining blockers.
12. Promote, hold, or reject artifacts.

## Definitions

Actionable issue:

- local file missing;
- manifest inconsistent with observed state;
- validation script failure;
- stale legacy reference that can be corrected safely;
- missing rollback, boundary, or evidence note.

Held issue:

- needs operator decision;
- needs physical action, such as dual boot installation;
- needs secret, account login, external purchase, or hardware;
- would require destructive mutation.

## Promotion States

- `candidate`: exists and is worth reviewing.
- `validated`: passed local checks.
- `held`: blocked by operator or physical action.
- `promoted`: copied into this repo with manifest evidence.
- `retired`: intentionally removed from release path.

