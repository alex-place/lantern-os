Added the **options DATA layer** (#2580): `lib/options-data.js`, an Alpha Vantage
HISTORICAL_OPTIONS chain/IV client gated by `ALPHAVANTAGE_API_KEY`, exposed at
`GET /api/trading/options/chain?symbol=SPY&date=YYYY-MM-DD`. Rows are normalized
to typed contract records (contract, call/put, strike, expiration, bid/ask/last,
volume, open interest, implied volatility, greeks only when the feed carries
them). Free-tier manners built in: 15-minute in-memory cache per symbol+date and
a rolling 5-requests/min limiter that **refuses with an honest
`retry_after_s`** instead of hammering. Keyless boxes degrade honestly —
`{ available: false, reason: "ALPHAVANTAGE_API_KEY not configured" }` — never a
throw, never fake data; upstream "Error Message"/"Note"/"Information" notices
are surfaced verbatim. Data only: no trading, no recommendations, no Advisor
changes. Fully offline unit suite (`tests/test_options_data.js`) covers
normalization against the live payload shape, keyless shape, cache hits,
malformed payloads, and the rate gate. (Improves Observe — real options-market
evidence, honestly bounded.)
