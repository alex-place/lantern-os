---
author: Alex Place
created: 2026-07-03
---

# Audit: does master's Node/IBKR trader have the Python engine's bugs? — Σ₀ review

Master deleted the Python/Alpaca trader and replaced it with a Node engine
(`lib/signal-engine/*` + `lib/ibkr-cpapi.js` + `lib/trader-agent.js`). Four bugs were fixed
on the old engine (churn cooldown, exit debounce, equity-anchored Day P&L, broker-sourced
readiness). Do they exist here? Each finding carries **[evidence · confidence]**.

## The decisive structural fact

**The new engine does not trade autonomously.** *(high)*
- `signalEngine.scanAll(watchlist)` returns `{signals, zones, logs}` — **analysis only**, it
  places no orders. *(scan.js:181; trader-agent.js:119.)*
- `traderAgent.placeOrder(...)` has exactly **one** caller: the manual `POST` order endpoint
  (`routes/trading.js:550`). No scheduler, cron, or `setInterval` calls it — a grep for
  autonomous trade loops over trader-agent/signal-engine/server returns **nothing**.
- Every real order passes `trading-guard.js`, whose **default posture is DRY**: no real order
  is placed unless `TRADER_LIVE=1` is set, there's no kill-switch file, qty/notional are under
  caps, and the account is paper (or a second live opt-in is set). *(trading-guard.js header.)*

The old bugs were all **symptoms of the old autonomous scan-and-trade loop** firing every
minute. That loop is gone. So:

## Findings

1. **Re-entry churn (#1) — DOES NOT EXIST.** Nothing auto-opens positions, so there is no
   buy→sell→buy round-trip loop to guard against. *(high; single manual placeOrder caller.)*
2. **Exit cancel-storm (#2) — DOES NOT EXIST.** Nothing auto-closes positions in a loop; the
   only close path is the manual Kalshi paper-ledger close (`routes/trading.js:1518`). The
   Python `close_position` cancel-then-resubmit storm has no analogue. *(high.)*
3. **Day P&L not reconciling with equity (#3) — NOT A BUG here.** `getPositions()` reads
   `equity`, `cash`, `unrealizedPnl` straight from **IBKR `getAccountSummary()`**
   (trader-agent.js:328-334; ibkr-cpapi.js:84-89) — broker ground truth, **no local
   trade_history ledger** to under-report. The old under-reporting cannot occur. *(high.)*
   - *Caveat (feature gap, not a bug):* the account object exposes no **Day P&L**
     (`equity − last_equity`) at all — realized-today isn't surfaced. If the UI wants a day
     figure it must be added from IBKR (`realizedPnl` is available at ibkr-cpapi.js:85).
4. **Ledger-based readiness (#4) — NOT A BUG here.** There is **no readiness/graduation gate**
   in the new engine (grep: none in trader-agent). So nothing reads the under-reporting ledger.
   *(high; feature absent.)*

## Conclusion

Master effectively **fixed #1–#3 by deletion**: removing the autonomous Python churn loop
removed the churn, the cancel-storm, and the ledger-based P&L in one move. The new engine is
manual + DRY-by-default + broker-sourced, so it is **architecturally immune** to those three,
and #4 simply doesn't exist yet. **No fixes are needed today.**

## Forward-looking gaps (build BEFORE arming autonomous/live trading)

These only matter if `TRADER_LIVE=1` autonomous execution is ever added on top of this engine:

- **Day P&L from equity.** Surface `equity − last_equity` (or IBKR's realized+unrealized) so
  the header reconciles with Equity — cheap, and avoids re-introducing a ledger later.
- **Broker-sourced readiness gate.** Before any go-live arm, gate on trades/win-rate/Sharpe
  reconstructed from **IBKR fills** (not a local ledger) — the exact pattern from the Python
  `get_graduation_analysis` rewrite (FIFO over broker fills) ports directly to `ibkr-cpapi`.
- **Churn guards, proactively.** If an autonomous executor is ever wired to `placeOrder`, add
  a re-entry cooldown + an exit debounce **at that layer** so a future auto-trader can't repeat
  the Python engine's churn. Until then they'd guard code that doesn't run.

## What this audit does NOT claim

It does not assess the *signal quality* of the new engine (SR-zones / RSI / tesseract) — only
whether the four operational bugs are present. They are not. The DRY guard was read, not
exercised against a live IBKR gateway.
</content>
