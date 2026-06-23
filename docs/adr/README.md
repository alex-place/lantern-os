---
author: Alex Place
created: 2026-06-23
updated: 2026-06-23
---

# Architecture Decision Records (ADRs)

This directory holds the **canonical, append-only log of architectural decisions** for
Keystone OS. An ADR captures *one* decision: the context that forced it, the choice made,
its status, and the consequences we accept by making it.

ADRs are how we keep architectural knowledge from scattering across ~120 ad-hoc docs and
chat logs. If a decision shapes the system's structure, it gets an ADR. If you want to know
*why* the system is the way it is, start here.

## Relationship to other docs

| Doc | Role |
|---|---|
| [CONVERGANCE-SIGMA0-BRIEFING.md](../CONVERGANCE-SIGMA0-BRIEFING.md) | **Immutable North Star** — the constraints ADRs must obey, not themselves an ADR |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | **Current-state snapshot** — what the system *is* today (the "now"), with `file:line` evidence |
| `docs/adr/*.md` | **Decision log** — *why* it became that way, one decision at a time (the "history") |
| [CODEMAP.md](../CODEMAP.md) | Feature/surface roadmap + status table |

ARCHITECTURE.md answers "what is true now"; ADRs answer "what did we decide and why".
When an ADR changes the current state, ARCHITECTURE.md is updated to match.

## Approval gate (required)

**No ADR becomes `Accepted` without the explicit approval of the repo owner (Alex Place).**
Agents and contributors may *draft* ADRs and open PRs for them, but must leave them
`Status: Proposed` and `approved-by: pending`. Only Alex flips an ADR to `Accepted` and fills
`approved-by`. This applies to backfilled ADRs documenting already-made decisions too: the
*decision* may already be in force, but the *record* is not binding until approved.

## How to write an ADR

1. Copy [`0000-template.md`](0000-template.md) to `NNNN-short-kebab-title.md`, using the
   next free 4-digit number.
2. Fill in Context → Decision → Consequences → Alternatives. Keep it short — one decision.
3. Set **Status** to `Proposed` and `approved-by: pending`. Open a PR.
4. **Wait for Alex's explicit approval.** On approval, flip Status to `Accepted` and set
   `approved-by: Alex Place (YYYY-MM-DD)`. Never self-approve.
5. Never edit the decision of an `Accepted` ADR. To change a decision, write a **new** ADR
   that supersedes it, and set the old one's status to `Superseded by ADR-NNNN`.
6. Honor the **External Reality Rule**: every important claim carries evidence — link to a
   real `file:line`, commit, or PR, with a confidence note.

## Status values

- **Proposed** — drafted, under review, **not yet binding**. Default for any new ADR.
- **Accepted** — binding; reflects how the system is built. **Requires Alex's explicit approval.**
- **Superseded by ADR-NNNN** — replaced by a later decision (kept for history).
- **Deprecated** — no longer the chosen approach, with no direct successor.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Proposed (awaiting Alex's approval) |

<!-- Add new ADRs to this table on merge. -->
