# Innovator Evidence Method

The legacy Seven audit is only a minimum smoke check. Lantern OS uses the
operator's newer Innovator method for release decisions.

## Method

1. Name the artifact or surface.
2. State the claim it makes.
3. Tie the claim to source evidence.
4. Classify the capability being asserted.
5. Classify the boundary or consent rule.
6. Record validation evidence.
7. Promote, hold, revise, or reject.

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

## Hard Stops

- No bootloader, partition, or firmware mutation by an agent.
- No medical, legal, financial, or governance authority claims without explicit
  boundary language.
- No production-ready claim without validation evidence.

