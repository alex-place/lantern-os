# ADR-0019: IBKR connectivity — Client Portal Web API via local gateway (read-only)

- Status: Accepted (Alex Place, 2026-07-04)
- Date: 2026-07-03
- Deciders: Alex Place (approval required per ADR-0001 gate)
- approved-by: Alex Place (2026-07-04)
- Loop stage: Observe (real broker account/position data enters the loop) + Verify (honest, evidence-bearing connection status replaces a hardcoded green)

## Context

The Keystone trader's IBKR integration was **fictional**. `lib/trading-api-bridge.js`
authenticated with `Authorization: Bearer ${IBKR_API_KEY}` against
`https://api.ibkr.com/v1/accounts/{id}/summary`, and `docs/IBKR-API-SETUP.md` told
users "No Gateway needed. Connect directly with API credentials."

**No such API exists.** Interactive Brokers exposes exactly two supported programmatic
paths (grounded against IBKR's own docs and the OSS reference clients):

1. **Client Portal Web API (CPAPI)** — REST/WebSocket served by a *local gateway*
   (`https://localhost:5000/v1/api`). Auth is a browser SSO session against the
   gateway (or a headless maintainer such as [Voyz/IBeam](https://github.com/Voyz/ibeam)),
   kept alive with `POST /tickle`. There is no bearer token and no `api.ibkr.com`
   REST host. (`interactivebrokers.github.io/cpwebapi`)
2. **TWS socket API** — a binary socket protocol to the desktop **Trader Workstation**
   (7496/7497) or **IB Gateway** (4001/4002), consumed via a language client such as
   [`@stoqey/ib`](https://github.com/stoqey/ib) (Node) or
   [`ib_async`](https://github.com/ib-api-reloaded/ib_async) (Python, the maintained
   successor to `ib_insync`). Requires the desktop app running with API mode enabled.

Consequences of the fiction: `getIBKRAccount()`/`getIBKRPositions()` returned `null`/`[]`
100% of the time; `/api/trading/settings` reported `ibkr: true` **unconditionally**
("Always configured via Claude Code MCP"), so the settings badge showed "✓ Configured"
with zero evidence; and `getDashboardData()` served hardcoded static quotes
(`sp500: '$5,843.25'`, `vix: '14.32'`) as if they were live — a direct violation of the
Σ₀ External Reality Rule.

## Decision

Adopt **CPAPI via the local Client Portal Gateway** as Keystone's IBKR connectivity
model, implemented **read-only** in `lib/ibkr-cpapi.js`.

- **CPAPI, not TWS socket.** This server already speaks HTTP; CPAPI needs no extra
  runtime. The TWS socket path would require a Python/socket sidecar (a second process
  and a heavier dependency) to gain order entry we deliberately are not adding yet.
- **Read-only.** Account summary + positions only (`/portfolio/accounts`,
  `/portfolio/{acct}/summary`, `/portfolio/{acct}/positions/{page}`). **No order
  placement.** The live trader is paused (kill-file posture, `kalshi-profitable-only`
  memory); adding an Act-stage order capability to IBKR is a separate, reviewed decision.
- **Fail-soft, never fabricate.** Every method resolves to `null`/`[]`/`{connected:false}`
  when the gateway is absent or unauthenticated. Connection status is a *real probe*
  (`POST /tickle` → `iserver.authStatus`) carrying `[claim, evidence, source]` provenance,
  surfaced at `GET /api/trading/ibkr/status`.
- **TLS scoped.** The gateway serves a self-signed cert on loopback, so certificate
  verification is skipped **only** for loopback hosts (or an explicit `IBKR_TLS_INSECURE=1`).
  A remote gateway is verified normally.
- **Config:** `IBKR_GATEWAY_URL` (default `https://localhost:5000/v1/api`),
  `IBKR_ACCOUNT_ID` (optional — auto-discovered via `/portfolio/accounts`),
  `IBKR_TIMEOUT_MS`. The legacy `IBKR_BASE_URL` is honored only if it does *not* point at
  the fabricated `api.ibkr.com`.

## Consequences

- **Accept:** a running gateway is now a prerequisite for live IBKR data (a real
  operational cost — the user or IBeam must keep a session authenticated). This is
  inherent to IBKR's design, not a Keystone choice.
- **Accept:** no IBKR order entry until a follow-up ADR adds it (intentional).
- **Gain:** the settings/status badge tells the truth; disconnected reads honest, not
  green. No fabricated market data. The integration is grounded in an API that exists.
- **Reversible:** swapping to the TWS socket path later means a new client module behind
  the same `getIBKRAccount`/`getIBKRPositions`/`getIBKRStatus` bridge seam; routes and UI
  are unaffected.

## Alternatives considered

- **Keep the "direct REST" bearer-token path** — rejected: the endpoint does not exist;
  it is unfixable fiction.
- **TWS socket via `@stoqey/ib` / `ib_async` sidecar** — deferred: more moving parts
  (desktop app + second process) than the read-only data need justifies today. Recorded
  here as the natural next step *if/when* order entry is approved.
- **Alpaca only** — Alpaca is already wired as a paper-trading comparison, but does not
  cover the user's IBKR account; not a substitute.
