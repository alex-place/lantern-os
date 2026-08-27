### Fixed

- **Max-hold immunity now decays.** `max_hold` counts from `entryAt`, so a position with
  no recorded entry time was immune *forever* — and the class went live on the rule's
  first armed day: stable's state held TLT (entered by the engine at 12:10 that same
  day) with no persisted `entryAt`. An untracked position now **adopts a hold clock at
  discovery** — journaled as `max_hold_clock_adopted`, persisted across restarts, kept
  **separate from `entryAt`** so an old position never looks freshly entered to the
  maturity gate or min-hold, and cleared at every close site. Root cause treated too:
  a placed entry now saves state **in the same breath** as setting `entryAt`, instead of
  waiting for the next incidental save.
- **The operator-view sell path cancels the right book's stops.** The `#3468`
  cancel-first resolves a facade for the *requesting* uid — an admin in the operator
  view has no linked broker, so that facade is null, the cancel silently no-ops, and the
  send then hits the operator book where the stop's share reservation still refuses it
  (the SPXS trap, one path deeper). The same engine helper now runs a second time,
  resolved for `OPERATOR_UID`, settle wait included, fail-soft.
