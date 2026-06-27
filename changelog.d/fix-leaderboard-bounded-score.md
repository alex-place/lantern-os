### Fix: PCSF leaderboard score is a bounded win rate, not a runaway accumulator

The Explore feed's PCSF leaderboard let one source's compositeScore run away to ~10000
(`source:Flourishing` on the live `/api/explore/feed`) while every other source sat at the
0.5 cold prior. Two unbounded paths in `apps/lantern-garage/lib/model-leaderboard.js`, both
fixed:

1. **In-memory accumulator** — `recordOutcomeWithDecay()` set
   `score = successes * decay - cost`. With the default `decay = 1.0` (what
   `recordModelOutcome` passes), the score was simply the raw count of successful
   outcomes, so every `click`/`dwell`/`like` pushed it up without limit. The per-key
   `outcomes` array grew unboundedly too (one entry per interaction).
2. **Cold/restart fallback** — `rankCandidatesByDomain()` used the agent-performance
   **`compositeScore`** as the fallback prior for a source with no in-memory entry yet.
   That metric is `(successRate * 10) / (max(latency/1000, 0.1) * (avgCost + 0.01))`, so a
   fast, free, always-successful source scores `(1.0 * 10) / (0.1 * 0.01) = 10000` — on a
   totally different scale from the in-memory win rate and the 0.5 cold prior. Sorting them
   in the same comparison let one persisted row blow the feed out (this is the *exact*
   round number seen live). Fixed to use the row's bounded `successRate` (∈ [0,1]) instead,
   clamped defensively.

The #1315 rank-based diversity rerank was robust to the blowup, but the score itself still
polluted any score-based logic.

- **Bounded score** — compositeScore is now a Laplace-smoothed, decay-weighted **win rate
  in [0,1]** (`(wSuccess + 0.5)/(wTotal + 1)`), derived from O(1) running aggregates.
  Repeated wins converge to 1.0 instead of climbing; an engaged source still floats above
  the 0.5 cold prior and a dismissed source still sinks below it. Cost-awareness is
  preserved as a bounded *per-call mean* penalty (was an unbounded running sum), so cheaper
  candidates still rank above equally-reliable expensive ones.
- **Bounded memory** — the raw `outcomes` array is now a debug-only tail capped at 50;
  the score no longer depends on it, so it never grows with traffic.
- This also makes model routing (the other consumer) score correctly on *reliability*:
  the old accumulator ignored failures, so a flaky provider's score kept climbing on every
  success; the win rate now reflects the success/total ratio.
- Test: `apps/lantern-garage/test/model-leaderboard.test.js` pins the 10000-event runaway
  to ≤1, the bounded outcomes tail, win-rate-vs-cold-prior ordering, cost tie-breaking,
  recency weighting, and the explore `recordModelOutcome → rankCandidates` ordering.

Loop stage: **Converge** (the leaderboard must learn from interactions without a single
source corrupting the ranking signal).
