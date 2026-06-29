### Autowork test gate: a timeout is inconclusive, not a failure

The self-coding loop rolled back good patches whenever a planned test **timed out** — e.g. an
integration/API test (`node tests/test_dream_journal_api.js`) waiting for a server that isn't
running in the per-run worktree. `runTests` now marks a timeout `ok: null` (skipped/inconclusive),
and the gate fails only on tests that actually **ran and asserted false** (`ok === false`);
`testsVerified` requires at least one real pass, so an all-inconclusive run opens a draft PR flagged
unverified rather than being discarded.

Measured impact: the dogfood run that previously died at `tests_failed` (changes rolled back) now
carries a correct patch through to a **draft PR** — proven on the attachment-guard self-fix (#1588).

Also adds `experiments/council_outcome_backtest.py`, the provable-demo instrument: it measures the
self-coding success rate on real owned runs (12% baseline; 77% of failures at provider "start") and
reports the Δ↔outcome join gap honestly (council Δ is on chat replies, autowork runs have outcomes
but no Δ — one wire closes it).
