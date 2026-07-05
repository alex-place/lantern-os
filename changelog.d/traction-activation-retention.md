### Traction: activation + daily-active retention instrumentation (#2040, #2041)

Extend the existing evidence-classed traction pipe (`lib/traction.js`) with the two
missing funnel signals the report-card flagged (Traction "D"):

- **#2040 activation** — a user's first successful chat reply now emits a single
  verified `activation` event (`recordActivationOnce`, idempotent per actor). Wired
  into `routes/dream.js` alongside the existing `workflow_used` emit.
- **#2041 daily-active retention** — an authenticated session start emits at most one
  `daily_active` event per actor per UTC day (`recordDailyActive`), wired into
  `session-identity.setSessionUser`. Feeds the summary's distinct-day retention so
  D1/D7 return is computable from the ledger — the Traction row becomes MEASURED.

Both are fire-and-forget + non-fatal (telemetry never breaks a reply or login), and
duplicates collapse via the summary's per-actor / per-day Sets. Loop stage: **Observe**
(measure adoption + retention). Tests in `test/traction.test.js`.
