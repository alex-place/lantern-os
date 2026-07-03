# ADR-0020: IBKR live order placement — gated, dry-by-default

- Status: Proposed (awaiting Alex's approval per the ADR-0001 gate)
- Date: 2026-07-03
- Deciders: Alex Place (approval required)
- approved-by: pending
- Loop stage: Act (real broker orders enter the loop) + Verify (honest dry-run/blocked states, no fabricated fills)
- Supersedes: [ADR-0019](0019-ibkr-connectivity-client-portal-gateway.md) — both its read-only posture AND its local-gateway connectivity model. Per the operator, IBKR is reached via the **hosted Web API** (`https://api.ibkr.com/v1/api`) with an **OAuth bearer token** ("API key") + a `/tickle` session cookie, not the local Client Portal Gateway.

## Context

The trader's order placement went through Python `cli.py → agents.py → Alpaca`
(`alpaca.submit_order`). That path is being removed (the Python trading subsystem
is deleted; brokerage moves to IBKR). ADR-0019 deliberately shipped the IBKR CPAPI
client **read-only** ("no order placement — the live trader is paused"). To let the
trader place orders again — the user's explicit request — we need an Act-stage
capability, but real-money order placement is irreversible and must never fire by
accident.

## Decision

Add order placement to `lib/ibkr-cpapi.js` (`searchContract`, `placeOrder` with the
CPAPI reply/confirm loop, `getLiveOrders`, `getOrderStatus`), fronted by a single
hard gate in **`lib/trading-guard.js`**. The gate is **DRY by default** — no real
order is ever sent unless EVERY condition below is met:

1. **No global halt** — `data/kalshi/LIVE-KILL-SWITCH` / `TRADING-PAUSED` absent
   (the same kill-switch the Kalshi trader honors: one file stops all live trading).
2. **`TRADER_LIVE=1`** — master arm switch; unset/`0` ⇒ `status:'dry_run'`.
3. **Caps** — `qty ≤ MAX_ORDER_QTY` (default 100) and
   `qty·price ≤ MAX_ORDER_NOTIONAL` (default $2000).
4. **Account tier** — a `paper` account (`DU*`) is allowed; a **live (real-money)
   account requires a second opt-in** `TRADER_ALLOW_LIVE_ACCOUNT=1`.
5. **Authenticated API** — the IBKR Web API (`api.ibkr.com`) must be reachable, the
   bearer token valid, and a brokerage session established via `/tickle`
   (else `status:'error'`, never a fabricated fill).

A blocked order returns `{status:'dry_run', dry:true, reason}` so the UI shows an
honest "paper / blocked — why" state. `trader-agent.placeOrder` and
`routes/trading.js` surface that verbatim.

## Consequences

- **Safe-by-default**: shipping this does not enable live trading. Real orders need
  a valid IBKR bearer token + brokerage session **and** Alex to set `TRADER_LIVE=1`
  (and, on a live account, `TRADER_ALLOW_LIVE_ACCOUNT=1`). Until then it is paper/dry only.
- **Kill-switch parity**: the existing `LIVE-KILL-SWITCH` now halts stock orders too.
- **Follow-ups (not in this ADR)**: CPAPI **bracket** orders (stop-loss/take-profit
  legs) — `placeOrder` currently passes those through as metadata only; and an
  admin feature-flag AND-gate mirroring `kalshi_live_trading`.
- Reversible: delete the order methods + guard to return to ADR-0019's read-only.
