### Kalshi profitable-only strategy + σ-band phantom-edge fix

Adds `experiments/kalshi_live_strategy.py` — a Σ₀ profitable-only gate over the live
KXHIGHNY (NYC daily-high) order book. It turns the live asks into cards and emits one
**only** when a band-robust, net-of-fees, externally-grounded edge survives (the ≥100 °F
ceiling fade on extreme-forecast days); on an efficient day it emits **nothing**. An empty
deck is the correct output, not a failure — it is the discipline that separates a
disciplined book from the losing crowd.

Also fixes two calibration defects in `experiments/kalshi_weather_edge.py`, both found
against the live 2026-07-01 board:

- **No same-day nowcast σ tier** (`lead<=0`): a same-day high is far tighter than a
  day-ahead forecast, so using the day-ahead σ over-spreads the distribution.
- **σ-uncertainty band floor too high** (`SIGMA_LO`): it excluded the tight σ (~1.5 °F) a
  liquid market implies, so a routine-day "edge" rubber-stamped model-vs-market noise — a
  phantom `NO 94-95 +7¢` on the live board.

After the fix the live routine board correctly returns *"no certified edge"* while the
extreme-day ≥100 °F ceiling fade still survives (selfcheck green).
