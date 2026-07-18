### Added
- **Kalshi collector send-on-delta cadence** (`lib/kalshi-adaptive-poll.js`, flag `KALSHI_ADAPTIVE_POLL=1`,
  default off) — replaces the fixed 6s clock with a self-triggered poll delay `β/σ²ₘₐₓ` computed from the
  measured per-market variance rate (arXiv:1707.02531 / 1609.07534, per the control-engineering tranche
  analysis, build item #1). Floor 6s (never faster than today), 60s cap when quiet, 60s/30s idle cadence
  when the exchange is closed / between games, and an immediate floor-reset on a ≥3¢ spike. The collector
  now runs a setTimeout chain (non-overlapping polls) instead of setInterval; `getStatus()` gains
  `mode`, `currentIntervalMs`, `nextPollAt`, `lastReason`, and scheduler stats.
- `experiments/kalshi_send_on_delta_replay.js` — replays recorded tight-band snapshots through the scheduler
  vs fixed-cadence baselines, measuring staleness (RMSE cents) against request/disk savings.

### Notes
- **Measured, honestly:** on a busy 2.85h / 92-market live MLB slate, adaptive polls 99.9% of ticks with
  RMSE identical to baseline (0.283¢) — batching all markets into one request means the batch is only as
  fresh as its fastest mover, so a busy board correctly stays at the floor and saves ~nothing intra-slate.
  The banked win is idle time: the old loop polled `getExchangeStatus()` every 6s around the clock, so the
  ~16h/day the exchange is closed burned ~9.6k wasted requests/day; the 60s idle cadence cuts that ~10×.
  The 3× "in-model" figure is per-signal and does not survive batching — shapes transfer, guarantees don't.
