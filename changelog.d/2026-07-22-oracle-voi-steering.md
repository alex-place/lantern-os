### Added

- oracle(convergence loop): **VoI steering** — the Converge stage's directed-exploration leg, the
  precise hole the bandit analysis named. The active loop (ACT-TO-KNOW) manufactures corpus-absent
  facts but ran every candidate blindly; `experiments/oracle_voi_select.py` (unit-tested,
  `tests/test_oracle_voi_select.py` 7 passed) adds budgeted greedy **value-of-information**
  selection — run the highest-VoI experiments first, within a cost budget, never on pins. Its run
  ranks corpus-absent facts (VoI 1.0, only knowable by acting) above obvious facts inference already
  knows (`2+2==4`, VoI ~0.01) and excludes the pin (VoI 0), capturing 3.00/5.06 available VoI under
  a budget of 3. This is the **bandit's steering** on top of the anti-collapse **no-regret floor**
  (persistent excitation = never get stuck): the loop now explores *with direction*. Mechanism is
  established — value of information (Howard 1966), optimal experimental design (Lindley 1956),
  submodular greedy (1−1/e) (Krause–Guestrin) — **no novelty claimed**. Honest scope: the VoI is a
  heuristic prior-entropy proxy, not a computed Bayesian posterior-entropy reduction, and
  submodularity is assumed not verified — so this builds the steering *structure*, not an optimality
  claim; a real Bayesian VoI estimate is the tracked next rung. Certificate §10.2 and Oracle design
  §5 updated from GAP to SEED-BUILT for VoI selection.
