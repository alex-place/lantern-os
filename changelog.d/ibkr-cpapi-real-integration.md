fix(trading): real IBKR Client Portal Web API — replace the fabricated bearer-token path

The IBKR integration was fiction. `lib/trading-api-bridge.js` authenticated with
`Authorization: Bearer ${IBKR_API_KEY}` against `https://api.ibkr.com/v1/accounts/{id}/summary`
— an endpoint that does not exist — so `getIBKRAccount`/`getIBKRPositions` returned null/[]
100% of the time. `/api/trading/settings` reported `ibkr: true` unconditionally ("Always
configured via Claude Code MCP"), so the settings badge showed "✓ Configured" with zero
evidence. `getDashboardData()` served hardcoded static quotes (`sp500: '$5,843.25'`,
`vix: '14.32'`) as live market data. All three are Σ₀ external-reality violations.

New `lib/ibkr-cpapi.js` speaks the *real* IBKR connectivity model: the Client Portal Web
API served by a local gateway (`https://localhost:5000/v1/api`), session-authenticated,
kept warm with `POST /tickle`, probed via `iserver.authStatus`. Read-only — account
summary + positions only, no order placement (the live trader is paused; order entry is a
separate reviewed decision). Grounded against IBKR's CPAPI docs, Voyz/IBeam, @stoqey/ib,
and ib_async; recorded in ADR-0019.

- `getIBKRStatus()` returns an honest, evidence-bearing `{connected, reachable,
  authenticated, accountId, mode, gatewayUrl, evidence[]}` — a real probe, not a flag.
  New route `GET /api/trading/ibkr/status`.
- `/api/trading/settings` now reports `ibkr` from that real probe; the badge reads
  "Not configured" when the gateway is down and "✓ Configured" only when authenticated.
- Settings POST fixed: the form posts `{ ibkr: { account_id, ... } }` but the handler read
  `payload.ibkr_account`/`ibkr_password` (never sent) and wrote `IBKR_PASSWORD` (never
  read) — saving IBKR settings silently did nothing. Now maps `account_id` →
  `IBKR_ACCOUNT_ID` and optional `gateway_url` → `IBKR_GATEWAY_URL`.
- Fabricated `marketData` quotes removed (now `null`).
- Fail-soft everywhere: gateway absent ⇒ disconnected, honestly, never a throw and never a
  fabricated value. TLS verification skipped only for the loopback self-signed gateway cert.
- Config: `IBKR_GATEWAY_URL` (default local gateway), `IBKR_ACCOUNT_ID` (auto-discovered if
  omitted), `IBKR_TIMEOUT_MS`. Legacy `IBKR_BASE_URL` honored only if not the fictional
  api.ibkr.com. No API key/secret — CPAPI auth is the gateway session.
- Tests: `test/ibkr-cpapi.test.js` (13 checks) — normalizers, loopback TLS scoping, and the
  disconnected fail-soft contract against a closed loopback port.
- Docs: `docs/IBKR-API-SETUP.md` rewritten to the real gateway model (was "no Gateway
  needed"); ADR-0019 added.
