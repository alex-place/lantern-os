---
adr: 0023
title: The default profile foregrounds the loop — extensions are opt-in behind flags
status: Proposed
date: 2026-07-05
deciders: Alex Place
approved-by: pending
supersedes: none
superseded-by: none
---

<!--
  APPROVAL GATE: status stays `Proposed` and approved-by `pending` until Alex Place
  explicitly approves. Never self-approve.

  RELATES TO:
    - ADR-0018 (web-tier split / one Core, two profiles) — this refines the *local*
      default that ADR-0018 left as "every surface". The cloud profile already trims
      to the loop; this makes the local default foreground it too.
    - ADR-0002 (single Convergence Core) and the North Star (CONVERGANCE-SIGMA0-BRIEFING)
      — "name the loop stage you improve, or don't add it." This ADR gives that rule
      teeth in the *running default*, not just the registry.
-->

# ADR-0023: The default profile foregrounds the loop — extensions are opt-in behind flags

## Context

Loop stage: **Converge** — boundary governance; this gives the North Star's sprawl rule
teeth in the running default, not just in the registry.

The North Star forbids architectural sprawl: the app is one loop
(Observe → Remember → Reason → Act → Verify → Converge), and every surface must
strengthen one stage or be an explicitly-optional extension beside it.

`lib/surface-registry.js` already draws that line — every `public/*.html` surface is
classified CORE (names a loop stage) or EXTENSION (names a module + gating flag), and
`test/surface-boundary.test.js` fails on any unclassified surface or on the
extension:core ratio exceeding its cap.

But the *running default* did not honor the boundary:

1. **The default nav presented extensions as equals of the loop.** The header hardcoded
   a link to `stock-trader.html` (trading), and the footer to both `stock-trader.html`
   and `create.html` (creator), next to Chat/Explore — shown even when those extensions
   were disabled. The app *read* as ten products.
2. **Core surfaces did not self-declare their loop stage**, so the pre-push sprawl
   tripwire (which wants a `loop-stage` annotation per surface) was routinely bypassed
   with `SKIP_SPRAWL_CHECK=1` — the boundary held on paper, not at the gate.
3. **Two surfaces had drifted in unclassified** (the IBKR pages), leaving the contract
   test red.

Only the `cloud` tenancy profile (ADR-0018) trimmed to the loop; the local/desktop
default served — and foregrounded — everything.

## Decision

The default profile foregrounds the loop. Concretely:

- **Nav is tier-gated at one chokepoint.** `feature-flags.js getNavConfig()` marks an
  EXTENSION nav entry `hidden` unless its gating flag is enabled (env var or admin
  toggle). CORE surfaces and always-on shell modules (account / meta) are never
  default-hidden. The existing client gate (`auth-gate.js`, consuming `/api/nav-config`)
  applies this to both the header `<nav>` and the site footer. Extensions are opt-in,
  not deleted: flip the flag and the link returns.
- **Product-mainstay exception (`surface-registry.NAV_FOREGROUND`).** The owner may keep
  a specific extension in the default nav as a deliberate product choice — currently the
  trader (`stock-trader.html`, served to everyone in guest read-only mode). It stays an
  EXTENSION in the boundary (it serves no loop stage) but is not default-hidden. The set
  is a one-line, reviewable edit, so "this extension is a mainstay" is explicit, not
  accidental.
- **Every CORE surface self-declares its stage** via `<meta name="loop-stage" content="…">`,
  sourced from the registry (one known drift: `systems.html` declares `observe` while the
  registry says `Converge` — tracked as a follow-up below) — so the sprawl tripwire passes
  clean, with no bypass, and future additions are gated rather than waved through.
- **One gate, one source of truth.** `sprawl-tripwire.mjs` now treats a surface already
  classified in `surface-registry.js` as justified, rather than demanding a duplicate
  loop-stage annotation the registry already implies. The registry (with its contract
  test + budget cap) is authoritative; the tripwire catches only genuinely *unclassified*
  new top-level surfaces. Nested bundled mini-apps (e.g. `games/2048/`) are gated at their
  extension-cluster level, not as first-class surfaces.
- **Redirect stubs are not surfaces.** A moved surface is a server-side 302
  (`routes/pages.js` REDIRECTS), never a stub `.html` in `public/` that inflates the count.
- **The contract test is the boundary's contract.** `surface-boundary.test.js` (run via
  `npm run test:boundary` / `test:sigma0`) must be green — no silent sprawl, ratio within
  cap. Note: as of this writing **no CI workflow runs it**; only the sprawl-tripwire is
  re-run in CI (`pr-gates.yml` sprawl-tripwire job). Wiring the contract test into CI is a
  follow-up below, so the boundary becomes machine-enforced before merge as this ADR intends.

## Consequences

- The default local app presents the loop: Chat · Settings · Work · Explore (+ account /
  help shell), plus the trader as a foregrounded product mainstay. Creator, media, and
  game extensions appear only when enabled.
- Adding a surface still requires classifying it in `surface-registry.js` (or the test
  fails) **and** annotating its `loop-stage` (or the tripwire fails) — the boundary now
  bites in the running default, not just in review.
- No feature is removed; extensions remain one flag away. This is a *posture* change, not
  a capability cut.
- Behaviour-preserving where a flag is already set (deployments that enable trading still
  see the trader). The default simply stops advertising disabled extensions.
- **Follow-ups:**
  - Wire `surface-boundary.test.js` into CI (`ci.yml` or `pr-gates.yml`) so the boundary is
    machine-enforced before merge, not just runnable locally.
  - Reconcile `systems.html`'s `loop-stage` meta (`observe`) with its registry entry
    (`Converge`), and extend the contract test to assert meta-tag ↔ registry consistency so
    the "one source of truth" claim stays true.

## Alternatives considered

- **Delete extension pages outright:** rejected — a capability cut, not a posture change;
  extensions are legitimate opt-in features.
- **Leave the nav static and rely on the cloud profile only (ADR-0018):** rejected — the
  local default would keep advertising disabled extensions, so the boundary would hold only
  in the hosted tier.
- **Hardcode per-page hiding:** rejected — no single chokepoint; `getNavConfig()` +
  `auth-gate.js` give one reviewable gate for header and footer alike.

## Evidence

| Claim | Evidence (file:line / commit / PR) | Confidence | Source |
|---|---|---|---|
| Decision implemented and merged | PR #2147 (commit 3ce7f3db, merged 2026-07-06) | High | repo |
| Product-mainstay exception exists and is a one-line edit | `apps/lantern-garage/lib/surface-registry.js:119-130` (`NAV_FOREGROUND`) | High | code |
| Nav tier-gated at one chokepoint | `apps/lantern-garage/lib/feature-flags.js:192-219` (`getNavConfig`, default-hidden) | High | code |
| Client applies gate to header and footer | `apps/lantern-garage/public/js/auth-gate.js:49-58` (consumes `/api/nav-config`) | High | code |
| Tripwire treats registry-classified surfaces as justified | `scripts/sprawl-tripwire.mjs:33-39` | High | code |
| Moved surfaces are 302s, not stub pages | `apps/lantern-garage/routes/pages.js:56-84` (`REDIRECTS`) | High | code |
| 19 CORE surfaces carry loop-stage meta (1 drift: systems.html) | `public/*.html` meta tags vs `surface-registry.js:49` | High | code |
| Contract test not yet in CI | grep of `.github/workflows/` → no `surface-boundary` reference; `pr-gates.yml:122-136` runs only the tripwire | High | repo |
