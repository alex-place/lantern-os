### Added

- Greenpath release gate (#2545): `npm run test:greenpath` boots the real server and walks the full signup → paper-trade → chat → Pro journey for 10 demo accounts (real-browser signup with the hard email gate, watchlist, Free→Pro upgrade gate + staff upgrade, Kalshi paper trade, two-turn chat recall of the trade, Alpaca status, BYOK set/clear, journal + exit-tag). Per-account × per-step pass/fail is persisted to data/greenpath-runs.jsonl; docs/GREENPATH-GATE.md documents it as the gate for the first-50 invite program
