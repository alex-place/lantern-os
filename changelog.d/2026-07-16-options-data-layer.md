Added the **options DATA layer** (#2580), reworked as a **NO-NEW-KEYS provider
chain** in `lib/options-data.js`, exposed at
`GET /api/trading/options/chain?symbol=SPY&date=YYYY-MM-DD`: **(1) Alpaca** —
the user's own connected account (ADR-0027 OAuth, or existing operator server
keys), options snapshots with quotes, IV, and REAL greeks (labeled
`delta_source: "provider"`); **(2) Yahoo** — keyless public chain (cookie+crumb
handshake, v7 options, per-expiry fetches spread across the requested DTE
window so daily-expiry symbols like SPY don't cluster at the front), carrying
the real underlying price; Yahoo has NO greeks, so a Black–Scholes delta is
computed from Yahoo's own IV for selection only and labeled
`delta_source: "model(bs-from-iv)"` — never passed off as feed data; **(3)
Alpha Vantage** — demoted to last resort, used only if a key already happens to
be configured (its 5-req/min manners kept). Rows are normalized to one typed
record shape; every result carries `source`; provider failures are collected
and an all-providers-failed call returns `{ available:false, reason:
"<provider>: <why>; …" }` — never a throw, never fake data. 15-minute chain
cache; the requesting user's id is forwarded so a connected Alpaca account is
used automatically. Data only: no trading, no recommendations. Fully offline
unit suite (`tests/test_options_data.js`) covers all three parsers, the
fall-through order, windowed expiry picking, the all-fail shape, caching,
dated-session routing, and the AV rate gate. (Improves Observe — real
options-market evidence with zero new keys, honestly bounded.)
