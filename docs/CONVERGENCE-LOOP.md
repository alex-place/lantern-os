---
author: Alex Place
created: 2026-05-26
updated: 2026-06-20
---

# unisona.ai Convergence Loop

This is the operating method for unisona.ai. It replaces skeleton-only staging
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


## The `!convergance` chat command (Converge surface)

(Absorbed from `skills/convergence/SKILL.md`, 2026-07-16. Implementation:
`apps/lantern-garage/lib/dream-chat.js` — `handleConvergenceCommand`,
`_deriveConvergenceQuery`, `_appendConvergenceRecord`.)

- **`!convergance`** — synthesize recent entries into ONE grounded insight; the
  query derives deterministically from salient themes (no extra LLM call), the
  live web is searched (MCP → keyless DuckDuckGo/Wikipedia fallback), and the
  synthesis cites `[n]` sources rather than inventing direction.
- **`!convergance <topic>`** — same, grounded on an explicit topic.
- **`!convergance log an issue <title>`** — file a GitHub issue shell-free via
  `safeExec`.

Every run appends a **Convergence Record** to `data/convergence/records.jsonl`:

```json
{ "hypothesis": "...", "evidence": ["entries…", "source URLs…"], "sources": [],
  "grounded": true, "grounding_query": "...", "result": "...",
  "confidence": 0.0, "verified": true, "loop_stage": "Converge", "tags": [] }
```

**Grounded vs. ungrounded is explicit:** with live sources the record is
`grounded:true, verified:true` and earns higher confidence; when search fails
the synthesis degrades honestly to `grounded:false, verified:false`, confidence
capped low, tag `ungrounded` — a record never overstates an un-anchored claim.
One synthesis path, one record store (records.jsonl + CSF archive) — this
surface must not grow into a separate engine.
