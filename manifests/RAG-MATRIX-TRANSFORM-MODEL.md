# RAG Matrix Transform Model

Status: architecture correction and storage/transform rule.

## Correction

A large matrix is valid for RAG when it is used for storing, indexing, projecting, filtering, joining, or transforming knowledge states.

The problem is not matrix size. The problem is confusing a large RAG/storage matrix with a large execution queue.

A `3^12 - 1` space can fit Lantern OS if it is treated as a sparse, addressable transform space over the 12 Lantern/COMET/Arc frames, not as 531,440 tasks to run blindly.

## Internal Values Versus Output Views

Internal matrix values may be continuous normalized values in this range:

```text
-1.0 <= value <= 1.0
```

The stored internal value is a latent score, not the final user-facing truth.

Outbound views may change dynamically based on:

- viewer role;
- current evidence freshness;
- retrieval context;
- selected projection lens;
- held boundaries;
- fallback/SPOF state;
- confidence decay;
- live validation receipts;
- route/runtime/tool availability;
- operator approval state.

Therefore, the matrix should separate:

```text
stored latent value -> view transform -> rendered/output value
```

A value stored as `0.72` may render as:

- `verified candidate` in an engineering view;
- `hold` in a release view if a boundary is present;
- `stale` if the validation receipt has expired;
- `needs fallback` if the SPOF matrix says primary-only;
- `do not claim` if public/runtime validation failed.

## Interpretation

For a ternary compressed view:

```text
-1 = blocker / contradiction / regression / unavailable
 0 = unknown / candidate / unverified / no signal
+1 = verified / improving / promotable / available
```

For internal storage, values between the endpoints are preferred:

```text
-1.00 hard contradiction / blocked / failed
-0.50 weak negative evidence / degrading
 0.00 unknown / no signal / balanced
+0.50 weak positive evidence / improving
+1.00 verified / strong positive evidence
```

The 3-state view is a projection, not a storage limit.

## 12 Axes

Use the current Arc Reactor / COMET 12-step frame as the default axis set:

| Axis | Frame | Typical RAG State |
|---:|---|---|
| 1 | past control-plane work | repo/control-plane evidence |
| 2 | past COMET LEAP/PDF/art work | artifact and asset evidence |
| 3 | past RAG/memory work | index, hash, chunk, source state |
| 4 | present dual-boot/device state | hardware/readiness/held boundary |
| 5 | present wallet/cash state | ledger/invoice/payment truth |
| 6 | present offer/pitch state | product and outreach state |
| 7 | present cockpit/surface state | local/public UI availability |
| 8 | present confidence/power-state | posterior/confidence/risk state |
| 9 | store/distribution lane | local/public/store release state |
| 10 | old repo/workstream intake | dependency class and clone state |
| 11 | Archive/commons/media rights lane | rights/download/storage state |
| 12 | future fleet/server/device outcomes | capacity/fleet/hardware forecast state |

## Storage Shape

Each RAG chunk or surface can carry a latent vector record:

```json
{
  "id": "surface:hff-render-os",
  "kind": "public_route",
  "source": "human-flourishing-frameworks.onrender.com/os",
  "latentVector12": [0.85, 0.0, 0.0, 0.0, 0.0, 0.0, -0.9, -0.7, 0.0, 0.0, 0.0, 0.0],
  "evidenceClassByAxis": ["github_metadata", "unknown", "unknown", "unknown", "unknown", "unknown", "operator_asserted", "operator_asserted", "unknown", "unknown", "unknown", "unknown"],
  "spofState": "single_point_risk",
  "decision": "fallback_first",
  "safeClaim": "route is currently not found; local fallback remains available",
  "validationReceipt": "manifests/HFF-RENDER-OS-ROUTE-404.md"
}
```

The record may be rendered through different views:

```text
engineering_view(latentVector12, evidence, receipts) -> actionable technical state
release_view(latentVector12, held_boundaries, SPOF) -> promote/hold/reject
operator_view(latentVector12, fallbacks, next_actions) -> what to do next
public_view(latentVector12, validations, approvals) -> safe external claim
```

## View Transform Rule

Never expose raw matrix values as final truth without the view transform.

A view transform must consider:

```text
input latent value
+ evidence class
+ evidence freshness
+ validation receipt
+ held boundary
+ SPOF/fallback state
+ dependency state
+ operator approval state
= rendered value / label / decision
```

Example:

```text
latent: +0.82
surface: public route
validation: live HTTP 404
SPOF: primary route only
release_view: hold
operator_view: fix route or use local fallback
public_view: unavailable / not fixed
```

## Transform Operations

Allowed transforms:

| Transform | Purpose |
|---|---|
| `chunk_to_latent_vector` | classify a repo/file/claim/surface into 12-axis continuous state |
| `latent_to_ternary_view` | compress continuous values into -1/0/+1 for overview |
| `latent_to_release_view` | apply held boundaries, receipts, SPOF, and approvals |
| `latent_to_operator_view` | produce next safe action and fallback |
| `vector_to_gap_list` | identify missing/blocked axes |
| `vector_to_next_action` | choose the smallest safe next action |
| `vector_to_spof` | detect primary-only or missing fallback states |
| `vector_to_confidence` | produce Bayesian candidate/promote/hold decision |
| `vector_join_dependency` | combine repo dependency state with control-plane state |
| `end_to_beginning_update` | feed actual results back into priors for the next loop |

Disallowed transforms:

| Transform | Reason |
|---|---|
| `all_states_to_tasks` | turns storage space into fake work queue |
| `state_count_to_capacity_claim` | a large matrix does not prove agents, revenue, users, or runtime capacity |
| `missing_evidence_to_promote` | absence of contradiction is not proof |
| `raw_value_to_public_claim` | raw latent value ignores view context and held boundaries |
| `fallback_unchecked_to_ready` | fallback must be exercised before readiness claim |

## Sparse Rule

Do not materialize all 531,440 states unless there is a direct need and a bounded output.

Prefer sparse storage:

```text
surface_id -> latentVector12 -> evidence refs -> view transforms -> decision -> receipt
```

Materialize only:

- states that correspond to real chunks, files, routes, repos, assets, tasks, or claims;
- aggregate counts by axis/state;
- top-N risks or next actions;
- validation receipts and changed surfaces.

## End-To-Beginning Loop

The matrix becomes useful when it loops actual outcomes back to the beginning:

```text
claim/surface -> latentVector12 -> view transform -> decision -> action -> validation receipt -> updated latentVector12 -> next prior
```

This is the RAG-safe version of the end-to-beginning loop.

## Fit Decision

| Claim | Decision | Reason |
|---|---|---|
| `3^12 - 1` as RAG storage/transform state space | `promote` | it can encode non-empty 12-axis projected states |
| continuous `[-1, 1]` internal values | `promote` | stores nuance better than ternary-only labels |
| dynamic output/view values | `promote` | rendering must account for context, freshness, SPOF, and boundaries |
| `3^12 - 1` as literal task queue | `reject` | creates fake work and operational noise |
| sparse vector per surface/chunk/claim | `promote` | supports retrieval, transforms, ranking, and validation |
| dense exhaustive materialization | `hold` | only use for bounded experiments or generated analysis, not default ops |

## Implementation Target

Future code should add a small matrix module before any heavy generation:

```text
data/rag-matrix/matrix-records.jsonl
scripts/Convert-RagChunkToMatrixRecord.ps1
scripts/Test-RagMatrixRecords.ps1
manifests/validation/RAG-MATRIX-LATEST.json
```

Initial validation should check:

- vector length is 12;
- values are numeric and inside `[-1, 1]`;
- each record has source, evidence class, decision, and safe claim;
- view transforms are named and reproducible;
- no raw latent value is exposed as a public/release claim without transform;
- no record upgrades a held boundary without validation receipt;
- no aggregate count is used as proof of runtime capacity.
