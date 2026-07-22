### Added

- skill(`/bandits`): a new invocable skill that chases the convergence loop's highest-value open
  uncertainties. It treats each unresolved question/PR/GAP/unverified-claim/planned-benchmark as a
  bandit *arm*, scores them by value-of-information per cost (the `oracle_voi_select` discipline,
  PR #2821), pulls the top **cheap and reversible** one by taking a real resolving action, records
  what reality answered as a grounded fact, and reports what's next by value. It is the operational
  form of the loop's directed-exploration leg — the *steering* that sits on the anti-collapse
  *no-regret* floor (certificate §10 / Oracle design §7). Honesty guards are built into the skill:
  never bluff a pin (a structurally-unresolvable unknown is named, not guessed), claim only what the
  action resolved, stage pulls by irreversibility (money/irreversible surfaces recommended + gated),
  no "solved" (the bandit is not solvable for an open-ended loop — the promise is a valuable unknown
  *closed*, and the next named), and enumerate arms from the real system, never imagined. Mechanism
  is established (Howard 1966 / Lindley 1956 / Krause–Guestrin); no novelty claimed.
