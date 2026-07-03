---
author: Alex Place
created: 2026-06-23
updated: 2026-07-03
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
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted (Alex Place, 2026-07-02) |
| [0002](0002-single-convergence-core.md) | Single Convergence Core — reject sprawl | Accepted (Alex Place, 2026-07-02) |
| [0003](0003-one-canonical-csf-module.md) | One canonical CSF module | Accepted (Alex Place, 2026-07-02) |
| [0004](0004-append-only-memory.md) | Append-only JSONL + CSF as the only memory | Accepted (Alex Place, 2026-07-02) |
| [0005](0005-interchangeable-model-providers.md) | Models are interchangeable — provider abstraction | Accepted (Alex Place, 2026-07-02) |
| [0006](0006-dual-boot-worktree-topology.md) | Dual-boot 4177/4178 worktree topology | Accepted (Alex Place, 2026-07-02) |
| [0007](0007-monoworkstream-one-pr-lane-per-agent.md) | Monoworkstream — one PR lane per agent | Accepted (Alex Place, 2026-07-02) |
| [0008](0008-end-product-personal-ai-wrapper.md) | End product is a personal AI wrapper — capabilities are Tools + Skills | Accepted (Alex Place, 2026-07-02) |
| [0009](0009-one-routing-contract-cloud-primary-coding.md) | One routing contract — cloud-primary coding | Accepted (Alex Place, 2026-06-28) |
| [0010](0010-verify-gated-continual-learning-last-resort.md) | Distillation is a deferred last resort — verify-gated, benchmark-never-the-target | Accepted (Alex Place, 2026-07-02) |
| [0011](0011-proprietary-sigma0-base-model.md) | Own a proprietary Σ₀ base model — fork PLT, adapter-only weights, council + CSF native | Proposed (awaiting Alex's approval) |
| [0012](0012-nested-adaptive-reason.md) | Nested adaptive Reason — Q-exit (within-model) x fidelity escalation (cross-model) | Proposed (awaiting Alex's approval) |
| [0013](0013-subsystem-register-one-loop-gate.md) | Subsystem register + one-loop gate — every surface names a loop stage or is scheduled for extraction | Accepted (Alex Place, 2026-07-02) |
| [0014](0014-unisona-desktop-launcher.md) | unisona.ai desktop — a thin signed launcher over the one Core, not an Electron repackage | Accepted (Alex Place, 2026-07-02) |
| [0015](0015-qwen-teacher-verified-distillation.md) | Qwen-teacher verified distillation into Ouro — proposer, not imitation; execution is the teacher of record | Proposed (awaiting Alex's approval) |
| [0016](0016-provider-agnostic-oss-auth.md) | Provider-agnostic OSS auth — one identity + provider registry (local scrypt + Google + Discord + Patreon), verified-both linking | Accepted (Alex Place, 2026-07-02) |
| [0017](0017-surprise-gated-decoding.md) | Surprise-gated decoding — mid-generation grounding intervention (CSF retrieval + web search + tool call) when rolling surprise crosses calibrated threshold | Accepted (Alex Place, 2026-07-02) |
| [0019](0019-ibkr-connectivity-client-portal-gateway.md) | IBKR connectivity — Client Portal Web API via local gateway, read-only (replaces the fabricated api.ibkr.com bearer-token path) | Proposed (awaiting Alex's approval) |

<!-- Add new ADRs to this table on merge. -->
