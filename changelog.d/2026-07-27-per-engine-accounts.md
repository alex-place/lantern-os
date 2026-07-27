### Changed
- **Each trading engine gets its own account** (operator rule): the intraday day-trader
  and the overnight sleeve book no longer share a book, so each engine's P&L is
  independently measurable — entangled equity made "did the overnight book make money?"
  unanswerable, and measurement is the point while the sleeves earn their edge.
  `overnight-trader` gains a dedicated `overnight-book` identity (`OVERNIGHT_ALPACA_*`
  keys, no fallback to the day-trader's account — the same no-borrowing contract Sigma
  and Champion already have) plus an explicit `OVERNIGHT_BROKER=alpaca|ibkr` switch
  that bypasses the global `BROKER_PREFER` so the book can't drift onto another
  engine's broker. Status now reports `broker` + `account`.
