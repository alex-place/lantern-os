"""Placebo-controlled measurement of the Σ₀⁻¹ anti-collapse operator.

Replaces the retired "900/900 prevented" figure. That metric was (zero Σ₀ overwrites) AND (final
norm > initial norm). The first half cannot fail, because engine.forward_step skips the overwrite
whenever the operator fired, and diffusion alone delivers the second, so an operator that does
nothing scored the same. Every operator-attached arm below records zero overwrites by construction,
so that column is reported only to show it. The signals a placebo can actually fail:

  gate_frac   fraction of (trajectory, step) pairs with that trajectory's four-signal gate true
  max_run     longest run of consecutive gate-true steps of one trajectory (Theorem C3 says at most
              1 when acting)
  any_run     longest run of consecutive steps on which SOME trajectory's gate was true. The gate
              decides per trajectory, so two rows can be in it on consecutive steps; C3 does not
              speak to that, and this column is here so the aggregate is not hidden either
  moved       ‖x_T − x_0‖ mean over the batch

Every row whose gate is true on a step leaves a receipt for it (an excite from an attached operator,
otherwise the collapse overwrite), so the gate is read from the receipts, row by row.

Grid: rank-1 A, both normal (ν=0) and non-normal (ν>0), so every cell can enter the gate. The old
sweep's ν>0 cells were full-rank, so they never did.

Synthetic SDE only. Says nothing about a real model.

Run:  python experiments/sigma0_placebo_control.py [--trials 20] [--json]
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

import torch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from cio_sde import (  # noqa: E402
    AntiCollapseOperator, CIO_SDE, InterventionPolicy, LinearDynamics, SemanticCollapseOperator, rollout,
)

DIM, CTRL, BATCH, STEPS, DT = 4, 2, 8, 60, 0.05
INIT_SCALE = 1e-3
ALPHAS = [-0.5, -0.05, 0.0]
NON_NORMALITIES = [0.0, 1.0]
NOISES = [0.0, 0.001, 0.01]


class Placebo(AntiCollapseOperator):
    """Fires exactly when the real operator would, and does nothing."""

    def excite(self, x, sigma, A, p, noise):
        return torch.zeros_like(x), torch.zeros_like(sigma)


ARMS = {
    "no operator": None,
    "placebo": Placebo,
    "covariance leg only": lambda: AntiCollapseOperator(strength=0.0),
    "real operator": lambda: AntiCollapseOperator(strength=0.5),
}


def _model(alpha, nu, noise, arm):
    A = torch.zeros(DIM, DIM)
    A[0, 0] = alpha
    A[0, 1:] = nu                                   # rank ≤ 1 for any alpha, nu
    m = CIO_SDE(dim=DIM, ctrl_dim=CTRL, hidden=8)
    for p in m.pcsf.parameters():
        torch.nn.init.zeros_(p)
    m.graph.active = LinearDynamics(A, B=torch.zeros(DIM, CTRL), noise=noise)
    m.collapse_op = SemanticCollapseOperator()
    m.intervention_policy = InterventionPolicy(observe_only=False, max_interventions=10 ** 9)
    if arm is not None:
        m.anti_collapse_op = arm()
    return m


def _trial(alpha, nu, noise, arm, seed):
    torch.manual_seed(seed)
    x0 = INIT_SCALE * torch.randn(BATCH, DIM)
    s0 = torch.eye(DIM).expand(BATCH, DIM, DIM).clone()
    m = _model(alpha, nu, noise, arm)
    xf, _, tr = rollout(m, x0.clone(), s0, steps=STEPS, dt=DT, base_seed=seed)
    # gate[t][i]: trajectory i's gate was true at step t. With no operator attached its receipt is
    # the collapse overwrite; with one, the excite (the budget never runs out here).
    gate = [[False] * BATCH for _ in range(STEPS)]
    for r in tr.interventions:
        gate[r.step][r.sample] = True

    def longest(flags):
        run = best = 0
        for f in flags:
            run = run + 1 if f else 0
            best = max(best, run)
        return best

    return {
        "overwrites": len(tr.collapses),
        "gate_frac": sum(map(sum, gate)) / (STEPS * BATCH),
        "max_run": max(longest(row[i] for row in gate) for i in range(BATCH)),
        "any_run": longest(any(row) for row in gate),
        "moved": float((xf - x0).detach().norm(dim=-1).mean()),
    }


def measure(trials: int = 20) -> dict:
    out = {}
    for name, arm in ARMS.items():
        rows = []
        for ci, (alpha, nu, noise) in enumerate(
                (a, n, s) for a in ALPHAS for n in NON_NORMALITIES for s in NOISES):
            for i in range(trials):
                rows.append(_trial(alpha, nu, noise, arm, 20261105 + 1000 * ci + i))
        out[name] = {
            "trials": len(rows),
            "trials_with_overwrites": sum(r["overwrites"] > 0 for r in rows),
            "mean_gate_frac": sum(r["gate_frac"] for r in rows) / len(rows),
            "worst_max_run": max(r["max_run"] for r in rows),
            "worst_any_run": max(r["any_run"] for r in rows),
            "mean_moved": sum(r["moved"] for r in rows) / len(rows),
        }
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=20)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    result = measure(args.trials)
    if args.json:
        print(json.dumps(result, indent=2))
        return 0
    print(f"{'arm':<22}{'trials':>8}{'w/ overwrite':>14}{'gate true':>11}{'worst run':>11}"
          f"{'any-row run':>13}{'moved':>10}")
    for name, r in result.items():
        print(f"{name:<22}{r['trials']:>8}{r['trials_with_overwrites']:>14}"
              f"{r['mean_gate_frac']:>11.3f}{r['worst_max_run']:>11}{r['worst_any_run']:>13}"
              f"{r['mean_moved']:>10.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
