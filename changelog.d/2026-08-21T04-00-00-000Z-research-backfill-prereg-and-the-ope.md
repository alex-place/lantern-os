### Research — price backfill, pre-registration, and the operator's patent triage recorded

The one mill family that keeps surviving needs market prices; the benchmark parquet ships them
null. Kalshi has scrubbed settled markets from every live listing (public and authed both return
zero) — they live behind the /historical/ routes, which carry last price, bid/ask and result.
backfill_kalshi_probs.js recovers them read-only for all 1,531 rows, matching by exact close time
with result-agreement fallback, absence recorded rather than imputed.

PREREG-market-supervised-probe.md fixes the gates before the data lands: P0 kills the
retrospective arm if close prices are degenerate (<20% of rows inside [0.05,0.95]); P1 is a
one-day probe comparison (market-graded vs correctness labels, ECE −20% relative at ≤2pt AUROC
cost); shuffle and de-gloss controls mandatory. The durable version is prospective: one JSONL
append in kalshi-collector logs pre-close prices at horizons nothing public can reconstruct.

The operator's external patent triage is recorded in docs/research (not ratified — its "low
density" cells are the same silence-as-novelty inference our red team killed twice), with the
corroborations our machinery can vouch for and the protocol runs still owed on its survivors.
