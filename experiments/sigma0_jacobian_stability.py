"""
Σ₀ trilogy hardening (3/3, #2029) — Jacobian spectral-radius stability diagnostic (CPU half).

The nested-adaptive Reason loop (ADR-0012) iterates a reasoning state through a fixed-point-like
update. Whether that iteration CONVERGES or DIVERGES is governed by the spectral radius ρ(J) of
the update's Jacobian: ρ<1 ⇒ contraction (converges), ρ≥1 ⇒ divergence. #2029 wants ρ(J) as a
measured stability signal, not a guess.

The estimator is model-agnostic and CPU-verifiable: power iteration needs only a matvec closure
`v ↦ Jv`. On GPU that closure is a torch autograd Jacobian-vector product (JVP) of the update map
at the current reasoning state; here it's any linear operator. So this module is the numpy half —
`power_iteration_spectral_radius()` + `stability_verdict()` + a report schema — unit-tested on
synthetic operators with analytically-known ρ. The one GPU step (building the real JVP closure over
the model's update map) is left to the run; it calls straight into these functions with its matvec.

numpy-only, torch-free.
"""
from __future__ import annotations

import numpy as np


def matvec_from_matrix(M):
    """Wrap a dense matrix as a matvec closure (the interface a torch JVP also exposes)."""
    M = np.asarray(M, dtype=float)
    return lambda v: M @ np.asarray(v, dtype=float)


def power_iteration_spectral_radius(matvec, dim, iters=200, tol=1e-10, seed=0):
    """Estimate ρ (largest |eigenvalue|) of a linear operator given ONLY `matvec` (v ↦ Jv).

    Magnitude power iteration: v aligns with the dominant eigendirection while ‖Jv‖/‖v‖ → |λ_max|.
    Returns (rho, info) with info.history (per-iter estimate), iters_used, and converged.
    Caveat (documented for the run): a strictly-dominant complex-conjugate eigenpair makes the
    Rayleigh sign oscillate; the *magnitude* estimate used here is still valid for a scaled
    rotation, but true convergence detection may need more iters — info.converged flags that.
    """
    rng = np.random.RandomState(seed)
    v = rng.randn(dim)
    n = np.linalg.norm(v)
    if n == 0:
        return 0.0, {"history": [], "iters_used": 0, "converged": True}
    v = v / n
    rho, history, converged, used = 0.0, [], False, 0
    for k in range(iters):
        w = np.asarray(matvec(v), dtype=float)
        nw = float(np.linalg.norm(w))
        used = k + 1
        history.append(nw)                      # ‖Jv‖ with ‖v‖=1 ⇒ current |λ| estimate
        if nw == 0.0:                            # nilpotent / null direction
            rho, converged = 0.0, True
            break
        if abs(nw - rho) < tol:
            rho, converged = nw, True
            break
        rho = nw
        v = w / nw
    return float(rho), {"history": history, "iters_used": used, "converged": converged}


def stability_verdict(rho, margin=0.0):
    """Map ρ to a convergence regime. margin>0 demands a safety band below 1 to call it stable."""
    rho = float(rho)
    if abs(rho - 1.0) < 1e-9:
        regime = "critical"
    elif rho < 1.0:
        regime = "contraction"
    else:
        regime = "divergent"
    return {
        "rho": round(rho, 6),
        "stable": rho < 1.0 - margin,
        "margin_to_instability": round(1.0 - rho, 6),
        "regime": regime,
    }


def stability_report(matvec, dim, margin=0.0, **kw):
    """One-call diagnostic: estimate ρ and attach the verdict + convergence diagnostics.
    This is the schema #2029 asks a run to emit per reasoning step."""
    rho, info = power_iteration_spectral_radius(matvec, dim, **kw)
    v = stability_verdict(rho, margin=margin)
    v.update({"dim": int(dim), "iters_used": info["iters_used"], "converged": info["converged"]})
    return v


if __name__ == "__main__":
    import json
    # demo on a synthetic contraction vs a divergent operator
    contract = matvec_from_matrix(np.diag([0.5, -0.9, 0.3]))    # ρ = 0.9 → stable
    diverge = matvec_from_matrix(np.diag([1.2, 0.4]))           # ρ = 1.2 → divergent
    print(json.dumps({
        "contraction": stability_report(contract, 3, margin=0.05),
        "divergent": stability_report(diverge, 2, margin=0.05),
    }, indent=2))
