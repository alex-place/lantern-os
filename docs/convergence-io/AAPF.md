# AAPF — Agent Action Provenance Format

**Module:** [`src/convergence_io/aapf.py`](../../src/convergence_io/aapf.py) · **Principle:** P3 (Provenance / Audit) · **Consumed by:** P6 (Subject Rights), P7 (Incident Response), P9 (Reporting)
**Status:** Implemented + unit-tested. Python reference contract; not on the live JS chat path (see [README](README.md#status-honest)).

## What it is

Every action produces a record tying the **artifact to the actor** with enough detail to
*reproduce the decision*. AAPF is the audit trail under the whole stack — once an action clears
NAP/CCF and routes through PCSF, it leaves an `ActionRecord` behind. P6/P7/P9 (subject-rights
requests, incident response, reporting) are all queries over this ledger.

## Core types / API

- **`ActionRecord`** — one append-only entry: actor (`agent_id`), `action_type`, the artifact,
  inputs/decision context, status, and a content hash (the module imports `hashlib`/`json` to
  make records self-verifying). `to_dict()` for serialization.
- **`ProvenanceLedger`** — the append-only store:
  - `ProvenanceLedger(ledger_path=None)` — optionally backed by a JSONL file (append semantics,
    matching the project's append-only memory rule).
  - `record(action)` — append one `ActionRecord`.
  - `query(agent_id=None, action_type=None, ...)` — filtered read for audits / subject requests.
  - `count_by_status()` — aggregate health view (how many succeeded / failed / denied).

## How it composes

AAPF is the **terminal** step of the gate order — it records the outcome of DCF→NAP→CCF→PCSF→D.
Because it captures the actor, the data class acted on, the provider chosen, and the result, it's
the single source for answering "who did what to which data, and why" without re-running anything.

## Status & gaps

- Implemented with hashed records + a JSONL-backed ledger + query/aggregate; covered by
  [`tests/test_convergence_io.py`](../../tests/test_convergence_io.py).
- The P6/P7/P9 *consumers* (subject-rights export, incident workflow, scheduled reporting) are
  intended queries over `ProvenanceLedger`, not separate shipped surfaces yet.
