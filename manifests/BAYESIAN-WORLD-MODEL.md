# Bayesian World Model

Status: active dollhouse layer.

The Lantern RAG dollhouse uses a Bayesian world model to keep claims current
under real-time polling. The model does not make the repo magical; it keeps
beliefs honest as evidence changes.

## Claim State Machine

```text
claim -> prior -> poll -> evidence class -> likelihood -> posterior ->
promote | hold | reject | poll again
```

## Poll Cadence

| Surface | Poll | Cadence |
|---|---|---|
| local repo | `git status`, `git remote`, latest commit | every sprint |
| source repos | read-only git status | every sprint |
| skills | `quick_validate.py` | after edits |
| PDFs | header + text extraction | after regeneration/copy |
| assets | SHA256 manifest | after copy |
| GitHub | repo metadata and latest commits | when user says latest/adds |
| Archive/Wayback | metadata batches | explicit batch only |
| hardware | readiness/inventory scripts | operator-triggered |

## Confidence Bands

| Posterior | Meaning | Action |
|---:|---|---|
| `0.90-1.00` | strongly verified | promote unless boundary-held |
| `0.70-0.89` | likely | candidate |
| `0.40-0.69` | mixed | backlog and poll |
| `0.00-0.39` | weak | reject/quarantine |

## Required Ledger

Use `data/world-model/belief-ledger.jsonl` for active claims when a sprint
needs durable belief tracking.

## Boundary Override

Physical disk actions, phone boot claims, rights-gated media downloads, and
v1.0.0 release approval stay held even when confidence is high.
