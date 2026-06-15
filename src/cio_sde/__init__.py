"""
CIO Neural SDE — Convergence IO as a controlled stochastic differential system (#392)

Realizes the Convergence 1.0 compact core as a runnable PyTorch dynamical system:

    dx = f(x, u, G) dt + g(x) dW          (execution — drift + diffusion)
    dΣ = AΣ + ΣAᵀ + Q − ΣCᵀR⁻¹CΣ          (uncertainty — Kalman-Bucy Riccati)
    dλ = −∂H/∂x                            (co-state — Pontryagin adjoint)
    u* = argmin H(x, u, λ, Σ)              (control — PCSF policy)

Mapping to CIO theory:
    x      runtime + memory state
    Σ      dilation / uncertainty field  (D(v) derived from tr Σ)
    u      PCSF control action (policy network)
    G      execution graph (swappable dynamics modules)
    f, g   deterministic execution / exploration noise
    σ:v→v  hot-swap = behaviour-preserving module reparameterization

The four CIO invariants are enforced in code:
    1. constraints dominate optimization   (NAP clamp in PCSFController)
    2. all execution is traceable          (Trace, replayable by seed)
    3. graph mutations preserve validity   (hot-swap equivalence guard)
    4. divergence regimes are detected     (StabilityReport)
"""

from .engine import (
    Dynamics,
    LinearDynamics,
    PCSFController,
    CovarianceField,
    GraphController,
    CIO_SDE,
    Trace,
    rollout,
)
from .loss import gaussian_kl, free_energy
from .diagnostics import StabilityReport, analyze_trajectory
from .collapse import (
    SemanticCollapseOperator,
    CollapseResult,
    CollapseOutcome,
    CollapseCertificate,
    collapse_certificate,
    lyapunov_value,
    AntiCollapseOperator,
    ReconstructionOperator,
)
from .surprise import SurpriseMonitor, kalman_predict

__all__ = [
    "Dynamics",
    "LinearDynamics",
    "PCSFController",
    "CovarianceField",
    "GraphController",
    "CIO_SDE",
    "Trace",
    "rollout",
    "gaussian_kl",
    "free_energy",
    "StabilityReport",
    "analyze_trajectory",
    "SemanticCollapseOperator",
    "CollapseResult",
    "CollapseOutcome",
    "CollapseCertificate",
    "collapse_certificate",
    "lyapunov_value",
    "AntiCollapseOperator",
    "ReconstructionOperator",
    "SurpriseMonitor",
    "kalman_predict",
]
