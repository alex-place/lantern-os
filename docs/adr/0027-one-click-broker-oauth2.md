# ADR-0027: One-Click Broker Connect — per-user OAuth2 (Alpaca now, IBKR when they ship it)

- **Status:** Proposed
- **Date:** 2026-07-15
- **Deciders:** Alex Place (approval required)
- **Relates to:** ADR-0019 (IBKR connectivity), ADR-0020 (live order gating), ADR-0022 (IBKR per-user self-service OAuth), issue #2447 (market data), SEC-readiness review issue

## Context

Connecting a brokerage today takes a motivated user ~15 minutes and five failure modes: generate a keypair, upload 3 PEM files to IBKR's portal, mint a token that vanishes on refresh, paste four secrets, then possibly wait 24h for key activation (documented server-side lag). We built the best possible wizard around it (orchestration.html#broker), but the flow's shape is fixed by IBKR's **self-service OAuth 1.0a**, which is designed for first-party/own-account use — not for a consumer product.

Product need: **"Connect your broker" should be one click** — provider login page → Approve → connected. Investigation (2026-07-15):

| Route | One-click? | Trading? | Availability |
|---|---|---|---|
| IBKR OAuth 2.0 retail | yes (someday) | yes | **no ETA** — institutional only today |
| IBKR third-party partner OAuth | yes | yes | requires a partner/institutional agreement with IBKR — long lead, compliance |
| SnapTrade aggregator | yes (popup) | **not for IBKR** (Flex-Query, read-only) | live today, 35+ brokers, data-only for IBKR |
| **Alpaca OAuth 2.0** | **yes** | **yes — paper AND live** | **live today**, third-party apps supported, `env=paper` param, user never exposes keys |

Alpaca history note: we removed Alpaca as our *first-party* data/execution backend (2026-07-03) — that decision stands. This ADR is a different shape: **per-user OAuth2** where each user connects *their own* Alpaca account (paper by default), the same trust model as ADR-0022.

## Decision (proposed)

Adopt a **broker-adapter seam with tiered connect UX**:

1. **Now — Alpaca OAuth2 as the one-click tier.**
   - Register unisona as an Alpaca OAuth app (client_id/secret; server-held).
   - "⚡ Connect Alpaca — one click" button beside the IBKR flow: standard OAuth2 authorization-code flow (`state` CSRF nonce; `env=paper` default), callback exchanges code → per-user access token.
   - Tokens stored in the existing AES-256-GCM per-user credential store (generalize `ibkr-credentials.js` → `broker-credentials.js` with a `provider` field; same never-returned-to-client rule).
   - New `alpaca-adapter.js` implementing the same bridge contract as `ibkr-cpapi.js` (`getAccount`, `getPositions`, `placeOrder`) — **every order still passes `trading-guard.js`** (TRADER_LIVE, caps, kill-file) and the autopilot's own `TRADER_AUTO_EXECUTE` opt-in; the guard is broker-agnostic by design.
   - Live trading through the OAuth app additionally requires Alpaca's app approval — ship paper-only first (which is exactly what the autopilot needs).
2. **Keep IBKR self-service (ADR-0022) as the power-user tier.** Wizard stays; add activation-lag-aware status ("registered <24h ago — IBKR may still be activating your keys") so signature mismatches in the first day read as *wait*, not *broken*.
3. **Apply for IBKR's third-party partner OAuth in parallel** (CBDO-track work item). When granted — or when IBKR ships retail OAuth2 — IBKR moves into the one-click tier behind the same adapter seam with no UI change.
4. **SnapTrade explicitly deferred**: one-click *data* for 35+ brokers is attractive for portfolio surfaces, but it cannot trade IBKR and adds a per-account vendor cost; revisit if read-only multi-broker portfolio sync becomes a product goal.

## Consequences

- The autopilot gets a **fillable paper account in one click** — unblocking the certified-signal paper track record without IBKR's 24h key dance.
- Two connect paths must be maintained (OAuth2 + OAuth1.0a self-service) behind one adapter contract; the seam cost is paid once and IBKR-OAuth2 lands free later.
- New secrets surface (Alpaca client_secret) joins `.env.local` on the stable host; callback URL must be registered per environment.
- Compliance: paper-first keeps us inside the existing SEC-readiness gate; live-tier marketing remains blocked on that review regardless of broker.

## Rejected alternatives

- **Automating IBKR's portal on the user's behalf** (headless browser filling their login/uploads): handles user credentials in plaintext, brittle, likely ToS-violating — rejected outright.
- **Waiting for IBKR retail OAuth2**: no ETA; product need is now.
- **SnapTrade as the trading rail**: doesn't trade IBKR; aggregator fees; weaker fit than direct Alpaca OAuth2 for the one-click trading tier.

## Sources

Alpaca OAuth2 + Trading API (docs.alpaca.markets/us/docs/using-oauth2-and-trading-api; alpaca.markets/oauth) · env=paper behavior (Alpaca forum #807) · SnapTrade IBKR integration = Flex-Query, no trading (snaptrade.com/brokerage-integrations/ibkr-api; docs.snaptrade.com/docs/integrations) · IBKR OAuth 1.0a Extended + activation lag (interactivebrokers.com/campus/ibkr-api-page/oauth-1-0a-extended; github.com/Voyz/ibind/issues/49)
