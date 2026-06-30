# Surface Boundary — Core Loop vs. Extensions

**Status:** Living. Source of truth: [`apps/lantern-garage/lib/surface-registry.js`](../apps/lantern-garage/lib/surface-registry.js).
Enforced by: [`apps/lantern-garage/test/surface-boundary.test.js`](../apps/lantern-garage/test/surface-boundary.test.js) (`npm run test:boundary`).

## Why this exists

The [Σ₀ briefing](CONVERGANCE-SIGMA0-BRIEFING.md) and [CLAUDE.md](../CLAUDE.md) forbid architectural sprawl: *"name the loop stage you improve, or don't add it."* With ~48 public HTML surfaces, that rule had no teeth — nothing declared which surfaces **are** the
`Observe → Remember → Reason → Act → Verify → Converge` loop and which are optional capabilities sitting beside it. The result reads as undifferentiated sprawl even when much of it is legitimate.

This boundary draws the line explicitly so it is **auditable and gateable** instead of implicit. It does not delete anything — it classifies. The fix for sprawl is not amputation; it is a declared boundary plus a contract test that stops new sprawl from landing silently.

Grounded in the modular-monolith pattern: *clear module boundaries prevent organic sprawl, enforced by contract tests that verify expectations before merge.*
Refs: [modularmonoliths.com](https://modularmonoliths.com/), [Microsoft multi-agent reference architecture — Modular Monolith](https://microsoft.github.io/multi-agent-reference-architecture/docs/design-options/Modular-Monolith.html).

## The rule

Every top-level `public/*.html` surface is exactly one of:

- **CORE** — directly serves one loop stage. It must name which stage (`Observe`/`Remember`/`Reason`/`Act`/`Verify`/`Converge`).
- **EXTENSION** — an optional capability beside the loop. It must name a `module` cluster, and may name an env `flag` (gated through [`lib/feature-graph.js`](../apps/lantern-garage/lib/feature-graph.js)).

A surface that is neither **fails the contract test**. To add a surface you must classify it; to promote/demote one you edit the registry deliberately.

## Current boundary (measured)

`18 core : 30 extension` — ratio **1.67 : 1**. (The numbers come from `surface-registry.summary()`, not an estimate.)

### Core — the convergence loop
| Stage | Surfaces |
|---|---|
| Observe | `index.html` |
| Remember | `explore.html`, `knowledgecenter.html`, `rag-house.html`, `wide-search.html` |
| Reason | `dream-chat.html` |
| Act | `orchestration.html`, `work.html`, `keystone-work.html`, `admin-flags.html` |
| Verify | `proof.html`, `calibration.html`, `factcheck.html`, `grounding-diff.html` |
| Converge | `operations.html`, `agent-status.html`, `agent-leaderboard.html`, `metrics.html` |

### Extensions — optional capabilities (by module)
| Module | Count | Flag | Surfaces |
|---|---|---|---|
| trading | 10 | `TRADING_ENABLED` | `trading`, `trading-news`, `kalshi-terminal`, `kalshi-dashboard`, `kalshi-crypto-deck`, `kalshi-optimal-window`, `kalshi-realtime-positions`, `crypto-dashboard`, `stock-trader`, `test_deck_demo` |
| account | 6 | — | `auth`, `entry`, `profile`, `pricing`, `upgrade-lab`, `api-keys-settings` |
| creator | 5 | `CREATOR_ENABLED` | `create`, `creator-intake`, `document-studio`, `brainrot`, `courtney` |
| legacy | 3 | — | `dream-chat-v1`, `dream-chat-orion`, `ops` |
| flourishing | 2 | `HFF_ENABLED` | `flourishing`, `hff` |
| media | 1 | `RADIO_ENABLED` | `fallout-radio` |
| outreach | 1 | `OUTREACH_ENABLED` | `outreach` |
| meta | 1 | — | `changelog` |
| viz | 1 | — | `observer-mesh-cube` |

## What this buys

- **Honest accounting.** The sprawl is now a number (1.67:1), not a vibe. Trading is the single largest extension cluster (10 surfaces).
- **No silent sprawl.** A new unclassified `public/*.html` fails `npm run test:boundary` — you must say what loop stage it serves, or mark it an extension.
- **A gate to shrink behind.** Extensions already carry feature flags; the `legacy` module marks superseded surfaces that are candidates for removal.

This complements the existing governance scripts — `find-orphan-pages.mjs` (reachability) and `lint-throwaway-pages.mjs` (throwaway/test pages). Those ask "is it reachable / is it junk?"; this asks "does it belong to the loop, or is it a declared extension?"
