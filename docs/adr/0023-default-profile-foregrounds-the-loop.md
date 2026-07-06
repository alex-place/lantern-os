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

## Context

The North Star forbids architectural sprawl: the app is one loop
(Observe → Remember → Reason → Act → Verify → Converge), and every surface must
strengthen one stage or be an explicitly-optional extension beside it.

`lib/surface-registry.js` already draws that line — every `public/*.html` surface is
classified CORE (names a loop stage) or EXTENSION (names a module + gating flag), and
`test/surface-boundary.test.js` fails on any unclassified surface or on the
extension:core ratio exceeding its cap.

But the *running default* did not honor the boundary:

1. **The default nav presented extensions as equals of the loop.** The header and
   footer hardcoded links to `stock-trader.html` (trading) and `create.html` (creator)
   next to Chat/Explore, shown even when those extensions were disabled. The app *read*
   as ten products.
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
  sourced from the registry — so the sprawl tripwire passes clean, with no bypass, and
  future additions are gated rather than waved through.
- **One gate, one source of truth.** `sprawl-tripwire.mjs` now treats a surface already
  classified in `surface-registry.js` as justified, rather than demanding a duplicate
  loop-stage annotation the registry already implies. The registry (with its contract
  test + budget cap) is authoritative; the tripwire catches only genuinely *unclassified*
  new top-level surfaces. Nested bundled mini-apps (e.g. `games/2048/`) are gated at their
  extension-cluster level, not as first-class surfaces.
- **Redirect stubs are not surfaces.** A moved surface is a server-side 302
  (`routes/pages.js` REDIRECTS), never a stub `.html` in `public/` that inflates the count.
- **The contract test is the enforced boundary.** `surface-boundary.test.js` must be
  green (no silent sprawl, ratio within cap) before merge; CI re-runs it.

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
