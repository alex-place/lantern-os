### Fixed
- **The re-protect pass was stacking a protective stop every scan.** Its `hasStop()`
  guard matched only IBKR's *native* status words (PreSubmitted/Submitted/Pending) and
  only an `orderType` key, but the normalized order shape says **`open`** and puts the
  kind in **`type`** — so the guard never matched, the engine believed every long was
  naked, and it added another GTC stop-sell on every pass. Measured on the live paper
  account: **488 resting stop-sells, ~33 per symbol, 95,561 shares against 3,772
  held — a 25× oversell** that would have flipped the book heavily short on any gap
  down. The guard now accepts every status/key spelling the stack produces.

### Added
- `scripts/verify-exits.mjs` — pairs each logged exit decision against broker truth
  (order status + whether the position is actually gone). It **aborts** rather than
  reporting success when positions can't be read: its own first version printed a clean
  bill of health for 13 stalled exits purely because the API call had 302'd.
