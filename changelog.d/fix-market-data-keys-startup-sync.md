### Fixed — finance news fell back to Yahoo-only (market-data keys not synced at startup)

The Windows User-env → `process.env` sync for market-data keys (`FINNHUB_API_KEY`,
`ALPHA_VANTAGE_API_KEY`, `FRED_API_KEY`) only ran **lazily**, the first time the
`/api/financial-keys` route was hit. A freshly-started server that nobody visited the keys
page on therefore had no keys in `process.env`, so `market-data-client.hasFinnhub()` was
false and the news collector **silently fell back to Yahoo RSS only** — few articles, one
source. The Explore Finance feed showed ~9 Yahoo cards instead of the hundreds it pulls when
Finnhub + Alpha Vantage are live.

Fix: `financial-keys.js` now exports `syncUserEnvKeys()`, and `server.js` calls it at
**startup**, before the news collector initializes. The collector then sees the keys and
pulls Finnhub general + per-ticker company news and Alpha Vantage sentiment (Reuters, MT
Newswires, GuruFocus, …) alongside Yahoo, restoring source diversity and volume.

Verified: `syncUserEnvKeys()` loads all three keys into a fresh process from Windows User
env, and `finnhubMarketNews("general")` returns 100 items once they're present.
</content>
