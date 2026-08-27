### Fixed

- **`cadence-reentry.test.js` failed after midnight ET.** It anchored to
  `Date.now() - 40 minutes`, which straddles the ET date boundary once the clock passes
  00:00: the exit lands on 08-26 at 23:51 and "now" on 08-27 at 00:31, the same-session
  check correctly returns `false`, and the assertion fails. Written at 02:35, red by
  00:31 the next night — and it took master red with it.

  The feature is correct: 23:51 and 00:31 genuinely are different sessions. The fixture
  now uses fixed ET instants, and that boundary is pinned by its own test rather than
  left to the wall clock.

  Same class as the `LNG` fixtures fixed in `#3459` — a test whose verdict depends on
  *when* it runs. Sessions are this suite's subject, so the clock has to be an input.
