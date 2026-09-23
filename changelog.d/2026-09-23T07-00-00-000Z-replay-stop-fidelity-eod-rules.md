### Fixed

- lab: **the two-sleeve replay never let a filled stop reach the brains' stop logic.** The mock account labeled protective stops `STP`, a spelling neither brain's stop-fill detection (`/^stop$/i` on `order_type`) recognizes, so in every replay to date a filled stop never armed the post-stop cooldown or counted toward the daily breaker — while both live boxes run both. The mock now says `Stop` (IBKR's spelling). Verified: race alone with cooldown and breaker off reproduces the ledger's recorded 15.83% / 2.34% exactly; with race's live default cooldown on it reads 12.68% at the same drawdown, so the one-day cooldown costs race's brain 3.2 points and the breaker never fires (`harness-stop-fill-fidelity`).

### Added

- lab: **end-of-day rules under measurement** in `experiments/replay_two_sleeve.js` (`variant.eod`): `flatLosers`, `flatLosersLev`, `flatNearStop`, `flatWeekend`, `trimLev`, applied to the mock book at the day's last bar as filled market sells the brain's fill ledger books like any broker fill, tagged to the owning sleeve. First use, the 2026-09-23 loss-reduction lab: every close-time loser rule reversed, the weekend-inverse flatten could not fire in the window, and the overnight 3× trim traced a clean linear return-versus-drawdown curve. Ledger rows `engine-full-size-R`, `carry-loser-rules`, `overnight-3x-trim-curve`, `weekend-inverse-flatten`.
