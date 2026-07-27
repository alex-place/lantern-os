- feat(spiral): self-training set builder + richer escalation-corpus rows. New
  `scripts/spiral_build_self_train.py` turns the spiral corpus sink into a
  replay-balanced, reward-weighted SFT set (v1: 237 exec-verified records —
  47 rung-lift @1.0, 190 replay @0.4 per #2729 replay-balance + RWOPD
  arXiv:2605.13501 verdict weighting). The harness corpus row now persists the
  three fields the build surfaced as gaps: the FAILED cheap attempt on
  escalated turns (`cheapAttempt` — the contrastive half of a repair pair),
  per-test verify detail (`verifyDetail` — enables partial-credit weights),
  and `model`. Control flow stays in the harness per Aletheia (arXiv:2601.14290,
  5% backtracking transfer): the student trains only on prompt→verified-solution.
