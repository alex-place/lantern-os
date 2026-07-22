### Changed

- chat(self-awareness): four fixes from the 2026-07-21 self-awareness assessment, all
  reproduced live before fixing. **Identity floor** (#2802) — the router prompt's own
  web-search rule sent the model to the web about its *own* identity, where it hedged stale
  sources against its spec and self-contradicted ("not designed to run solely on the user's
  machine… It is a local-first system designed to run on the user's own machine"); the
  identity block now carries authoritative product self-facts with an explicit precedence
  rule over retrieval and injected context. **Capability self-knowledge** (#2804) — natural-
  language autowork requests dead-ended in clarification loops because the model didn't know
  `!work` / `!review` / `!prs` exist; the prompt now enumerates the deterministic affordances
  and routes NL requests to them. **Honest confidence** (#2803) — convergence-record and
  agi-benchmark confidence values are formula constants with exactly one Brier-calibrated
  term (`calibratedTrust`, #1011); every field now declares its basis (`prior` /
  `prior-formula` / `measured`) in the record, the done-event summary, and the finale
  tooltip, so the numbers stop performing calibration they don't have (full calibration
  remains open in #2803). **User-facing self-check** (#2805) — implemented
  independently and better in PR #2807 (adds the "show what failed" disclosure on refuted
  verdicts); this PR's duplicate implementation was reverted in favor of it — the second
  same-day double-build, tracked as a lane-claim-convention gap.
