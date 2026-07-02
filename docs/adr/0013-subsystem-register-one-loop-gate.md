---
adr: 0013
title: Subsystem register + one-loop gate — every surface names a loop stage or is scheduled for extraction
status: Proposed
date: 2026-07-01
deciders: Alex Place
approved-by: pending
supersedes: none
superseded-by: none
---

<!--
  APPROVAL GATE: leave status `Proposed` and approved-by `pending`. An ADR is not
  binding until Alex Place explicitly approves it; only then set status `Accepted`
  and approved-by `Alex Place (YYYY-MM-DD)`. Never self-approve.
-->

# ADR-0013: Subsystem register + one-loop gate — every surface names a loop stage or is scheduled for extraction

> **Consolidation note.** This ADR replaces three overlapping drafts of the same
> decision added by PR [#1813](https://github.com/alex-place/lantern-os/pull/1813)
> (`0001-subsystem-register-one-loop-gate.md`, `0001-subsystem-register.md`,
> `adr-001-subsystem-one-loop-audit.md`, plus a stray copy in a top-level `adr/`
> directory), all of which collided with the canonical ADR-0001 number. One decision,
> one file, next free number.

## Status

Proposed — awaiting approval from Alex Place.

## Context

Issue [#1557](https://github.com/alex-place/lantern-os/issues/1557) ([SCOPE-1], from the
grade card that rated architectural scope **D+**) named the biggest gap: the running app —
trading, Discord bot, radio/lounge, creator tools, MCP tools, dozens of public HTML
surfaces — had accreted top-level subsystems with no declared relationship to the North
Star's one loop (`Observe → Remember → Reason → Act → Verify → Converge`,
[CONVERGANCE-SIGMA0-BRIEFING.md](../CONVERGANCE-SIGMA0-BRIEFING.md)). The feature gate
("name the loop stage you improve, or don't add it") had no teeth: nothing recorded which
surfaces *are* the loop and which are extensions beside it, so sprawl was invisible and
unpoliceable.

Loop stage this touches: **Converge** (reject sprawl; shrink and classify the surface area).

## Decision

We will maintain a **subsystem register** that classifies every top-level subsystem and
public surface, and gate merges on it:

1. **Every top-level `public/*.html` surface is registered as exactly one of:**
   - **CORE** — directly serves exactly one named loop stage
     (Observe / Remember / Reason / Act / Verify / Converge), or
   - **EXTENSION** — an optional capability beside the loop, named by module cluster and
     (where applicable) gated by a feature flag.
   A surface that fits neither is scheduled for **extraction or removal** — it may not
   simply persist unclassified.

2. **The register is code, not a document.** The single source of truth is
   [`apps/lantern-garage/lib/surface-registry.js`](../../apps/lantern-garage/lib/surface-registry.js).
   A markdown table would drift; a code registry is enforceable.

3. **The gate is enforced by tests, not by review vigilance:**
   - the contract test
     [`apps/lantern-garage/test/surface-boundary.test.js`](../../apps/lantern-garage/test/surface-boundary.test.js)
     (`npm run test:boundary`) fails if any public surface is unclassified;
   - the registry-aware orphan audit
     [`scripts/find-orphan-pages.mjs`](../../scripts/find-orphan-pages.mjs)
     (`npm run audit:orphans`, issue #1558) fails only on *undeclared* orphans — a new
     top-level page that is neither linked nor classified, i.e. genuine sprawl.

4. **Moving a surface between tiers is a deliberate edit** to the registry, reviewed like
   any other boundary change. The registry records the *current* boundary, not a target.

## Consequences

- **Positive:** the North Star's anti-sprawl rule becomes auditable and gateable instead of
  aspirational; every shipped surface names a loop stage or carries an explicit
  extension/flag classification; new sprawl fails CI rather than accreting silently;
  onboarding and refactoring get a definitive inventory.
- **Negative / trade-offs:** the registry must be maintained by hand when surfaces are
  added/renamed (the contract test makes forgetting loud, not impossible to attempt);
  classification forces occasionally-uncomfortable extraction/removal decisions;
  non-HTML subsystems (bots, background services) are only covered indirectly today.
- **Follow-ups:** extend registration beyond HTML surfaces to background services and bots;
  keep the extension flag map in `lib/feature-graph.js` aligned with the registry.

## Alternatives considered

- **Do nothing** — rejected: the D+ scope grade (#1557) is the measured cost of exactly
  that; sprawl kept growing because nothing failed when it did.
- **A markdown register table inside an ADR** (the approach of the three superseded
  drafts) — rejected: a hand-written table has no enforcement hook and drifts from the
  code immediately; two of the drafts already contained speculative, mutually
  inconsistent tables.
- **Delete extensions outright instead of classifying them** — rejected: trading, creator
  tools, and media surfaces are wanted capabilities; the requirement is that they be
  *declared and gated* extensions, not that they cease to exist.

## Evidence

| Claim | Evidence (file:line / commit / PR) | Confidence | Source |
|---|---|---|---|
| Sprawl was the top-graded gap (D+) and the audit was mandated | Issue #1557 ([SCOPE-1]); closed by PR #1813 (commit `863fe1ce`) | High | GitHub |
| The register exists as code with CORE stage map + EXTENSION modules | [`apps/lantern-garage/lib/surface-registry.js`](../../apps/lantern-garage/lib/surface-registry.js) | High | repo |
| Unclassified surfaces fail a contract test | [`apps/lantern-garage/test/surface-boundary.test.js`](../../apps/lantern-garage/test/surface-boundary.test.js); `test:boundary` in `apps/lantern-garage/package.json` | High | repo |
| Orphan audit is registry-aware and fails only on undeclared orphans | [`scripts/find-orphan-pages.mjs`](../../scripts/find-orphan-pages.mjs); `changelog.d/1558-registry-aware-orphan-audit.md` | High | repo |
| Three colliding drafts of this decision were added by PR #1813 | commit `863fe1ce` file list (`docs/adr/0001-*`, `docs/adr/adr-001-*`, `adr/0001-*`) | High | git |
