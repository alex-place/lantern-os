### Changed
- **Kalshi terminal redesign — RobCo/Pip-Boy phosphor skin.** The whole page now uses
  the shared `data-skin="terminal"` treatment (matching dream-chat): phosphor green-on-black
  in dark, mint "daylight terminal" in light, with the ▚ toggle in the nav. Dark is the
  default for the terminal.
- **Right column: account balance + trade history.** New always-visible side column shows
  the live Kalshi balance and a scrollable trade-history list (newest first; paper history
  in PAPER mode, fills in LIVE mode), refreshed every 30s and after each trade. Stacks below
  the console on narrow screens.
- **Removed deck noise** — the "● LIVE — N swiped" counter, the verbose deck note, and the
  reload-deck button are gone; the idle state is a quiet `◉ SCANNING FEED…` pulse. Cards
  load continuously.
- **Paper deck is playable again** — now led by the Σ₀ weather-edge cards (paper practice)
  plus non-crypto candidates, so it is never empty after the crypto removal.

### Added
- `kalshi-paper-ledger.getHistory()` + `GET /api/trading/kalshi/paper-history` — opened+closed
  paper trades, newest first, for the terminal's trade-history column.
- Live-arm awareness in the weather-edge deck: each card surfaces the paper ½-Kelly size
  AND the cap-clamped `liveContracts` it would actually place, so a card never implies it
  will place 25 contracts when the live cap is 1.
