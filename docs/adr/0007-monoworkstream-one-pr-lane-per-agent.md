---
adr: 0007
title: Monoworkstream — one open PR lane per agent
status: Proposed
date: 2026-06-23
deciders: Alex Place
approved-by: pending
supersedes: none
superseded-by: none
---

# ADR-0007: Monoworkstream — one open PR lane per agent

## Status

Proposed — awaiting approval from Alex Place.

## Context

Multiple agents (`claude/`, `gemini/`, `codex/`, `devin/`, `grok/`, `openai/`, …) commit
concurrently. Without a rule, a single agent opens many parallel branches/PRs, producing
review overload, merge conflicts between an agent's own lanes, and half-finished work scattered
across branches. The owner is the sole reviewer/merger and cannot babysit an unbounded PR queue.

This is a *git/PR throughput* constraint, distinct from runtime concurrency: many agents running
in parallel slots is a desired feature ([`.claude/agent-slots.json`](../../.claude/agent-slots.json)).
The limit is on open PR lanes, not active agents.

## Decision

Each agent prefix gets **one open PR lane at a time**. A second branch from the same prefix is
blocked until that agent's first PR is merged/closed. All lanes run concurrently across agents.

- Branch prefixes map to lanes (`claude/` → Claude lane, etc.); anything else is the Human lane.
- Commits/pushes to a branch that **already has an open PR** are always allowed.
- `gh-pages`, `master`, `dev` are exempt. Direct push to `master` is blocked (open a PR, or
  `OVERRIDE_MERGE=1`).
- Slop commit messages (empty, < 8 chars, "wip", "placeholder", "temp", …) are blocked.
- Enforced by git hooks installed via
  [`scripts/Install-MonoworkstreamHooks.ps1`](../../scripts/Install-MonoworkstreamHooks.ps1).
- Bypasses for legitimate cases: `SKIP_MONOWORKSTREAM=1` (skip lane + slop checks),
  `OVERRIDE_MERGE=1` (allow direct master push).

## Options Considered

### Option A: One PR lane per agent prefix (chosen)
**Pros:** bounded, reviewable queue; an agent finishes before starting new work; conflicts between
an agent's own branches are eliminated; clear lane ownership.
**Cons:** an agent blocked on a stuck PR can't start fresh work without a bypass; needs hooks +
documented escape hatches (automation often needs `SKIP_MONOWORKSTREAM=1`).

### Option B: Unlimited branches per agent (rejected)
**Cons:** review overload; intra-agent merge conflicts; WIP sprawl across branches.

### Option C: Trunk-based, direct commits to master (rejected)
**Cons:** no review gate; concurrent agents stomp `master`; loses the convergence/verify
checkpoint a PR provides.

## Trade-off Analysis

The rule trades an agent's freedom to fan out for a queue the single owner can actually review.
For a solo-reviewed, many-agent repo, reviewer attention is the bottleneck — so bounding open
lanes (not active agents) is the right lever. The documented bypasses keep automation unblocked
when the rule would otherwise deadlock.

## Consequences

- **Positive:** predictable, finite PR queue; lanes are independent; less rework; master stays
  protected.
- **Negative / trade-offs:** a blocked lane needs a bypass to proceed; contributors must know the
  escape hatches; the version/changelog gate interacts with `SKIP_MONOWORKSTREAM`.
- **Follow-ups:** keep [AGENTS.md](../../AGENTS.md) / [CLAUDE.md](../../CLAUDE.md) authoritative for the
  lane table and bypass flags; this very ADR series ships under the `claude/` lane with
  `SKIP_MONOWORKSTREAM=1` because that lane already has an open PR.

## Alternatives considered

See Options. "Do nothing" yields the unbounded-queue failure mode.

## Evidence

| Claim | Evidence (file:line / commit / PR) | Confidence | Source |
|---|---|---|---|
| One open PR lane per agent prefix | [CLAUDE.md](../../CLAUDE.md) "Per-Agent Workstream Rule" | High | project doc |
| Prefix → lane mapping table | [CLAUDE.md](../../CLAUDE.md) lane table | High | project doc |
| Commits to a branch with an open PR allowed | [CLAUDE.md](../../CLAUDE.md) rules | High | project doc |
| Hooks install + bypass flags | [`scripts/Install-MonoworkstreamHooks.ps1`](../../scripts/Install-MonoworkstreamHooks.ps1); `SKIP_MONOWORKSTREAM` / `OVERRIDE_MERGE` | High | code + doc |
| Active-agent concurrency is a separate, allowed feature | [`.claude/agent-slots.json`](../../.claude/agent-slots.json); [CLAUDE.md](../../CLAUDE.md) note | High | code + doc |
