"""
Stability diagnostics — CIO invariant 4 (detect divergence regimes).

Three orthogonal checks on a rollout Trace:
  - divergence:   ‖x‖ blows up or goes non-finite
  - convergence:  ‖ẋ‖ < ε   (the loop's mathematical stop condition — this is
                  what the Rust CIO::run stub's `break` should actually test)
  - boundedness:  tr(Σ) stays finite and settles  (Riccati did its job)

Plus a Lyapunov proxy V = ‖x−x*‖² + tr(Σ): a stable run has V trending down.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

from .engine import Trace\nfrom .stability import verify_common_quadratic, finite_horizon_excitation_gramian


@dataclass
class StabilityReport:
    diverged: bool
    converged: bool
    sigma_bounded: bool
    lyapunov_decreasing: bool
    final_x_norm: float
    final_sigma_tr: float
    final_xdot_norm: float
    max_x_norm: float
    swaps_total: int
    swaps_accepted: int

    @property
    def stable(self) -> bool:
        return (not self.diverged) and self.sigma_bounded

    def summary(self) -> str:
        verdict = "DIVERGED" if self.diverged else (
            "CONVERGED" if self.converged else "STABLE" if self.stable else "UNSTABLE")
        return (
            f"[{verdict}] "
            f"‖x‖={self.final_x_norm:.3f} (max {self.max_x_norm:.3f})  "
            f"tr Σ={self.final_sigma_tr:.3f}  "
            f"‖ẋ‖={self.final_xdot_norm:.4f}  "
            f"Σ bounded={self.sigma_bounded}  "
            f"Lyapunov↓={self.lyapunov_decreasing}  "
            f"swaps={self.swaps_accepted}/{self.swaps_total}"
        )


def analyze_trajectory(trace: Trace,
                       converge_eps: float = 1e-2,
                       divergence_threshold: float = 1e3,
                       sigma_threshold: float = 1e2) -> StabilityReport:
    x_norms: List[float] = trace.x_norms()
    sigma_trs: List[float] = trace.sigma_traces()
    xdots = [s["xdot_norm"] for s in trace.steps]
    costs = [s["cost"] for s in trace.steps]

    max_x = max(x_norms) if x_norms else 0.0
    final_x = x_norms[-1] if x_norms else 0.0
    final_tr = sigma_trs[-1] if sigma_trs else 0.0
    final_xdot = xdots[-1] if xdots else float("inf")

    diverged = (not _finite(final_x)) or max_x > divergence_threshold \
        or (not _finite(final_tr)) or final_tr > sigma_threshold
    converged = (not diverged) and final_xdot < converge_eps
    sigma_bounded = _finite(final_tr) and final_tr <= sigma_threshold

    # Lyapunov proxy V = cost + tr Σ; check last-quarter trend
    lyap = [c + t for c, t in zip(costs, sigma_trs)]
    lyap_dec = _trending_down(lyap)

    accepted = sum(1 for s in trace.swaps if s.accepted)
    return StabilityReport(
        diverged=diverged,
        converged=converged,
        sigma_bounded=sigma_bounded,
        lyapunov_decreasing=lyap_dec,
        final_x_norm=final_x,
        final_sigma_tr=final_tr,
        final_xdot_norm=final_xdot,
        max_x_norm=max_x,
        swaps_total=len(trace.swaps),
        swaps_accepted=accepted,
    )


def _finite(v: float) -> bool:
    return v == v and abs(v) != float("inf")


def _trending_down(series: List[float]) -> bool:
    if len(series) < 4:
        return True
    n = len(series)
    first = sum(series[: n // 2]) / (n // 2)
    last = sum(series[n // 2:]) / (n - n // 2)
    return last <= first



def analyze_switched_modes(modes, metric, rho, noise_maps=None):
    """Verify a supplied switched-mode certificate and optional retained-excitation Gramian.

    This is deliberately separate from analyze_trajectory: finite rollout
    diagnostics cannot certify all future switching modes. A successful
    Lyapunov result applies only to the supplied matrices.
    """
    certificate = verify_common_quadratic(modes, metric, rho)
    result = {"stability_certificate": certificate}
    if noise_maps is not None:
        gramian = finite_horizon_excitation_gramian(modes, noise_maps)
        eigs = __import__("torch").linalg.eigvalsh(gramian)
        result["excitation_gramian"] = gramian
        result["excitation_min_eigenvalue"] = float(eigs.min())
        result["excitation_positive_definite"] = bool(eigs.min() > 0)
    return result
