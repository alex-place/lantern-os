### Fixed
- **The overnight engine can no longer fail silently.** A tick that does nothing now
  says so: one deduped heartbeat row per ET day (including when it's disabled or has
  no broker bridge), and the 15:45 entry window always records a verdict — entered,
  skipped-with-reason, already-entered, or still-holding. On 2026-07-30 the window
  produced *no row at all*, making "correctly declined a no-signal night" and "the
  scheduler never ran" indistinguishable in the ledger — the same ambiguity that hid
  the 2026-07-29 outage until the position expired worthless.
- **Exits stop retrying a position that can't be closed.** After 3 consecutive
  terminal failures a symbol is declared unclosable: frozen from both exit paths,
  logged once as `exit_frozen`, and released automatically when the position leaves
  the book. A 0.8-share SOXS remnant (IBKR rejects fractional orders) had been
  re-deciding every ~9 minutes for 5.5 hours — 39 identical error rows that drowned
  the day's real activity.
