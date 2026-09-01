### lab(trading): prediction ledger — every backtest verdict becomes a scored, falsifiable prediction

The operator's charge: "our backtests often tell the opposite of what actually
happens — we can't know how many good fixes we rejected and bad fixes we
approved." Now we can. `data/trading/prediction-ledger.jsonl` records every
instrument verdict as a prediction (change, instrument, claim, metric, horizon);
`experiments/score_predictions.js` scores due predictions against the live
journals and keeps a per-instrument hit-rate. Seeded with the full history: the
scoreboard's opening read is 4 confirmed vs 7 reversed/misleading (36%) across
resolved predictions — the 26y analog, the threshold lab, the session-only lab
and the LLM judge are all 0-for-1+, and the one engine-replay verdict that
resolved was invalidated by config infidelity.

The two worst mechanical failure classes get tripwires in the replay harness:
`REPLAY_ARMED_ENV=<.env.local>` merges the armed knobs into BASE printing every
difference (the missing hour block flipped the decarry verdict's sign), and each
variant now prints its gate-skip census plus an INVALID marker under 5 trades
(twice the harness produced plausible numbers while a gate silently never fired).
