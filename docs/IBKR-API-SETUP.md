---
author: Alex Place
created: 2026-06-11
updated: 2026-07-03
---

# IBKR API Integration — Client Portal Web API (local gateway)

> **Correction (2026-07-03).** Earlier revisions of this doc claimed you could connect
> to IBKR "directly with API credentials, no Gateway needed" using a bearer token against
> `https://api.ibkr.com/v1`. **That endpoint does not exist** — IBKR has no Alpaca-style
> bearer-token REST API, so that path silently returned nothing 100% of the time. This
> doc now describes the real connectivity model. See
> [ADR-0019](adr/0019-ibkr-connectivity-client-portal-gateway.md) for the decision.

Keystone talks to Interactive Brokers over the **Client Portal Web API (CPAPI)**, served
by a **gateway you run locally**. The integration is **read-only**: it reads your account
summary and open positions. It does **not** place orders.

---

## How it actually works

```
Browser dashboard
   │  GET /api/trading/ibkr/status | /account | /positions
   ▼
Keystone server (routes/trading.js → lib/trading-api-bridge.js)
   ▼
lib/ibkr-cpapi.js  ── HTTPS ──▶  Client Portal Gateway  (https://localhost:5000/v1/api)
                                       │  authenticated browser SSO session
                                       ▼
                                 Interactive Brokers
```

The gateway holds an **authenticated session**. Keystone keeps it warm with `POST /tickle`
and checks `iserver.authStatus` before every read. No session ⇒ Keystone honestly reports
**disconnected** (it never fabricates numbers).

---

## Setup

### 1. Run the Client Portal Gateway

Two supported options:

- **Manual gateway** — download IBKR's *Client Portal Gateway* (the small Java app),
  unzip, and run `bin/run.sh root/conf.yaml` (or `bin\run.bat`). It listens on
  `https://localhost:5000`.
- **Headless / always-on** — [Voyz/IBeam](https://github.com/Voyz/ibeam) is a Docker
  image that runs the gateway *and* re-authenticates it automatically. Recommended if you
  want the connection to survive reboots without manual logins.

### 2. Authenticate

Open **https://localhost:5000** in a browser and log in with your IBKR username/password
(+ 2FA). The browser will warn about the self-signed certificate — that is expected for a
local gateway; proceed. Once you see "Client login succeeds", the session is live.

> **Paper trading:** log in with your paper credentials. Paper accounts have ids beginning
> `DU`; live accounts begin `U`. Keystone infers and reports `mode: paper|live` from the id.

### 3. (Optional) Configure Keystone

All optional — the defaults work for a standard local gateway. Add to `.env` at repo root:

```bash
# IBKR Client Portal Web API (local gateway)
IBKR_GATEWAY_URL=https://localhost:5000/v1/api   # default; override for a remote gateway
IBKR_ACCOUNT_ID=DU1234567                         # optional — auto-discovered if omitted
IBKR_TIMEOUT_MS=6000                              # optional per-request timeout
# IBKR_TLS_INSECURE=1                             # only if using a non-loopback self-signed gateway
```

There is **no** API key or secret — CPAPI auth is the gateway session, not a token.

### 4. Verify

```bash
curl -s http://127.0.0.1:4177/api/trading/ibkr/status | jq
```

```jsonc
{
  "connected": true,
  "reachable": true,
  "authenticated": true,
  "accountId": "DU1234567",
  "mode": "paper",
  "gatewayUrl": "https://localhost:5000/v1/api",
  "source": "ibkr-cpapi",
  "evidence": ["gateway reachable at https://localhost:5000/v1/api", "session authenticated", "account DU1234567 (paper)"],
  "checkedAt": "2026-07-03T..."
}
```

The trading settings badge (`/trading.html` → Settings) reads this same status, so it now
shows **Not configured** when the gateway is down and **✓ Configured** only when a real
session is authenticated.

---

## What you get

| Feature | Status |
|---|---|
| Account summary (net-liq, cash, buying power, unrealized P&L) | ✅ `GET /api/trading/ibkr/account` |
| Open positions | ✅ `GET /api/trading/ibkr/positions` |
| Honest connection status + evidence | ✅ `GET /api/trading/ibkr/status` |
| Order placement | ❌ Not implemented (read-only by design — see ADR-0019) |
| Live index/quote feed | ❌ Not wired (the dashboard's fabricated static quotes were removed) |

---

## Troubleshooting

**`connected: false, reachable: false`** — the gateway isn't running (or `IBKR_GATEWAY_URL`
is wrong). Start the Client Portal Gateway / IBeam and retry. On loopback this fails fast
(connection refused), so the dashboard won't hang.

**`reachable: true, authenticated: false`** — the gateway is up but the session isn't logged
in (or it expired — CPAPI sessions time out after inactivity). Re-open https://localhost:5000
and log in again, or let IBeam re-auth.

**Certificate errors on a remote gateway** — the gateway's cert is self-signed. Keystone skips
verification only for loopback hosts. For a non-loopback gateway you trust, set
`IBKR_TLS_INSECURE=1` (understand the risk) or install the gateway cert.

---

## Security notes

- Read-only: no order-placement code path exists in `lib/ibkr-cpapi.js`.
- No secrets in code or logs; the account id is the only IBKR value Keystone stores (in `.env`).
- TLS verification is skipped **only** for loopback (the gateway's self-signed cert); remote
  hosts are verified unless you explicitly opt out.
- `.env` must stay in `.gitignore`.

---

## References (grounding)

- IBKR Client Portal Web API — `interactivebrokers.github.io/cpwebapi`
- Voyz/IBeam (headless gateway auth) — https://github.com/Voyz/ibeam
- `@stoqey/ib` (Node TWS client, the socket alternative) — https://github.com/stoqey/ib
- `ib_async` (maintained `ib_insync` successor) — https://github.com/ib-api-reloaded/ib_async

**Dashboard:** http://127.0.0.1:4177/trading.html
