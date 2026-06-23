---
adr: 0006
title: Dual-boot 4177/4178 worktree topology
status: Proposed
date: 2026-06-23
deciders: Alex Place
approved-by: pending
supersedes: none
superseded-by: none
---

# ADR-0006: Dual-boot 4177/4178 worktree topology

## Status

Proposed — awaiting approval from Alex Place.

## Context

Development needs to test the current branch *without* taking down the stable system the owner
(and live traffic via the Cloudflare tunnel) depends on. Running dev edits against the same
checkout that serves stable would mean every WIP change is instantly live, and a broken branch
takes the whole system down. The fleet's automation also resets/auto-commits the main checkout,
so it is an unsafe place to serve from.

## Decision

Run **two servers from two separate git worktrees**:

- **Port 4177 — stable**: served from worktree `C:/dev/lantern-os-stable` (tracks `master`).
  Auto-deploys `master` every ~5 min via a scheduled task (reset → restart-if-code → healthcheck
  → rollback).
- **Port 4178 — dev**: served from worktree `C:/dev/lantern-os-dev` (current branch, hot-reload).

Both are launched via `scripts/Start-DualServers.ps1`. The **main checkout is not a server** —
edits there do not change what 4177/4178 serve; to test in preview you copy files into the
serving worktree (or commit + let auto-deploy pick it up). API keys live in persistent Windows
Machine/User environment, hydrated before launch.

## Options Considered

### Option A: Two worktrees, two ports (chosen)
**Pros:** dev never endangers stable; stable mirrors `master` automatically with rollback; clean
separation of "what's live" vs "what I'm hacking on."
**Cons:** more moving parts (two checkouts, a scheduler); edits in the main checkout don't appear
in either server, which surprises newcomers.

### Option B: Single server, branch-switch to test (rejected)
**Cons:** testing dev takes stable offline; a broken branch breaks live; automation churning the
checkout fights the server.

### Option C: Containers per environment (rejected for now)
**Cons:** heavier than a solo Windows box needs; worktrees give the same isolation with native
hot-reload and no image rebuild.

## Trade-off Analysis

The cost is operational complexity (two worktrees + a deploy task). The benefit is that the
owner's always-on system is structurally protected from development — the single most important
property for a system that fronts live traffic. Worktrees deliver container-grade isolation at
near-zero overhead on a single machine.

## Consequences

- **Positive:** stable stays up while dev iterates; `master` auto-deploys with healthcheck +
  rollback; clear "live vs WIP" boundary.
- **Negative / trade-offs:** main-checkout edits are invisible to the servers (must copy/commit);
  more processes to manage; keys must be hydrated from env before launch or providers come up
  empty.
- **Follow-ups:** keep [QUICKSTART.md](../QUICKSTART.md) / [DEV-SERVER-WORKTREE.md](DEV-SERVER-WORKTREE.md)
  authoritative for launch + env hydration.

## Alternatives considered

See Options. "Do nothing / single server" couples dev risk to stable uptime.

## Evidence

| Claim | Evidence (file:line / commit / PR) | Confidence | Source |
|---|---|---|---|
| 4177 stable / 4178 dev from separate worktrees | [QUICKSTART.md](../QUICKSTART.md), [DEV-SERVER-WORKTREE.md](DEV-SERVER-WORKTREE.md) | High | project docs |
| Same server.js picks host by env | [`server.js:69-70`](../apps/lantern-garage/server.js) | High | code |
| Launch via Start-DualServers.ps1 | `scripts/Start-DualServers.ps1` | High | repo survey |
| Stable auto-deploys master every ~5 min w/ rollback | scheduled task `KeystoneAutoDeployStable` + `C:\dev\deploy-stable-from-master.ps1` | Medium | operator memory |
| lantern-os.net → Cloudflare tunnel → local 4177 | [PATREON-OAUTH.md](PATREON-OAUTH.md); tunnel config | Medium | project doc + memory |
