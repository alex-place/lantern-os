# Convergence Loop Agent Fleet

Status: merged remote contract
Date: 2026-05-28

## Purpose

Lantern convergence-agent mode runs the existing 12-step convergence loop as a 36-agent matrix.

The 36-agent matrix is a planning, dispatch, and receipt contract. It does not by itself prove that 36 live worker processes are running. Live-worker claims require a current local orchestrator count report.

## Fleet Formula

```text
12 convergence-loop steps x 3 agents per step = 36 ring agents
32 base workers -> 64 elastic worker pool target
```

The 64-worker pool target is capacity planning for the wider fleet. It can host the 36 ring slots plus MCP probes, dashboard health checks, repo review gates, validation retries, and OS review workers.

## Always-Waiting Ring Contract

For each convergence step:

1. Primary agent performs the step.
2. Backup A independently checks evidence and completeness.
3. Backup B checks boundaries, rollback, exposed-endpoint risk, destructive-action risk, and fallback path.
4. The step emits one receipt.

Global convergence consensus:

```text
12 step receipts -> loop summary -> founder/operator approval
```

Founder/operator direction can prioritize, hold, or approve the next action. It cannot erase evidence labels, failed validation, exposed-endpoint boundaries, destructive-action holds, or missing live-worker proof.

## 12-Step Role Matrix

| Step | Primary role | Backup role A | Backup role B |
|---:|---|---|---|
| 1 | Repo-state inspector | Git/status verifier | File-surface verifier |
| 2 | Source-repo scout | Dirty-state checker | Dependency-boundary checker |
| 3 | Manifest reader | Open-issue reader | Stale-reference checker |
| 4 | Objective framer | Safety reviewer | Founder-priority resolver |
| 5 | Retirement agent | Deprecated-surface checker | Quarantine/stub checker |
| 6 | Claim mapper | Evidence linker | Confidence classifier |
| 7 | Boundary classifier | Rollback checker | Capability-state checker |
| 8 | Validation runner | Cheapest-check selector | Environment-limit recorder |
| 9 | Fix agent | Backup fixer | Patch-risk reviewer |
| 10 | Revalidation agent | Regression checker | Receipt checker |
| 11 | Evidence recorder | Blocker recorder | Memory/RAG updater |
| 12 | Promotion judge | Hold/reject judge | Founder-approval router |

## Step Receipt Shape

Each step emits this durable receipt:

```json
{
  "step": 1,
  "stepName": "Inspect current repo state",
  "primaryAgent": "Repo-state inspector",
  "backupA": "Git/status verifier",
  "backupB": "File-surface verifier",
  "evidence": [],
  "claims": [],
  "boundaries": [],
  "validation": "pass | fail | held | not_run",
  "rollback": "short rollback path",
  "nextAction": "smallest useful next move"
}
```

## Claim Boundary

Allowed claims:

- `expectedRingSlots = 36`
- `poolTarget = 64`
- `ringMode = designed`
- `liveWorkerProof = held until a local orchestrator count report exists`

Not allowed without fresh local evidence:

- claiming 36 agents are actively running;
- claiming 64 workers are actively running;
- claiming MCP tools exist from advertised capability alone;
- public release without the review gate;
- v1.0.0 readiness without operator approval and convergence evidence.

## Live Fleet Proof Receipt

Before any public `fleet active` claim, point to and refresh:

```text
manifests/validation/LIVE-FLEET-PROOF-LATEST.json
```

That receipt must include `generatedAt`, `orchestratorBaseUrl`, `mcpHealth`, `toolsVisible`, `workerPoolTarget`, `activeWorkers`, `idleWorkers`, `queuedJobs`, `failedWorkers`, `ringSlotsAssigned`, `ringSlotsHealthy`, `consensusReceipts`, and `claimBoundary`. If any live runtime field is `null`, empty, or `not_observed`, the only allowed public claim remains that the fleet design contract exists; `fleet active` is held until fresh local orchestrator proof fills those fields.

## Validation

Run:

```powershell
python scripts/Test-ConvergenceAgentFleet.py --write-json manifests/validation/CONVERGENCE-FLEET-LATEST.json
```

Expected receipt:

```text
ok=true
loopStepCount=12
roleMatrixRows=12
expectedRingSlots=36
poolTarget=64
claimBoundary=design_contract_not_live_worker_proof
```
