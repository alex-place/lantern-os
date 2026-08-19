"""World H: two explanations fit the current data equally. The kill test for retraction.

The hidden-variable world's retraction gate works because "no observable explains the residual"
is a clean signal when exactly one candidate is the true cause. World H attacks that: the
residual has a real missing variable z, and TWO offered observables both explain it --
  z_true   the real cause, z in {-1,+1}
  z_proxy  a confounder: a noisy copy of z (agrees with it a fraction `proxy_fidelity` of the
           time), so on the current window it explains almost as much residual variance
plus two pure-noise decoys. On data collected so far, truth and proxy are near-indistinguishable.
Both clear the 0.94 retraction bar, so retraction is BLIND here by construction -- that is the
point. Whether the controller can tell them apart is what we measure.

The only thing that separates them is what happens NEXT: the proxy's agreement with z is
imperfect, so if you collect more data after committing, the proxy's explained variance decays
toward proxy_fidelity^2 while the truth's stays at ~1. A controller that commits on the first
window and never re-checks cannot see this. A controller that holds the expansion as a
hypothesis and keeps scoring it can.

The proxy is also CHEAPER than the truth (proxy_cost_ratio < 1) so a utility = explained/cost
selector is actively pushed toward the wrong answer. Adversarial by design.
"""

from __future__ import annotations

import numpy as np


class TwoExplanationsWorld:
    def __init__(self, seed: int, *, switch_at=100, n_steps=400, noise=0.3,
                 proxy_fidelity=0.85, proxy_cost_ratio=0.6):
        self.rng = np.random.default_rng(seed)
        self.seed = seed
        self.switch_at = switch_at
        self.n_steps = n_steps
        self.noise = noise
        self.proxy_fidelity = proxy_fidelity
        self.a = float(self.rng.uniform(1.0, 3.0))
        self.b = float(self.rng.uniform(-2.0, 2.0))
        self.c = float(self.rng.uniform(1.5, 3.0)) * (1 if self.rng.random() < 0.5 else -1)
        self.t = 0
        # Which slots are truth / proxy / noise is random per seed.
        order = self.rng.permutation(4)
        self.true_idx, self.proxy_idx = int(order[0]), int(order[1])
        base = self.rng.uniform(1.5, 3.0, 4)
        base[self.proxy_idx] = base[self.true_idx] * proxy_cost_ratio    # the decoy is cheaper
        self.costs = {f"z{i+1}": float(c) for i, c in enumerate(base)}
        self._history = []    # (x, z, proxy, y)

    def observe(self):
        if self.t >= self.n_steps:
            return None
        x = float(self.rng.uniform(-5, 5))
        on = self.t >= self.switch_at
        z = float(self.rng.choice([-1.0, 1.0])) if on else 0.0
        # proxy agrees with z with prob fidelity, else flips. BEFORE the switch z is 0 and
        # contributes nothing, so the proxy must carry NO information then either -- it is 0
        # too. The first version made the pre-switch proxy random +-1 noise, which meant that
        # over any window straddling the switch the proxy was uncorrelated with the residual for
        # the early part and the "perfect copy" at fidelity 1.0 only explained ~0.69 of the
        # residual vs the truth's 0.98. That leaked which slot was the truth through the
        # pre-switch history, and made world H pass for the wrong reason. Caught by asking why a
        # perfect copy lost 95% of the time -- it cannot, so the harness was wrong.
        if on:
            proxy = z if self.rng.random() < self.proxy_fidelity else -z
        else:
            proxy = 0.0
        y = self.a * x + self.b + (self.c * z if on else 0.0) + float(self.rng.normal(0, self.noise))
        self._history.append((x, z, proxy, y))
        self.t += 1
        return {"t": self.t - 1, "x": x, "y": y}

    def candidates(self):
        return dict(self.costs)

    def measure(self, name: str, window: int):
        idx = int(name[1:]) - 1
        recent = self._history[-window:]
        if idx == self.true_idx:
            vals = [z for (_x, z, _p, _y) in recent]
        elif idx == self.proxy_idx:
            vals = [p for (_x, _z, p, _y) in recent]
        else:
            vals = [float(self.rng.normal(0, 1.0)) for _ in recent]
        return {"name": name, "values": vals, "cost": self.costs[name]}

    def truth(self):
        return {"a": self.a, "b": self.b, "c": self.c, "true_z": f"z{self.true_idx+1}",
                "proxy_z": f"z{self.proxy_idx+1}", "proxy_fidelity": self.proxy_fidelity,
                "switch_at": self.switch_at, "noise": self.noise}
