### Fixed

- **trader: five money-path bugs from the 2026-08-08 entry/exit audit.** (1) The
  placed broker stop now uses the same derived stop (`_stopDistEff`, target÷3
  floored/capped) that sized the position and passed the RR gate — it used to
  place the pre-derivation structural stop, so realized risk ran 1.6–2.4× the
  configured `riskPct` and the RR≥1 gate passed trades whose true geometry was
  below 1:1 (probe-verified). (2) The daily-loss circuit breaker now accepts the
  `{dailyPnl}` object shape the Alpaca/house/demo facades return — it silently
  never armed on any non-IBKR account. (3) The gross cash-reserve brake counts
  notional placed earlier in the same scan (same start-of-scan-snapshot blind
  spot the concurrency cap had; probed stacking to 126% of budget). (4) An
  in-flight exit whose parked order died at the broker un-freezes after two
  order-less scans plus the re-fire debounce instead of stranding the position
  from every engine exit — and the "unclosable" 3-strikes freeze is now a
  backoff (retry after `TRADER_UNCLOSABLE_RETRY_MIN`, default 60) instead of a
  life sentence, so a transient order-path outage recovers on its own. (5) The
  10s fast-exit loop now honors the per-user active-trader switch (#3212): an
  'off' account is fully hands-off and a 'champion' account no longer gets
  day-trader exits unwinding the allocation book. New regression suite
  `test/entry-exit-brakes.test.js` drives all of these through the real module.
