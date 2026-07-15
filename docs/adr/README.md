---
author: Alex Place
created: 2026-06-23
updated: 2026-07-03
---

# Architecture Decision Records (ADRs)

This directory holds the **canonical, append-only log of architectural decisions** for
unisona.ai. An ADR captures *one* decision: the context that forced it, the choice made,
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

Numbering and index membership are enforced mechanically: the `ADR registry lint` PR gate
(`node scripts/lint-adr-registry.mjs`) fails on duplicate 4-digit numbers, on an ADR file
missing from the index table below, and on an index status cell that contradicts the file's
own `status:` declaration. Numbers have collided three times under concurrent PRs
(3×0001, 2×0008, 2×0023) — if the gate fires on your PR, renumber to the next free number
against the *merged* master, not your branch's base.

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
| [0010](0010-verify-gated-continual-learning-last-resort.md) | Distillation is a deferred last resort — verify-gated, benchmark-never-the-target | Proposed |
| [0011](0011-proprietary-sigma0-base-model.md) | Own a proprietary Σ₀ base model — fork PLT, adapter-only weights, council + CSF native | Accepted (Alex Place, 2026-07-04) |
| [0012](0012-nested-adaptive-reason.md) | Nested adaptive Reason — Q-exit (within-model) x fidelity escalation (cross-model) | Accepted (Alex Place, 2026-07-02) |
| [0013](0013-subsystem-register-one-loop-gate.md) | Subsystem register + one-loop gate — every surface names a loop stage or is scheduled for extraction | Accepted (Alex Place, 2026-07-02) |
| [0014](0014-unisona-desktop-launcher.md) | unisona.ai desktop — a thin signed launcher over the one Core, not an Electron repackage | Accepted (Alex Place, 2026-07-02) |
| [0015](0015-qwen-teacher-verified-distillation.md) | Qwen-teacher verified distillation into Ouro — proposer, not imitation; execution is the teacher of record | Accepted (Alex Place, 2026-07-04) |
| [0016](0016-provider-agnostic-oss-auth.md) | Provider-agnostic OSS auth — one identity + provider registry (local scrypt + Google + Discord + Patreon), verified-both linking | Accepted (Alex Place, 2026-07-02) |
| [0017](0017-surprise-gated-decoding.md) | Surprise-gated decoding — mid-generation grounding intervention (CSF retrieval + web search + tool call) when rolling surprise crosses calibrated threshold | Accepted (Alex Place, 2026-07-02) |
| [0018](0018-web-tier-split-and-cloud-multi-tenancy.md) | Split delivery into a hosted multi-tenant web tier and a full local desktop app — one Core, two profiles | Accepted (Alex Place, 2026-07-03) |
| [0019](0019-ibkr-connectivity-client-portal-gateway.md) | IBKR connectivity — Client Portal Web API via local gateway, read-only (replaces the fabricated api.ibkr.com bearer-token path) | Accepted (Alex Place, 2026-07-04) |
| [0020](0020-ibkr-live-order-placement.md) | IBKR live order placement — gated, dry-by-default | Proposed (awaiting Alex's approval) |
| [0021](0021-serving-substrate-retain-ouro-custom-loop.md) | Serving substrate — retain the Ouro/Σ₀ custom transformers loop; reject an engine port (no adaptive-depth/hidden-state serving exists); defer a Qwen3.5-4B base swap | Accepted (Alex Place, 2026-07-04) |
| [0022](0022-ibkr-per-user-self-service-oauth.md) | Per-user IBKR connection via self-service OAuth 1.0a | Accepted (operator-directed, 2026-07-05) — explicit approval record pending |
| [0023](0023-default-profile-foregrounds-the-loop.md) | The default profile foregrounds the loop — extensions are opt-in behind flags | Proposed (awaiting Alex's approval) |
| [0024](0024-sigma0-frontier-training-program.md) | Σ₀ frontier training program — honesty-native pretraining, phased PILOT→BASE→FRONTIER with kill-gates; certificate as training-time spec; distills to the ≤8GB serving artifact | Proposed (awaiting Alex's approval) |
| [0025](0025-rlvr-dreaming-continual-updates-double-gated.md) | RLVR + generative-replay ("dreaming") continual weight updates, double-gated by a frozen exec-holdout (load-bearing) + the Σ₀ stability cert (cheap early-abort); the mechanism for ADR-0010's verify-gated last-resort path | Accepted (Alex Place, 2026-07-07) |
| [0026](0026-ternary-serving-artifact-distillation-target.md) | Ternary (1.58-bit / W1.58A8) as the distillation-target format for the ≤8GB serving artifact — BitDistill-style QAT-distill from the FP teacher, accepted by the Σ_θ gate, served as a layer-level kernel swap inside the custom Ouro loop (resolves ADR-0024 Phase-2 / D7) | Accepted (Alex Place, 2026-07-07) |
| [0027](0027-one-click-broker-oauth2.md) | One-click broker connect — per-user OAuth2 (Alpaca now, IBKR when they ship it); replaces the five-step IBKR key-upload wizard with provider login → Approve | Accepted (Alex Place, 2026-07-15) |

<!-- Add new ADRs to this table on merge. -->
