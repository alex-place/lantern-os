### Weather-edge forward tests: first oracle-vs-market certification runs (read-only)

Three rerunnable harnesses promoted to `experiments/weather_*.js` + grounded findings in
`docs/research/2026-07-23-weather-edge-forward-tests.md`: day-ahead UHLGA certification FAILS
(oracle RPS 0.253 vs board 0.177, −$1.68/unit hypothetical); day-of nowcast vs Kalshi executable
prices is breakeven (+$0.32/38 trades net) with the market efficient by ~1pm ET; cross-venue
Kalshi→ForecastEx shows +$6.63 (7/7 days) that is explicitly LOOK-AHEAD (overnight info flow,
not edge) pending same-time live FEX quotes; realized LGA−KNYC basis measured +1.48°F σ1.70
(n=52). Lesson codified: beating a default model ≠ beating the market.
