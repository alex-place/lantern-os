# Surface Boundary — Core Loop vs. Extensions

**Status:** Living. Source of truth: [`apps/lantern-garage/lib/surface-registry.js`](../apps/lantern-garage/lib/surface-registry.js).
Enforced by: [`apps/lantern-garage/test/surface-boundary.test.js`](../apps/lantern-garage/test/surface-boundary.test.js) (`npm run test:boundary`).

## Why this exists

The [Σ₀ briefing](CONVERGANCE-SIGMA0-BRIEFING.md) and [CLAUDE.md](../CLAUDE.md) forbid architectural sprawl: *"name the loop stage you improve, or don't add it."* With 40-odd public HTML surfaces, that rule had no teeth — nothing declared which surfaces **are** the
`Observe → Remember → Reason → Act → Verify → Converge` loop and which are optional capabilities sitting beside it. The result reads as undifferentiated sprawl even when much of it is legitimate.

This boundary draws the line explicitly so it is **auditable and gateable** instead of implicit. It does not delete anything — it classifies. The fix for sprawl is not amputation; it is a declared boundary plus a contract test that stops new sprawl from landing silently.

Grounded in the modular-monolith pattern: *clear module boundaries prevent organic sprawl, enforced by contract tests that verify expectations before merge.*
Refs: [modularmonoliths.com](https://modularmonoliths.com/), [Microsoft multi-agent reference architecture — Modular Monolith](https://microsoft.github.io/multi-agent-reference-architecture/docs/design-options/Modular-Monolith.html).

## The rule

Every top-level `public/*.html` surface is exactly one of:

- **CORE** — directly serves one loop stage. It must name which stage (`Observe`/`Remember`/`Reason`/`Act`/`Verify`/`Converge`).
- **EXTENSION** — an optional capability beside the loop. It must name a `module` cluster, and may name an env `flag` (gated through [`lib/feature-graph.js`](../apps/lantern-garage/lib/feature-graph.js)).

A surface that is neither **fails the contract test**. To add a surface you must classify it; to promote/demote one you edit the registry deliberately.

Classification alone only *labels* sprawl, so the contract test also enforces two rules that push back on it:

- **BUDGET** — the `extension : core` ratio may not exceed `MAX_EXTENSION_RATIO` (currently **0.95**). Adding an extension without adding core value trips the gate; the fix is to grow the core loop, or to raise the cap as a **deliberate, reviewable one-line edit** — never silent accretion.
- **GATEABLE** — every extension must be switch-off-able (name an env `flag`), **except** the always-on shell modules (`account`, `meta`) that must always render. This makes "optional capability beside the loop" true in practice, not just on paper.

The hosted **cloud** profile ([`lib/deployment-profile.js`](../apps/lantern-garage/lib/deployment-profile.js)) is a second, tighter list — and its contract test now cross-checks that every hosted surface **exists on disk and is classified here**, so the two lists can't drift apart (that check would have caught the former dangling `help.html`).

## Current boundary (measured)

`20 core : 18 extension` — ratio **0.9 : 1** (cap **0.95**). The numbers come from `surface-registry.summary()` via `npm run test:boundary`, not an estimate. (A parallel non-HTML **subsystems** tier — bots + background services, #1948/#1980 — is classified by the same rule; see `SUBSYSTEMS` in the registry.)

### Core — the convergence loop
| Stage | Surfaces |
|---|---|
| Observe | `index.html` |
| Remember | `explore.html`, `knowledgecenter.html`, `rag-house.html`, `wide-search.html` |
| Reason | `dream-chat.html` |
| Act | `orchestration.html`, `work.html`, `admin-flags.html` |
| Verify | `proof.html`, `calibration.html`, `factcheck.html`, `grounding-diff.html`, `drift.html` |
| Converge | `agent-status.html`, `agent-leaderboard.html`, `metrics.html`, `systems.html`, `replay.html` |

### Extensions — optional capabilities (by module)
| Module | Count | Flag | Surfaces |
|---|---|---|---|
| account | 7 | — (always-on shell) | `auth`, `entry`, `profile`, `reset-password`, `pricing`, `upgrade-lab`, `api-keys-settings` |
| trading | 4 | `TRADING_ENABLED` | `trading`, `kalshi-terminal`, `kalshi-screener`, `stock-trader` |
| meta | 3 | — (always-on shell) | `changelog`, `whats-new`, `faq` |
| creator | 1 | `CREATOR_ENABLED` | `create` |
| media | 1 | `RADIO_ENABLED` | `fallout-radio` |

## What this buys

- **Honest accounting.** The sprawl is a number (0.9:1) with a **cap that fails CI** (0.95), not a vibe. Setting aside the account/meta shell (11 surfaces), no feature cluster exceeds 5 surfaces (trading).
- **No silent sprawl.** A new unclassified `public/*.html` fails `npm run test:boundary` — you must name the loop stage it serves, or declare it an extension.
- **Back-pressure, not just labels.** A new extension that isn't offset by core value trips the budget; every extension is switch-off-able (a `flag`) unless it's the account/meta shell. The sprawl can be *turned off*, not just *counted*.
- **No list drift.** The cloud hosted subset is cross-checked against disk + this registry, so a hosted entry can't point at a missing or unclassified file.

This complements the existing governance scripts — `find-orphan-pages.mjs` (reachability) and `lint-throwaway-pages.mjs` (throwaway/test pages). Those ask "is it reachable / is it junk?"; this asks "does it belong to the loop, or is it a declared, gated, budgeted extension?"
