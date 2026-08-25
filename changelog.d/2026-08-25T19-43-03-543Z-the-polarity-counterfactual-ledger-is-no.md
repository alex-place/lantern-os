### Fixed

- **The polarity counterfactual ledger is now evidence.** `#3343` built it so live
  data could settle whether inverse (economic-short) entries have an edge. Audited
  for the first time, it held 6,182 wrapper fires of which **67** were decisions
  the day-trader could ever have acted on: 2,112 landed on a weekend, 1,720 outside
  09:30–16:00 ET (one at 23:15 ET off a frozen 19:45 extended-hours bar, re-firing
  every 60s all night), and the rest were the same symbol re-logged inside one
  entry-cadence hour. Off-session fires are now refused at the writer
  (`TRADER_POLARITY_LOG_ALL=1` restores the firehose if extended-hours entries are
  ever armed). Every row carries its writing `pid`, and the `mode` field now records
  the rule that actually judged the fire rather than a second read of the
  environment.
- Consequence for anything that quoted the raw file: the naive count
  ("the veto blocks ~46% of candidates") was wrong by an order of magnitude. On a
  decision basis, in-session, the selective gate **allows 19 of 24**.

### Added

- `experiments/polarity_calibration.js` — replays the real fires the real engine
  saw, prices them on real forward bars (+30m / +60m / close), and decomposes the
  entry funnel. It reports the day-mix, mode and session confounds rather than
  averaging through them, so the sample it is willing to conclude from is the one
  that survives them.
