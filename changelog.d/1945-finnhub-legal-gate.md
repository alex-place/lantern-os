fix(trader): gate Finnhub news behind an explicit paid-license flag — free tier can't feed the paid surface (#1945)

Finnhub's free tier prohibits commercial use and unisona.ai is monetized, so the
old "use Finnhub whenever FINNHUB_API_KEY is present" gate was a legal hole.
`lib/news-collector.js` `_collectFromFinnhub()` now runs only when consent is
explicitly asserted — `FINNHUB_COMMERCIAL_LICENSED=1` (paid plan) or
`FINNHUB_DEV_ONLY=1` (local dev, never shipped). Default: Finnhub skipped (logged
once); the compliant Yahoo + Alpaca-dashboard sources carry the feed. Covered by
`test/finnhub-legal-gate.test.js` (5 checks). Strengthens **Act** (grounding-source
integrity). Yahoo ToS flagged for Alex as a separate product-legal decision.
