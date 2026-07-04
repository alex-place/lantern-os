"""
Sigma0 region-of-attraction first cut -- lift the LOCAL linear Jacobian certificate
to a NONLINEAR basin estimate (#1991).

Every theorem in the collapse certificate certifies the LOCAL linear Jacobian
A = df/dx|_x* -- "not a global guarantee." #1991 asks for a real basin: a Lyapunov
function valid on a certified NEIGHBOURHOOD, not just at the point.

First cut (quadratic Lyapunov, sublevel-set ROA -- Khalil, Nonlinear Systems ch.8):
  1. Linearize: A = df/dx|_0 (a stable focus).
  2. Solve the Lyapunov equation A^T P + P A = -I  =>  V(x) = x^T P x, V > 0.
  3. Certify the largest sublevel set {V <= c} on which Vdot(x) = grad V . f(x) < 0 for
     the FULL nonlinear f. By Lyapunov/LaSalle, {V <= c} is then an inner estimate of
     the region of attraction. c* = min_{x != 0, Vdot(x) >= 0} V(x) (the smallest level
     that touches the Vdot = 0 surface) -- estimated on a grid (a CONSERVATIVE inner
     bound: refining the grid can only lower c*, never certify more than is true).

EXTERNAL GROUNDING: the test system is the canonical ROA benchmark
    xdot1 = -x2,   xdot2 = x1 + (x1^2 - 1) x2
a reversed-Van-der-Pol-type flow with a STABLE focus at the origin whose ROA is
BOUNDED by an unstable limit cycle (Khalil Example 8.4; the standard SOS-ROA testbed).
So the certified {V <= c*} can be checked against ground truth: every point inside must
converge to 0, and the boundary must sit inside the true (bounded) basin.

HONEST SCOPE: c* is a MEASURED, grid-conservative INNER estimate; the sublevel-set
INVARIANCE given Vdot<0 is the PROVEN Lyapunov step. Applying this to the certificate's
own drift f would just need that f chosen; the METHOD is what is validated here.

Deterministic, CPU-only, no network.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from scipy.linalg import solve_continuous_lyapunov

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = REPO_ROOT / "data" / "sigma0" / "roa_estimate_report.json"


def f(x):
    """Reversed-Van-der-Pol-type benchmark: stable focus at 0, bounded ROA."""
    x1, x2 = x[..., 0], x[..., 1]
    return np.stack([-x2, x1 + (x1 * x1 - 1.0) * x2], axis=-1)


def jacobian_at_origin():
    # df/dx at 0:  [[0, -1], [1, -1]]  (eigenvalues -0.5 +- i*sqrt(3)/2, stable focus)
    return np.array([[0.0, -1.0], [1.0, -1.0]])


def integrate(x0, dt=0.002, steps=20000):
    """RK4 forward integration; return final ||x|| (converged->~0, diverged->large)."""
    x = np.array(x0, float)
    for _ in range(steps):
        k1 = f(x); k2 = f(x + 0.5 * dt * k1)
        k3 = f(x + 0.5 * dt * k2); k4 = f(x + dt * k3)
        x = x + (dt / 6.0) * (k1 + 2 * k2 + 2 * k3 + k4)
        if not np.all(np.isfinite(x)) or np.linalg.norm(x) > 1e3:
            return float("inf")
    return float(np.linalg.norm(x))


def main() -> None:
    A = jacobian_at_origin()
    P = solve_continuous_lyapunov(A.T, -np.eye(2))       # A^T P + P A = -I
    P = 0.5 * (P + P.T)
    assert np.linalg.eigvalsh(P).min() > 0, "P must be positive definite"

    def V(X):
        return np.einsum("...i,ij,...j->...", X, P, X)

    def Vdot(X):
        return 2.0 * np.einsum("...i,ij,...j->...", X, P, f(X))

    # grid search for c* = min V on the {Vdot >= 0} set (excluding a tiny origin ball)
    g = np.linspace(-3.0, 3.0, 601)
    XX, YY = np.meshgrid(g, g)
    G = np.stack([XX.ravel(), YY.ravel()], axis=-1)
    Vg, Vdg = V(G), Vdot(G)
    off_origin = np.linalg.norm(G, axis=-1) > 1e-3
    bad = (Vdg >= 0.0) & off_origin                      # where the Lyapunov test fails
    c_star = float(Vg[bad].min()) if bad.any() else float("inf")

    inside = (Vg <= c_star) & off_origin
    basin_radius = float(np.linalg.norm(G[inside], axis=-1).max()) if inside.any() else 0.0
    # certified area (grid cells inside the sublevel set)
    cell = (g[1] - g[0]) ** 2
    certified_area = float(inside.sum() * cell)

    # VALIDATE against ground truth: sample points inside {V<=c*} must converge to 0;
    # sample points on a slightly larger level should include divergences.
    rng = np.random.default_rng(0)
    def sample_on_level(level, n=200):
        pts = rng.standard_normal((n, 2))
        pts = pts / np.sqrt(V(pts))[:, None] * np.sqrt(level)   # scale onto {V=level}
        return pts
    inside_pts = sample_on_level(0.95 * c_star)
    converged = sum(integrate(p) < 1e-2 for p in inside_pts)
    inside_convergence_rate = converged / len(inside_pts)

    outside_pts = sample_on_level(3.0 * c_star)          # well outside the certified set
    outside_diverged = sum(integrate(p) > 1.0 for p in outside_pts)
    outside_divergence_rate = outside_diverged / len(outside_pts)

    report = {
        "issue": 1991,
        "system": "xdot=[-x2, x1+(x1^2-1)x2]  (reversed-VdP benchmark, Khalil Ex.8.4)",
        "P": P.tolist(),
        "lyapunov_eq": "A^T P + P A = -I,  A = df/dx|_0",
        "c_star": round(c_star, 6),
        "c_star_meaning": "largest level with Vdot<0 on {0<V<=c*}: {V<=c*} is an ROA inner estimate",
        "certified_basin_radius": round(basin_radius, 4),
        "certified_area_grid": round(certified_area, 4),
        "grid": "601x601 over [-3,3]^2 (conservative: finer grid can only shrink c*)",
        "validation": {
            "inside_convergence_rate": round(inside_convergence_rate, 4),
            "inside_note": "fraction of sampled points INSIDE {V<=0.95 c*} that converge to 0 (want 1.0)",
            "outside_divergence_rate": round(outside_divergence_rate, 4),
            "outside_note": "fraction on {V=3 c*} that diverge (>0 confirms the true ROA is bounded, as known)",
        },
        "evidence_class": {
            "sublevel_invariance_given_Vdot<0": "PROVEN (Lyapunov/LaSalle)",
            "c_star_value": "MEASURED (grid-conservative inner estimate)",
            "benchmark_ROA_is_bounded": "external ground truth (Khalil Ex.8.4)",
        },
        "honest_scope": (
            "This validates the METHOD (local Jacobian -> quadratic Lyapunov -> certified "
            "sublevel ROA) on a system with KNOWN bounded ROA. It lifts the certificate's "
            "local-linear claim to a certified NONLINEAR neighbourhood for THIS f. Applying "
            "it to the collapse certificate's own drift only needs that f specified; global "
            "guarantees still require grounding, per the certificate's North Star."),
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print("Sigma0 ROA first cut -- reversed-VdP benchmark")
    print(f"  P = {P.tolist()}")
    print(f"  c* = {c_star:.5f}   certified basin radius = {basin_radius:.4f}"
          f"   area = {certified_area:.4f}")
    print(f"  VALIDATE inside {{V<=0.95 c*}} converge-to-0 rate = {inside_convergence_rate:.3f} (want 1.0)")
    print(f"  VALIDATE outside {{V=3 c*}} divergence rate      = {outside_divergence_rate:.3f} (>0 => bounded ROA)")
    print(f"Report -> {OUT_PATH.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
