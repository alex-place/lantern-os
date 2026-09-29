# experiments/parked_knobs — lab knobs that were measured and parked

A patch here is NOT live code. It is a knob that was built in the lab brain, replayed, scored in
`data/trading/prediction-ledger.jsonl`, and did not earn a place on master. It is kept so the
measurement can be repeated.

| patch | ledger rows | verdict |
|---|---|---|
| `step-floor-by-symbol.patch` (+ its test, `.txt` so no runner picks it up) | `floor-by-volatility-class`, `step-floor-by-name-13-windows`, `step-floor-mid15-30-unseen-quarters` | `TRADER_STEP_FLOOR_BY_SYMBOL`: the five 1x commodity and semiconductor funds at 1.5% pass thirteen windows 7-1 and are inconclusive on 30 unseen quarters (+0.014% a week over all 43); wider floors on the wrappers deepen the worst quarters. Parked 2026-09-29. |

Apply to a lab worktree only: `git apply experiments/parked_knobs/<name>.patch`, copy the test into
`apps/lantern-garage/test/` without the `.txt`, replay, then `git checkout` the brain again.
