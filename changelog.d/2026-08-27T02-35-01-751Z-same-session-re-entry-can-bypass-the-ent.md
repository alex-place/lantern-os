### Added

- **`TRADER_CADENCE_REENTRY=1`** — lets a symbol the engine already exited **this
  session** bypass the entry-cadence gate. Default **off**.

  Why: recycling was the edge, and the cadence ended it. Live daily history, stable —
  week 1 ran 9.4 entries/day with **3.2 same-session re-entries/day** and made
  **+$13,764**, its two best days being its two highest-recycle days (08-14 +$6,803 and
  08-10 +$3,073, six recycles each). From 08-17 the recycle count is **zero — every day,
  ten trading days running** — and the book is **−$1,368**. Since 08-24 `entry_cadence`
  is the largest single entry blocker (99, 85, 72 rows/day), and of **26 exits across
  08-24..08-26 only two ever came back**.

  The lockout compounds: exit at 10:20 → the 45-minute cooldown holds until 11:05 → but
  the cadence only decides at 11:00 → that bar is missed → wait for 12:00, by which time
  the symbol must out-rank every fresh candidate.

  Narrow by construction: it bypasses the **cadence only**. Cooldown, post-stop cooldown,
  the concurrent cap, the maturity gate, the morning gate, falling-knife and every sizing
  guard are untouched, and a re-entry **never spends the bar**, so a recycle cannot cost a
  fresh symbol its hourly decision. Each one journals a `cadence_reentry` row and tags the
  entry with `reentry: true`, so the effect is measurable from day one.

### Known limit

- **No backtest can settle this.** The cadence was validated on daily and hourly bars —
  a surface that structurally cannot represent a second entry into the same symbol on the
  same day. It measured what the cadence does not affect and was blind to what it
  destroys. This is a live question, and the flag exists so it can be A/B'd on one box.
