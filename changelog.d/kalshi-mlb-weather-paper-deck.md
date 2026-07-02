### Added
- **Paper KXMLBTOTAL weather-edge deck** (`/api/trading/kalshi/mlb-weather-deck`) — the MLB
  run-total sibling of the Σ₀ KXHIGHNY weather deck. Deterministic (no LLM/key): NWS
  game-time conditions per ballpark → run-total tilt (wind-vector/temperature/roof-state/
  precip) → paper hypotheses on weather **tails only**, net of fees, best worst-case edge
  first. New libs: `kalshi-mlb-parks` (30-park DB + Kalshi game-code splitter),
  `kalshi-mlb-weather-model` (physics tilt + self-test), `kalshi-nws-point` (generic NWS
  point/hourly adapter). PAPER-ONLY and **explicitly not in live scope** — live real-money
  trading stays code-locked to `kalshi-weather-edge`. Logs to
  `data/kalshi/mlb-weather-paper-ledger.jsonl` so the one unproven assumption (how much of
  the tilt the market leaves unpriced) can be measured, not assumed (n=0 = honest). Wind
  vector is suppressed until a verified per-park orientation table is wired.

### Fixed
- **Weather-edge deck stale displays**: the deck note no longer hardcodes "live trading
  remains paused" — it now reflects the real gate state (LIVE ARMED / paused / kill-switch /
  gate-off), and each card surfaces `liveContracts` (½-Kelly paper size clamped to the live
  per-order cap) so a card can never imply it will place 25 contracts when the live cap is 1.
