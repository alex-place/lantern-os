### Observe/Verify: traction & adoption is now instrumented and evidence-classed

Closes the report-card "Traction/adoption — D": revenue lived only in an LLM cost
ledger and activation/retention had *zero* instrumentation, so every traction claim
was unverifiable in-repo. There was no pipe to measure any of it.

- **New `apps/lantern-garage/lib/traction.js`** — an Observe log + Verify aggregator.
  `recordTractionEvent()` appends real, sourced events to `data/traction/events.jsonl`
  (append-only, via `file-queue`); `getTractionSummary()` aggregates them together with
  the wallet ledger (the single source of truth for money) and `data/creators/` into
  metrics where **every number carries an evidence class**: `MEASURED` (machine-checked
  from an in-repo artifact), `OPERATOR_REPORTED_UNVERIFIED` (operator-stated, held out of
  measured totals), or `REFERENCE_ONLY` (external benchmark). No fabricated numbers — the
  Arc Reactor boundary "No fake revenue" is enforced in code.
- **`GET /api/traction`** (in `routes/status.js`) serves the read-only summary.
- **Proof page** (`public/proof.html` + `proof.js`) gains a Traction panel and a
  "what this proves" line: cleared revenue, non-operator workflows, outreach sends, and a
  clearly-labeled operator-reported count.
- The `KEYSTONE_OPERATOR` seam classifies actors so the operator's own dogfooding never
  inflates external adoption — directly serving the Arc Reactor Movie-2 gate "one workflow
  used by someone other than the operator", which the summary now computes (honest baseline: **0**).
- Named power users (kriskin, mookman, courtney) and Patreon income are seeded as explicit
  `verified:false` operator-reported entries: recorded with `[claim, evidence, confidence,
  source]` for auditability, but **quarantined from every measured metric**. The current
  real state is surfaced, not hidden — $0 cleared, 5 recorded outreach sends (MEASURED),
  0 verified non-operator workflows — with a `gaps` array that says so out loud.
- Tests: `apps/lantern-garage/test/traction.test.js` pins the honesty guarantees
  (operator-reported revenue never counts as cleared; the non-operator gate counts only
  verified external events). Run: `node --test apps/lantern-garage/test/traction.test.js`.
