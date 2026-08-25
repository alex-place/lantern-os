"""The evolvable experiment-selection policy of the epistemic controller.

This file is the WHOLE search space of the pilot: OpenEvolve mutates this file and nothing else.
It is deliberately an exact transcription of the shipped controller's current policy, so the
first evaluation IS the status quo and every later score is a delta against it.

Contract (the evaluator imports this module and injects it into the controller):
  RETRACT_BELOW      float in (0.5, 0.999) -- explained-variance bar: below it a BOUNDARY call is
                     retracted; at-or-above it probing stops early (the current code uses one
                     constant for both, and keeping them tied is itself a policy choice evolution
                     may revisit by splitting into RETRACT_BELOW / EARLY_ACCEPT).
  EARLY_ACCEPT       float -- probe round stops as soon as a candidate explains this much.
  HOLD_STEPS         int >= 0 -- how long an expansion is held as a hypothesis on fresh data.
  candidate_utility(explained, cost, spent, budget) -> float
                     score used to pick which explaining observable to BUY. Higher wins.
  probe_order(candidates) -> list
                     candidates is a list of (name, cost); return them in the order probes
                     should be paid for. With early accept, order is real money.

Rules: pure functions of their arguments, deterministic, stdlib `math` only. No I/O, no imports
beyond math, no randomness, no state. The evaluator rejects programs that break this.
"""

import math  # noqa: F401  (available to evolved code)

# EVOLVE-BLOCK-START
RETRACT_BELOW = 0.90  # Lowered to allow more candidates to be accepted
EARLY_ACCEPT = 0.90   # Lowered to increase chances of early acceptance
HOLD_STEPS = 40


def candidate_utility(explained, cost, spent, budget):
    """Current shipped policy: explained residual variance per unit cost."""
    return max(0.0, explained) / (cost + 1e-6)  # Avoid division by zero and stabilize cost in utility


def probe_order(candidates):
    """Current shipped policy: probe in the world's own order (no prior)."""
    return sorted(candidates, key=lambda x: (-x[1], x[0]))  # Sort candidates by cost ascending and name
# EVOLVE-BLOCK-END
