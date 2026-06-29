---
name: human-flourishing-frameworks
description: Integrate the Human Flourishing Frameworks (HFF) into Lantern OS. Use when observing outcomes, modeling causes, optimizing flourishing across beings, connecting sensors, querying the Bayesian world model, running PBFT consensus, or auditing autonomous agent decisions.
---

> ⚠ **Design-only / partial.** Only partially backed (`routes/flourishing.js`). Keep only if the flourishing feed is a kept surface under the subsystem-register ADR (#1557). See [docs/SKILLS-AUDIT-2026-06-29.md](../../docs/SKILLS-AUDIT-2026-06-29.md).

# Human Flourishing Frameworks

A system that observes outcomes, models causes, and optimizes for the most flourishing across all beings.

## Status

- **Architecture**: Real and deployed on Render
- **Sensors**: Built, needs real data sources
- **World Model**: Bayesian, needs measurements
- **Autonomous Agents**: 7 algorithmic agents, no human board
- **PBFT Consensus**: Teaching implementation
- **Cryptography**: Ed25519 via `cryptography` library
- **Mesh Sync**: HTTP POST between known peers

## Integration with Lantern OS

### Route Proxy

The Lantern Garage server (`apps/lantern-garage/routes/flourishing.js`) proxies HFF:

- `/flourishing` → HFF dashboard (port 5100)
- `/api/flourishing/*` → HFF `/api/*`
- Auto-spawns HFF Flask child process on first request

### Convergence Engine

Validation ring jobs:
- `hff-integration-exists` — verifies `integrations/human-flourishing-frameworks/app.py`
- `hff-route-exists` — verifies `apps/lantern-garage/routes/flourishing.js`

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `HFF_PORT` | `5100` | Flask app port |
| `HFF_AUTO_START` | `1` | Auto-spawn on first request |

## Endpoints (via `/api/flourishing`)

| Path | Method | Description |
|---|---|---|
| `/api/world/status` | GET | World model state |
| `/api/world/beliefs` | GET | Bayesian beliefs |
| `/api/world/observe` | POST | Submit observation |
| `/api/world/predict/<entity>` | GET | Predict flourishing |
| `/api/autonomous/status` | GET | Agent status |
| `/api/autonomous/audit` | GET | Audit trail |
| `/api/mesh/violations` | GET | Mesh violations |

## Honest Caveats

- Demo data is synthetic and clearly labeled.
- Node counts are self-reported and unverified.
- Real sensors need to be connected to become useful.
- The world model only knows what sensors can see.
