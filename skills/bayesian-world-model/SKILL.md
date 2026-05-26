---
name: bayesian-world-model
description: Bayesian world-model skill for the real-time polled Lantern RAG dollhouse. Use when Codex needs to maintain priors, evidence classes, likelihood updates, confidence tables, live repo/API polling, belief ledgers, forecasts, or decision confidence across Lantern OS, COMET LEAP, Archive Commons, server-farm, phone, dual-boot, and shareholder surfaces.
---

# Bayesian World Model

Use this skill from `C:\tmp\lantern-os` when updating the real-time polled
dollhouse.

## Belief Loop

1. Define the claim.
2. Assign prior confidence and source.
3. Poll current evidence.
4. Classify evidence quality.
5. Estimate likelihood of evidence if claim is true vs false.
6. Update confidence.
7. Record uncertainty and missing observations.
8. Decide: promote, hold, reject, or poll again.

## Evidence Classes

| Class | Meaning | Default Weight |
|---|---|---:|
| `local_verified` | local file/git/test output observed now | high |
| `official_source` | current official docs/API/source | high |
| `github_metadata` | repo metadata from GitHub | medium-high |
| `source_repo_dirty` | exists but dirty or unreviewed | medium |
| `operator_asserted` | user statement not yet verified | medium |
| `web_secondary` | secondary web source | medium-low |
| `projection` | forecast or business estimate | low |
| `unknown` | unclassified | hold |

## Polling Surfaces

- Git status and remotes.
- GitHub repo metadata.
- Skill validation.
- PDF header/text extraction.
- Asset hashes.
- Archive.org / Wayback metadata batches.
- Server-farm inventory.
- iPhone/phone edge-node state.
- Dual-boot readiness.
- v1.0.0 readiness gates.

## Belief Ledger

Write active claims to:

```text
data/world-model/belief-ledger.jsonl
```

Each line should contain:

```json
{
  "claim": "Lantern OS remote is pushed",
  "prior": 0.8,
  "evidence": "git status and remote check",
  "evidenceClass": "local_verified",
  "posterior": 0.99,
  "decision": "promote",
  "timestamp": "ISO-8601"
}
```

## Decision Rule

- `>= 0.90`: promote if no boundary blocks it.
- `0.70-0.89`: candidate; needs validation or operator review.
- `0.40-0.69`: keep in sprint backlog.
- `< 0.40`: reject or quarantine.
- boundary present: hold regardless of confidence.
