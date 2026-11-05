"""Finite-dimensional verification tools for switched anti-collapse analysis.

These routines verify supplied certificates and compute finite-horizon Gramians.
They do not discover a Lyapunov function, prove a nonlinear model stays in a
region, or infer that sampled modes cover every reachable runtime mode.
"""
from __future__ import annotations

from typing import Callable, Dict, Sequence

import torch
from torch import Tensor


def verify_common_quadratic(modes: Sequence[Tensor], metric: Tensor, rho: float, *, atol: float = 1e-10) -> Dict[str, object]:
    """Verify H positive definite and FᵀHF <= rho²H for every supplied mode.

    A successful result covers only the exact supplied matrices. The caller
    must establish that these modes cover every reachable closed-loop mode.
    """
    if not modes:
        raise ValueError("at least one transition mode is required")
    if not 0.0 <= rho < 1.0:
        raise ValueError("rho must satisfy 0 <= rho < 1")
    H = 0.5 * (metric + metric.transpose(-1, -2))
    if H.ndim != 2 or H.shape[0] != H.shape[1]:
        raise ValueError("metric must be a square matrix")
    h_eigs = torch.linalg.eigvalsh(H)
    if not bool(torch.isfinite(H).all()) or float(h_eigs.min()) <= atol:
        raise ValueError("metric must be finite and positive definite")
    residuals = []
    for index, F in enumerate(modes):
        if F.shape != H.shape or not bool(torch.isfinite(F).all()):
            raise ValueError(f"mode {index} must be finite and match metric dimensions")
        residual = rho * rho * H - F.transpose(-1, -2) @ H @ F
        residual = 0.5 * (residual + residual.transpose(-1, -2))
        residuals.append(float(torch.linalg.eigvalsh(residual).min()))
    margin = min(residuals)
    return {"valid": margin >= -atol, "rho": float(rho),
            "metric_min_eigenvalue": float(h_eigs.min()),
            "minimum_lyapunov_margin": margin, "mode_margins": residuals,
            "scope": "exact supplied matrices only"}


def finite_horizon_excitation_gramian(transitions: Sequence[Tensor], noise_maps: Sequence[Tensor]) -> Tensor:
    """Terminal Gramian for x[k+1]=F[k]x[k]+M[k]xi[k].

    Computes sum Phi(T,k+1) M[k] M[k]^T Phi(T,k+1)^T. This measures
    excitation retained at the horizon, not merely energy injected.
    """
    if not transitions or len(transitions) != len(noise_maps):
        raise ValueError("transitions and noise_maps must have equal nonzero length")
    d = transitions[0].shape[0]
    device, dtype = transitions[0].device, transitions[0].dtype
    gramian = torch.zeros((d, d), device=device, dtype=dtype)
    downstream = torch.eye(d, device=device, dtype=dtype)
    for F, M in zip(reversed(transitions), reversed(noise_maps)):
        if F.shape != (d, d) or M.ndim != 2 or M.shape[0] != d:
            raise ValueError("transitions must be (d,d), noise maps must be (d,k)")
        if F.device != device or M.device != device:
            raise ValueError("all matrices must share a device")
        gramian = gramian + downstream @ M @ M.transpose(-1, -2) @ downstream.transpose(-1, -2)
        downstream = downstream @ F
    return 0.5 * (gramian + gramian.transpose(-1, -2))


def covariance_energy_bound(initial_covariance: Tensor, metric: Tensor, rho: float, q: float, steps: int) -> float:
    """Evaluate the common-quadratic upper bound after a finite number of steps."""
    if not 0.0 <= rho < 1.0 or q < 0.0 or steps < 0:
        raise ValueError("require 0<=rho<1, q>=0, and steps>=0")
    H = 0.5 * (metric + metric.transpose(-1, -2))
    initial = float(torch.trace(H @ initial_covariance))
    return (rho ** (2 * steps)) * initial + q * (1.0 - rho ** (2 * steps)) / (1.0 - rho ** 2)


def augmented_transition_jacobian(transition: Callable[[Tensor], Tensor], augmented_state: Tensor) -> Tensor:
    """Differentiate a complete user-supplied augmented one-step map.

    Pack every continuous state feeding back into execution (for example x,
    vec(P), vec(S), and controller memory). Certify discrete graph modes
    separately, mode by mode.
    """
    if augmented_state.ndim != 1:
        raise ValueError("augmented_state must be a flat vector")
    jac = torch.func.jacrev(transition)(augmented_state)
    if jac.shape != (augmented_state.numel(), augmented_state.numel()):
        raise ValueError("transition must map augmented state to same dimension")
    if not bool(torch.isfinite(jac).all()):
        raise ValueError("augmented transition Jacobian must be finite")
    return jac