### Added

- rsi: a pre-registered three-arm test of fresh verification in recursive self-improvement, on OpenEvolve, and its first run (`experiments/rsi_openevolve/`).
  - The domain is online bin packing on the OR-Library recipe, scored as bins saved against best fit on a 240-instance holdout that no run could generate. The arms run 5 seeds × 30 generations on gpt-4o-mini at equal model calls, built on OpenEvolve v0.4.0.
  - The arms are AlphaEvolve-style, MetaSkill-style (the improver rewrites itself without a check), and the latter plus a fresh-task gate on every promotion and improver change.
  - True improvement of the final champion, in pp of the L1 bound with 95% intervals over seeds: AlphaEvolve-style +0.65 [0.33, 0.98], MetaSkill-style +0.36 [−0.10, 0.82], fresh-gated +0.64 [0.15, 1.13]. No difference between arms is significant.
  - The gap between the score a champion was accepted on and its holdout score grew in the reused-validation arms (H1 holds). It grew about as much in the fresh-gated arm (H2 fails), whose believed score still includes the draws it was selected on.
  - The successor test (H3) was not run, because the API credit ran out. The kill condition does not fire.
  - Post hoc, not pre-registered: in 2 of 5 MetaSkill-style seeds the ungated improver degenerated until most of its proposals were catastrophic. No fresh-gated seed did.
  - Pre-registration, results and deviations: `PREREGISTRATION.md` and `RESULTS.md` in that directory. The loop cost $6.79; $7.29 in all, with pilots.
- docs(sigma0): §8.4 of the certificate points to this run, as a real-model measurement of the fresh gate.
