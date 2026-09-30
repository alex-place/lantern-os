### Fixed

- trader: a halted or dry account keeps its protective stops. Each pass asks the broker leg whether a sell can go out; while it can't, the engine changes no stop and fires no exit (it used to cancel the stop and then have the sell refused). The manual sell path asks too (ADR-0035 step 1, review H1)
- trader: an extended-hours exit deferred to the open now waits on every later check, not only the first; a real exit supersedes a pending deferral; the open's flush never stacks on a resting sell (review H2)
- trader: a failed positions read is "unknown" everywhere (IBKR client and bridge, Alpaca and house facade legs), so the engine stands down instead of reading a flat book; entries also wait, per account and for at most the flat-confirm window, while a read comes back short of its last trusted book with nothing on record to explain it (review H3)
- trader: the scan and fast-exit loops no longer run on the same account at once, and journal rows are tagged with the user of the pass that wrote them even when passes interleave (review M1)
