### Added

- trader: the session record now publishes `family_beta_exposure` — exposure per family weighted by leverage magnitude, the number the notional-based gross cap cannot see. A 3x wrapper at 6% of equity carries 18% of market risk; on 2026-08-18 that hid 30.2% of the book in semis (SMH 12.1% + SOXL 18.1%) going into a 4.33% sector drop, 67% of that day's loss, with no log reporting it. Recorded, deliberately not capped — measured over 2026-08, 3x round trips returned +0.714%/trade on notional against 1x at +0.057%, and the two highest-concentration sessions were the two best days

### Fixed

- trader: `stops_fired` no longer undercounts stop fills the venue labelled otherwise. SOXL exited at 130.76 against a recorded stop of 130.77 and was logged `broker fill`, so the session read 0 stop-outs for a day in which a stop plainly filled. Exits printing at or through their entry's recorded stop are now counted as `stops_by_price`, kept separate from the reason-matched count so the #3281 ambiguity stays visible
