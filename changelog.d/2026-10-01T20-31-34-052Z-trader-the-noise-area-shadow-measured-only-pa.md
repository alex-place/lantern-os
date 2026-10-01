### Fixed

- trader: the noise-area shadow measured only part of the day — the live 5m feed keeps about 14 sessions (2,600 bars with the extended hours) and the band needs 15, so QQQ and SMH had no band on 2026-10-01 and SPY lost it from 12:30; an older settled window of bars is now merged under the feed
