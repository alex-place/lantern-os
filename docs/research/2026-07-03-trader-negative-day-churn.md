---
author: Alex Place
created: 2026-07-03
---

# Why the trader was ~−$322 today, and the P&L that didn't match equity — Σ₀ review

**Question:** the account showed Day P&L −$60 while Equity was down far more; find why it was
so negative and why the P&L didn't reconcile. Fix, test, review. Every claim carries
**[evidence · confidence · source]**.

## Finding 1 — the account really was down ~$322; the panel under-reported it

- **True day change = equity − last_equity = −$326** (live), vs the panel's **−$60**.
  *(high; live `alpaca.get_account`: equity 99,826.95, last_equity 100,153.25.)*
- The panel computed Day P&L = **local-ledger realized + Alpaca unrealized**. The
  `trade_history` ledger logged only **−$37** realized while the equity-implied realized was
  **−$287** — a ~$250 gap. *(high; cli.py `_day_pnl` old path + live compare.)*
- **Fix:** anchor Day P&L to `equity − last_equity` and DERIVE realized (`day − unrealized`), so
  `Realized + Unrealized == Day P&L == equity change` always. Verified live: −287.01 + −35.57 =
  −322.58 = equity − last_equity. *(high; `src/trading_agents/cli.py` `_day_pnl`.)*

## Finding 2 — the loss driver is CHURN (over-trading), not a directional bet

Reconstructed from Alpaca's own FILL activities (the ground truth), last 100 fills over ~11h:

| Symbol | buys | sells | realized | notional traded |
|---|---|---|---|---|
| AAPL | 18 | 17 | −$1.08 | **$88,594** |
| AMD | 12 | 14 | −$7.87 | **$46,055** |
| BTC/USD | 4 | 4 | −$23.81 | $39,963 |
| SPY | 5 | 7 | +$3.09 | $26,716 |
| SOL/USD | 4 | 3 | −$22.11 | $9,976 |
| INTC | 8 | 3 | −$10.96 | $13,637 |

- **>$300k of turnover in 11h on a ~$100k account, realized −$62.75 in 100 fills alone** — the
  account round-trips the same names dozens of times, bleeding the bid/ask spread with ~zero
  edge. BTC cadence: **8 fills in 9 minutes**, buy-high/sell-low each time. *(high; Alpaca
  `get_activities(FILL)` FIFO reconstruction.)*
- The residual vs the −$326 (beyond today's US-session realized/unrealized) is **overnight
  crypto** — a 24/7-crypto account measured against a 4pm-ET `last_equity` baseline. This is
  also *why the old code avoided `equity − last_equity`*; but that number is still the honest
  equity change and the only one that reconciles with the displayed Equity. *(medium-high.)*
- This is the same churn pattern as the earlier 5-duplicate-instance incident, but persists on a
  **single** instance — so the strategy itself over-trades, independent of duplication.
  *(high; single-instance lock already in place, churn still present in fills.)*

## Fix — anti-churn re-entry cooldown

`agents.py`: `close_position()` stamps `_last_close_time[symbol]`; the entry gate blocks
re-opening a symbol within **`REENTRY_COOLDOWN_SEC` (default 900s / 15 min)** via
`_in_reentry_cooldown()`. This directly kills the buy→sell→buy round-trips (a 1–2 min cadence
can no longer re-fire for 15 min). Tunable; `REENTRY_COOLDOWN_SEC=0` disables.
Unit-tested (`tests/test_reentry_cooldown.py`, 5 cases: blocks recent, allows after elapse,
unknown symbol, disabled, stamp mechanism).

## Still open (flagged, not yet fixed)

- **The `trade_history` ledger under-reports** — it missed ~$250 of realized. Anything reading
  it is biased **optimistic**, including the **readiness gate** (`get_graduation_analysis`:
  win-rate / Sharpe / realized). The panel no longer depends on it, but the go-live gate still
  does. **Recommended follow-up:** source realized + the readiness stats from Alpaca
  (portfolio history / activities), not the local ledger. *(high priority for real-money.)*

## What this does NOT claim

The cooldown reduces churn; it does not prove the underlying strategy has positive edge — that
still needs a clean forward track record (post-cooldown) graded against Alpaca truth. No claim
that −$322 is fully explained to the cent; the dominant, actionable driver (churn) is
established, the rest is overnight-crypto/baseline noise.
</content>
