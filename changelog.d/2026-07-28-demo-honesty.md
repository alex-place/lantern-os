### Fixed
- **The guest demo portfolio is now honest.** A visitor reported the trader page
  showing "the same numbers for days" with no indication it was simulated — the demo
  fixture used baked mid-July prices that never moved, and the only label was a
  4-character DEMO badge. Now: (1) the simulated Champion book is **marked to live
  market prices** on every request (real quotes for all 8 holdings; equity, day P&L,
  and per-position marks move with the market; fail-soft to the static snapshot with
  `marked_to_market:false` if quotes are down), and (2) an **unmissable banner** sits
  above the deck for guests — "SIMULATED PORTFOLIO … not a real account" — dismissible
  per session, with a sign-in link.
