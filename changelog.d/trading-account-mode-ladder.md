### DEMO / PAPER / TRADE: every account gets its own practice trading account

Closes the Free-tier promise of "your own paper-trading account" (#2546) and fixes a privacy
bug found on the way.

**The bug.** `alpaca-adapter._authFor()` fell through to the shared operator server keys for
*any* signed-in user who hadn't connected their own broker — so every such user resolved to the
**same** Alpaca account and saw each other's positions and orders. Server keys are now
owner-only (`ALPACA_SHARED_KEYS_FOR_ALL=1` restores the old pooled behaviour deliberately).

**The ladder** (`lib/trading-account-mode.js`, `GET/POST /api/trading/account-mode`) — a
different axis from `/api/trading/mode`, which picks the *strategy*:

- **demo** — read-only, the simulated champion book (`lib/champion-demo.js`), not Alpaca and
  not the user's money. Read-only is *structural*: the demo facade has no working write path,
  so a caller that forgets to check still cannot place an order.
- **paper** — the user's own practice account: their BYOK Alpaca paper account (the
  destination) or, until they connect keys, a per-user house ledger (`lib/house-paper-broker.js`).
  Cash and positions are **derived** from an append-only ledger, never stored — same discipline
  as `kalshi-paper-ledger.js`. No shorting, no spending cash you don't have, limits fill at the
  limit price.
- **trade** — live money; refused unless BYOK *live* keys are connected, and `trading-guard`
  still decides independently.

**BYOK Alpaca is the destination and was already shipped** (`POST /api/broker/alpaca/connect-keys`);
the house ledger is only the on-ramp until a user connects, and is bypassed the moment they do.

A regression caught by the tests and worth naming: making demo the blanket default put every
*existing* user with a linked broker into the simulated book. "Never chose a mode" is not
"chose demo" — a connected broker still wins, and demo is the on-ramp only when nothing is
connected. Pinned by test.

Watchlists now seed at account creation (`watchlistStore.ensureSeeded`) rather than only on
first page load, so the collectors have warmed a new user's symbols before their first visit.
