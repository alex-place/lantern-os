# ADR-0022: Per-user IBKR connection via self-service OAuth 1.0a

- Status: Accepted (operator-directed, 2026-07-05)
- Relates to: [ADR-0019](0019-ibkr-connectivity-client-portal-gateway.md), [ADR-0020](0020-ibkr-live-order-placement.md)

## Context

Users of unisona want to trade **their own** IBKR accounts through the platform.
We evaluated three connection models:

1. **Operator single account** — one IBKR account for everyone. Rejected: every
   trade lands on the operator's account (unacceptable liability).
2. **Third-party OAuth** ("true one-click connect") — requires IBKR to onboard
   unisona as an **approved third-party vendor**: Compliance approval, and — because
   the AI Trader is an *automated trading solution* — the vendor is expected to hold
   **financial-authority registration** in every region served (verified with IBKR:
   `webapionboarding@interactivebrokers.com`, OAuth 1.0a only). Deferred: this is a
   legal/regulatory process, not a code task.
3. **Per-user self-service OAuth 1.0a** — each user registers their **own** OAuth
   consumer in IBKR's self-service portal, generates their own keys, and connects
   their own account. **No vendor/third-party relationship exists**, so no IBKR
   Compliance onboarding or vendor registration is required. **Chosen.**

## Decision

Support per-user IBKR connections via **self-service OAuth 1.0a**. Each user supplies,
from IBKR's self-service portal:

- `consumerKey`
- `accessToken` + `accessTokenSecret` (the secret is RSA-encrypted by IBKR)
- signing RSA private key (`private_signature.pem`)
- encryption RSA private key (`private_encryption.pem`)
- Diffie-Hellman prime (`dhparam.pem`)
- realm (usually `limited_poa`)

### Auth flow (per user, per session)

1. **Live Session Token (LST):** generate DH challenge `2^a mod p`; RSA-decrypt the
   access-token-secret → `prepend`; sign the `/oauth/live_session_token` request base
   string (prepended) with **RSA-SHA256** (signing key). Server returns the DH
   response; `K = dhResponse^a mod p`; `LST = base64(HMAC-SHA1(K_bytes, prepend_bytes))`.
   Validate: `HMAC-SHA1(base64decode(LST), consumerKey) == live_session_token_signature`.
2. **Requests:** sign each base string with **HMAC-SHA256** keyed by `base64decode(LST)`.
3. **Session:** `POST /iserver/auth/ssodh/init` then keep alive with `POST /tickle`.

Implemented dependency-free with Node `crypto` (BigInt modPow, `RSA_PKCS1_PADDING`
decrypt, `RSA-SHA256` sign, HMAC-SHA1/256) in `lib/ibkr-oauth1.js`, ported from a
verified reference implementation.

### Storage & safety

- Per-user IBKR credentials are stored **encrypted at rest**, keyed to the profile id,
  and **never** returned to the client or logged.
- Order placement stays behind the existing `lib/trading-guard.js` gate (DRY by
  default; `TRADER_LIVE`, caps, live-account arming) — unchanged by this ADR.
- Paper (`DU…`) vs live (`U…`) is per the connected account; a user may connect a
  paper account first and switch later (a live account additionally requires the
  `TRADER_ALLOW_LIVE_ACCOUNT` arm, per ADR-0020).

## Consequences

- Users must complete IBKR's self-service OAuth registration (generate keys, register
  the consumer) — more setup than a true one-click, but shippable now with **no vendor
  onboarding**. A guided in-app flow with links + field-by-field help mitigates this.
- If unisona later pursues true one-click (model 2), this per-user layer is reused;
  only the token-acquisition front-end changes.

## Build phases

1. **Signer** — `lib/ibkr-oauth1.js` (LST + request signing). ← this change
2. **Per-user client** — `ibkr-cpapi.js` accepts an injected signer instead of a Bearer token.
3. **Encrypted per-user credential store** + connect/disconnect endpoints.
4. **"Connect IBKR" UI** (guided) in the profile/trader.
5. **Wire the trader** to resolve the caller's per-user IBKR client.
