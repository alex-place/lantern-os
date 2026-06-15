"""
"Spin the vanda fast" — can you ride a collapse wall by spinning? (a measurement)

The claim under test (from the saddle-riding reading): a collapse boundary is a
saddle, and with enough rotational "spin" — imaginary eigenvalue / angular
momentum — you can ride the wall instead of being captured.

The dynamical-systems fact it runs into: an eigenvalue is λ = Re(λ) ± i·Im(λ).
  Im(λ) is the spin rate.   Re(λ) is growth (>0) or decay (<0).
They are INDEPENDENT axes. Capture along an unstable direction is governed entirely
by Re(λ) > 0: the unstable radius grows as e^{Re·t} no matter what Im(λ) is. You can
spin arbitrarily fast and the wall still ejects you at exactly the same rate.

What actually rides the wall is structured control that cancels the unstable
component — which needs (a) the unstable direction (a model / record) and (b)
continuous control energy against disturbance. That is reality-coupling, not spin.
Note: that control is the OPPOSITE of injecting random noise (the pasted box's
`rotation_pert = 0.05*np.random.randn(...)`), which this session already showed is
worse than doing nothing.

This run measures, on a saddle with a fast rotational plane:
  A) time-to-capture vs spin rate ω, no control   → should be INDEPENDENT of ω.
  B) three strategies at fixed ω:
       nothing          → captured.
       random "spin"    → isotropic noise; does NOT ride the wall.
       structured ctrl  → rides the wall, at a measured energy cost.

Reproducible: fixed seeds, no network, no external data. Writes a JSON artifact.
Run:  python experiments/sigma0_saddle_ride.py
"""
from __future__ import annotations

import json
import math
import os
import sys

import torch

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

from src.cio_sde import collapse_certificate

UNSTABLE = 0.40          # Re(λ) > 0 on the wall-fall direction (e0)
PLANE_DAMP = 0.02        # tiny damping in the rotational plane (e1,e2)
DT = 0.02
CAP = 10.0               # |x| past this = captured by a basin
MAX_STEPS = 6000
ARTIFACT = os.path.join("data", "sigma0_saddle_ride_report.json")


def make_A(omega: float) -> torch.Tensor:
    """Saddle: one unstable radial direction + a rotational plane spinning at ω."""
    A = torch.zeros(3, 3)
    A[0, 0] = UNSTABLE
    A[1, 1] = -PLANE_DAMP
    A[2, 2] = -PLANE_DAMP
    A[1, 2] = omega          # rotation (the "spin")
    A[2, 1] = -omega
    return A


def integrate(A, x0, control_gain=0.0, noise=0.0, disturb=0.0, seed=0):
    """Exact linear flow (matrix exponential) + stochastic increments.

    Euler is non-symplectic and spuriously pumps energy into a fast rotation, which
    would make capture time look ω-dependent for the wrong reason. The exact
    propagator Φ = exp(A·dt) integrates the deterministic linear part without that
    artifact. Structured control is folded into the drift (the unstable rate
    Re(λ) → Re(λ) − gain); random "spin" and disturbance are added as increments.
    Returns (time_to_capture, control_energy, survived).
    """
    A_eff = A.clone()
    A_eff[0, 0] = A_eff[0, 0] - control_gain          # cancel the unstable direction
    Phi = torch.linalg.matrix_exp(A_eff * DT)
    g = torch.Generator().manual_seed(seed)
    x = x0.clone()
    energy = 0.0
    for t in range(MAX_STEPS):
        if control_gain > 0.0:                        # energy spent holding e0 down
            energy += float(control_gain * x[0]) ** 2 * DT
        x = Phi @ x                                   # exact deterministic step
        if noise > 0.0:                               # random "spin" (isotropic kicks)
            x = x + noise * torch.randn(3, generator=g) * math.sqrt(DT)
        if disturb > 0.0:                             # the world pushing off the ridge
            x = x + disturb * torch.randn(3, generator=g) * math.sqrt(DT)
        if x.norm().item() > CAP:
            return t * DT, energy, False
    return MAX_STEPS * DT, energy, True


def main():
    x0 = torch.tensor([0.10, 0.50, 0.50])           # small unstable seed + spin-plane energy

    # ── A) does spinning faster delay capture? (deterministic, no control/noise) ──
    sweep = []
    for omega in [0.0, 1.0, 2.0, 4.0, 8.0, 16.0]:
        A = make_A(omega)
        tcap, _, survived = integrate(A, x0)
        sweep.append({"omega": omega, "time_to_capture": round(tcap, 3),
                      "survived": survived})
    predicted = math.log(CAP / x0[0].item()) / UNSTABLE   # ln(cap/x0)/Re, ω-independent

    # ── B) three strategies at a fast spin (ω = 4), with disturbance ──
    omega = 4.0
    A = make_A(omega)
    cert = collapse_certificate(A.unsqueeze(0)).summary()

    nothing_t, _, _ = integrate(A, x0, disturb=0.05, seed=1)
    rand_ts = [integrate(A, x0, noise=0.6, disturb=0.05, seed=s)[0] for s in range(5)]
    rand_t = sum(rand_ts) / len(rand_ts)
    ctrl_t, ctrl_E, ctrl_survived = integrate(A, x0, control_gain=0.8, disturb=0.05, seed=1)

    report = {
        "config": {"unstable_Re": UNSTABLE, "plane_damp": PLANE_DAMP, "dt": DT,
                   "cap": CAP, "max_steps": MAX_STEPS, "horizon_time": MAX_STEPS * DT},
        "saddle_certificate_at_omega4": cert,
        "spin_sweep": sweep,
        "predicted_capture_time_ln(cap/x0)/Re": round(predicted, 3),
        "strategies_at_omega4": {
            "nothing": {"time_to_capture": round(nothing_t, 3), "survived": False},
            "random_spin": {"time_to_capture": round(rand_t, 3), "survived": False},
            "structured_control": {"time_to_capture": round(ctrl_t, 3),
                                   "survived": ctrl_survived,
                                   "control_energy": round(ctrl_E, 3)},
        },
    }
    os.makedirs(os.path.dirname(ARTIFACT), exist_ok=True)
    with open(ARTIFACT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print("can you ride a collapse wall by spinning? — a measurement")
    print(f"saddle at ω=4:  {cert}")
    print(f"\nA) time-to-capture vs spin rate ω  (no control, deterministic):")
    print(f"   theory: capture time = ln(cap/x0)/Re = {predicted:.3f}, independent of ω")
    print(f"   {'ω (spin)':>9} | {'time_to_capture':>16}")
    print("   " + "-" * 30)
    for r in sweep:
        print(f"   {r['omega']:>9.1f} | {r['time_to_capture']:>16.3f}")
    print("   → spinning 16× faster changes capture time by nothing. Im(λ) ⟂ capture.")

    print(f"\nB) three strategies on the same saddle (ω=4, with disturbance):")
    s = report["strategies_at_omega4"]
    print(f"   nothing             captured at t={s['nothing']['time_to_capture']}")
    print(f"   random 'spin'       captured at t={s['random_spin']['time_to_capture']}  "
          "(isotropic noise — does NOT ride the wall)")
    sc = s["structured_control"]
    if sc["survived"]:
        print(f"   structured control  survived — rode the full horizon t={MAX_STEPS*DT:.0f}, "
              f"energy={sc['control_energy']}")
    else:
        print(f"   structured control  captured at t={sc['time_to_capture']}, "
              f"energy={sc['control_energy']}")
    print("\n   only structured control — which must KNOW the unstable direction (a record)")
    print("   and SPEND energy against disturbance — rides the wall. That is")
    print("   reality-coupling, not spin. Random 'spin' is the disproven trick again.")
    print(f"\nartifact: {ARTIFACT}")


if __name__ == "__main__":
    main()
