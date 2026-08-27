### Added

- **`experiments/replay_auto_trader.js` — replays history through the REAL `runAutoTrade`.**
  A mock bridge stands in for the broker and `lib/market-data-yahoo` is stubbed to serve
  cached bars truncated at the simulated instant, so the engine's own gate order, cadence,
  cooldowns, sizing, stop placement and exit stack all run unmodified. Every other lab in
  `experiments/` reimplements a subset of the engine; this one does not.

  It paid for itself immediately. A reconstruction had concluded that `persistence` and
  `falling_knife` were destructive together and should be replaced by a single rule. The
  replay reversed it on the same 60 sessions and symbols:

  | variant | reconstruction | replay (real engine) |
  |---|---|---|
  | persist + knife (live) | +3.38%, ret/DD 0.95 | **−0.25% — best of four** |
  | persist alone | +7.62%, ret/DD 2.69 | −0.73% |
  | knife alone | +7.83%, ret/DD 2.19 | −0.21% |
  | neither | +11.43%, ret/DD 4.13 | **−1.35% — worst of four** |

  Cause: the reconstruction models ~6 gates, the engine runs ~20. Removing a turn filter
  there yields more clean trades; in the engine it yields more trades the remaining gates
  handle worse. The "neither" row was carrying the whole argument and is last on the real
  path. **The consolidation proposal is withdrawn.**

- Supporting labs kept as the record of rejected findings, each with its limits in the
  header: `loss_cut_lab.js`, `recycle_1m_lab.js`, `reversal_60d_lab.js`,
  `turn_consolidation_lab.js` (marked SUPERSEDED, do not quote its rankings).

### Known limits

- The replay steps in 5-minute bars while the engine scans every ~60s. `persistWindowMs`
  defaults to 200,000 ms ("about 3 scans"), so at a 5-minute step no streak is ever fresh,
  the counter resets every bar and persistence can never reach 2 — the first run silently
  took **zero trades** on two of four variants. The harness scales the window to its own
  step to preserve the rule's meaning; any future gate with a wall-clock window needs the
  same treatment.
- Entry signals are reconstructed from IBS rather than replayed from `scan.js`, so the
  signal *population* is still a model even though every gate after it is real.
