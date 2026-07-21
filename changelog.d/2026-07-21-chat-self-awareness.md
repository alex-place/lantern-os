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
  remains open in #2803). **User-facing self-check** (#2805) — the council verdict was
  operator-only (#2332), so users saw confident answers the system itself distrusted;
  non-operators now get a plain-language chip on non-healthy verdicts only (unverified /
  failed a live check / no verifiable answer), grounded stays quiet, operator view unchanged.
