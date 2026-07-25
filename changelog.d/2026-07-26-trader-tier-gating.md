### Changed
- **Trader tier gating** (operator tiering): the allocator **Book** is a staff-only
  surface (admin tab + 403 on the API for everyone else); the **Advisor** is a $20
  Pro capability; the **trading terminal** page locks for Free users behind an
  upgrade card (Watch stays free); the **AI autopilot** is a $200 Pilot capability
  (per-user autoscan skip). Plan gates follow the product-wide PLAN_ENFORCEMENT
  flag; UI hiding is live now. plan-matrix gains trade_terminal / advisor /
  options_manual (pro) and the missing pilot→pilot role mapping.
### Added
- **Manual paper options ticket** (`POST /api/trading/options/order` + the Options
  page): click any call/put row in the chain to load the contract, set side/qty/
  limit, and place YOUR OWN paper option order — the AI has no control over it.
  Paper-host-only in code; signed-in users (Pro capability once enforcement is on).
  Verified live: order accepted on the paper account and canceled cleanly.
