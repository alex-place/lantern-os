---
author: Alex Place
created: 2026-05-26
updated: 2026-06-20
---

# Innovator Evidence Method

Keystone OS uses the operator's Innovator method for release decisions. The old
Seven smoke check is deprecated and must not be treated as a release gate.

## Method

1. Name the artifact or surface.
2. State the claim it makes.
3. Tie the claim to source evidence.
4. Classify the capability being asserted.
5. Classify the boundary or consent rule.
6. Classify the rollback path.
7. Retire or hold legacy surfaces that conflict with the claim.
8. Record validation evidence.
9. Promote, hold, revise, or reject.
10. Re-run the convergence loop before expanding scope.

## Evidence Classes

- `repo_verified`: verified against local files, tests, or git state.
- `source_verified`: verified against source registry or cited external source.
- `operator_asserted`: operator-provided and not independently verified yet.
- `inferred`: reasonable inference from evidence, marked as inference.
- `blocked`: missing evidence, contradiction, or unsafe action.

## Required Release Fields

Each promoted artifact should record:

- source path;
- target path;
- artifact type;
- primary claim;
- evidence class;
- validation command or check;
- validation result;
- known blockers;
- rollback/removal path;
- operator approval status.

## Deprecated Legacy Path

The old Seven audit can remain as historical context in source repos, but
Keystone OS readiness must use `docs/CONVERGENCE-LOOP.md`.

## Hard Stops

- No bootloader, partition, or firmware mutation by an agent.
- No medical, legal, financial, or governance authority claims without explicit
  boundary language.
- No production-ready claim without validation evidence.
