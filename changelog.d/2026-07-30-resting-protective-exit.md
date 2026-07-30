### Added
- **Broker-side resting take-profit on every overnight option leg.** The engine's exit
  lived entirely in this process, so a dead process meant a position with *no* exit —
  on 2026-07-29 a 0-DTE ladder expired worthless (−$2,006). Each entry now also rests a
  **GTC sell limit at +50%** (`OVERNIGHT_PROTECT_TARGET_PCT`, 0 disables) on the broker,
  which survives the process entirely. It's a safety net, not the strategy: the 09:31
  window remains the primary exit.
  - **Naked-short guard:** a resting sell that outlives its long would go short on its
    next fill, so the exit retires the protective order *first* and **refuses to sell**
    if the cancel fails — the leg is retained in state and retried next tick rather than
    risking two sells against one long.
  - A protective order that filled while the engine was away is booked as the real exit
    (`protective_fill`); a 404 on cancel is treated as success (nothing is resting).
  - GTC support on Alpaca options was verified empirically before building on it.
