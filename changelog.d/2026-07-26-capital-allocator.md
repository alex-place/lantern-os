### Added
- **Capital allocator** (`lib/capital-allocator.js`, `GET /api/trading/allocator`) —
  one book over the trader sleeves: Kelly-lite budgets from each sleeve's OWN live
  ledger (evidence-shrunk, per-sleeve caps 20/60/1%, exploration floors while
  unproven, shared-regime damper pins the long-biased intraday sleeve to its floor
  in an SPY downtrend). The overnight engine now takes its allocation from the
  allocator unless OVERNIGHT_ALLOC_PCT explicitly pins it. Places nothing; engines'
  own safety gates unchanged. 5 unit tests.
### Changed
- **Champion account separation** (operator rule): the Champion is an INVESTOR —
  `rebalanceNow` executes only on its own dedicated identity (`CHAMPION_ALPACA_*`
  keys / a `champion-book` connection, same no-borrowing contract as Sigma) and
  refuses with a clear reason when none is configured. Advisory `plan()` still
  works on any account; orders never touch the traders' book.
