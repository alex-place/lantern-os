"""The deceptive world: y = a*x + b + c*z, where z is hidden at first.

For the first `switch_at` steps the world is y = a*x + b + noise -- the model class {x} is correct.
Then z switches ON and starts contributing c*z, where z in {-1,+1}, producing two systematic
residual bands. The machine is offered four candidate observables z1..z4; exactly one is the
true z, the others are decoys (pure noise, or correlated with x so they LOOK informative).

Deterministic given a seed. Measurement COSTS: each candidate has a price, and the budget is
finite, so the selector has to choose rather than measure everything.

A NULL WORLD is also provided (switch_at = None): z never switches on, but the parameters drift
slowly. This is the false-alarm control -- a controller that calls BOUNDARY here is broken.
"""

from __future__ import annotations

import numpy as np


class HiddenVariableWorld:
    def __init__(self, seed: int, *, switch_at=100, n_steps=300, noise=0.3,
                 drift=0.0, decoy_correlated=True):
        self.rng = np.random.default_rng(seed)
        self.seed = seed
        self.switch_at = switch_at          # None -> null world, z never appears
        self.n_steps = n_steps
        self.noise = noise
        self.drift = drift                  # per-step parameter drift (null-world distractor)
        # Random but fixed world parameters.
        self.a = float(self.rng.uniform(1.0, 3.0))
        self.b = float(self.rng.uniform(-2.0, 2.0))
        self.c = float(self.rng.uniform(1.5, 3.0)) * (1 if self.rng.random() < 0.5 else -1)
        self.t = 0
        # Candidate observables. Exactly one is the true z; which index is random per seed.
        self.true_idx = int(self.rng.integers(0, 4))
        self.costs = {f"z{i+1}": float(c) for i, c in enumerate(self.rng.uniform(1.0, 3.0, 4))}
        self.decoy_correlated = decoy_correlated
        self._history = []                  # (x, z, y) -- z is the TRUE latent, never exposed directly

    # ── the stream ────────────────────────────────────────────────────────────────────────
    def observe(self):
        """One observation (x, y). z is NOT returned -- it is hidden."""
        if self.t >= self.n_steps:
            return None
        x = float(self.rng.uniform(-5, 5))
        on = self.switch_at is not None and self.t >= self.switch_at
        z = float(self.rng.choice([-1.0, 1.0])) if on else 0.0
        a = self.a + self.drift * self.t
        y = a * x + self.b + (self.c * z if on else 0.0) + float(self.rng.normal(0, self.noise))
        self._history.append((x, z, y))
        self.t += 1
        return {"t": self.t - 1, "x": x, "y": y}

    # ── the measurements the machine can BUY ──────────────────────────────────────────────
    def candidates(self):
        return dict(self.costs)

    def measure(self, name: str, window: int):
        """Return the last `window` values of candidate observable `name`, at its cost."""
        idx = int(name[1:]) - 1
        recent = self._history[-window:]
        if idx == self.true_idx:
            vals = [z for (_x, z, _y) in recent]                      # the real thing
        elif self.decoy_correlated and idx == (self.true_idx + 1) % 4:
            # a decoy that is correlated with x -- looks informative, explains nothing new
            vals = [np.sign(x) + float(self.rng.normal(0, 0.3)) for (x, _z, _y) in recent]
        else:
            vals = [float(self.rng.normal(0, 1.0)) for _ in recent]    # pure noise
        return {"name": name, "values": vals, "cost": self.costs[name]}

    # ── ground truth, for SCORING ONLY -- the controller never reads this ────────────────
    def truth(self):
        return {"a": self.a, "b": self.b, "c": self.c, "true_z": f"z{self.true_idx+1}",
                "switch_at": self.switch_at, "noise": self.noise}
