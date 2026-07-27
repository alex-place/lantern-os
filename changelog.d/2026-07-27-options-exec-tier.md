### Changed
- **The options trader is now the overnight book's 4th execution tier**, not a second
  engine. Its entry gate was a byte-for-byte duplicate of the book's SPY
  `uptrend+notflat` sleeve — same `close>SMA50 & MACD>0`, same rv10-vs-trailing-median,
  same 15:45 entry / 09:31 exit, same underlying — so the signal now lives in ONE place
  and `options-shadow` becomes the options *execution adapter* (chain discovery,
  quotes, paper order placement). `OVERNIGHT_EXEC=options` executes every sleeve as a
  next-day OTM call ladder (entry at the ask, exit at the contract's bid) instead of
  shares; `1x|2x|3x` are unchanged. `options-shadow.gates()` delegates its pass/fail
  to `uptrendGate` so the two can never diverge again, and when the book owns options
  execution the shadow's own ladder stands down — otherwise both would double-expose
  the same nightly signal on the same underlying, which the direction lock cannot
  catch (both legs are long the same family). The PENNY sleeve stays in the shadow: its
  intraday 2¢-target exit is a genuinely different holding period, not a duplicate.
