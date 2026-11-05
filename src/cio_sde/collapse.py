"""
Σ₀ — Semantic Collapse Operator.

    Σ₀ : (x, Σ, G, u) → ⊥ₛ  or  x*

A first-class CIO operator that prevents divergence-by-wandering. When the
system is *underdetermined* — no optimization signal, a rank-deficient drift
Jacobian, an isotropically-flat dilation field, and control that cannot
distinguish actions — Σ₀ projects the state onto its minimal invariant
attractor manifold instead of letting it diverge, oscillate, or crash.

Embedded in the dynamics as:

    dx/dt = f(x,u,G) + w(t) − Σ₀(x,Σ,G,u)

Trigger (all four must hold — control singularity over a structureless field):

    1. ∇ₓ L → 0                       no further optimization signal
    2. rank(J_f) < threshold          drift Jacobian loses directional structure
    3. Σ isotropically flat            uncertainty has no preferred direction
    4. ∀u : Δcost(u) ≈ 0              control cannot distinguish actions

Outcomes:
    x*   degenerate fixed point — projection onto J's null eigenmodes
         (the "42 state": a stable, structureless summary)
    ⊥ₛ   semantic null — objective underdetermined, no latent geometry at all
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import Enum
from typing import Dict, List, Optional, Sequence, Tuple

import torch

Tensor = torch.Tensor

# Median of χ₁ (= |N(0,1)|). The state-kick floor divides by it (Lemma S1).
_MEDIAN_CHI_1 = 0.6744897501960817


def _batch_members(A: Tensor) -> List[Tensor]:
    """The Jacobians a batched certificate has to cover.

    A batch certifies only if every member does. Averaging first certifies nothing: the mean
    of diag(1.5, 0.1) and diag(0.1, 1.5) contracts while both members diverge. An identical
    batch (LinearDynamics) reduces to one member, so it costs one evaluation.
    """
    if A.dim() != 3:
        return [A]
    if A.shape[0] == 1 or torch.allclose(A, A[0].expand_as(A)):
        return [A[0]]
    return list(A)


class CollapseOutcome(str, Enum):
    NONE      = "none"        # not triggered
    ATTRACTOR = "attractor"   # x* — collapsed onto invariant manifold
    NULL      = "null"        # ⊥ₛ — semantic null state


@dataclass
class CollapseResult:
    triggered: bool
    outcome: CollapseOutcome
    x_star: Tensor
    metrics: Dict[str, float]

    def summary(self) -> str:
        m = self.metrics
        return (
            f"Σ₀[{self.outcome.value}] "
            f"∇L={m['grad_norm']:.4f} rank={m['eff_rank']:.1f}/{m['dim']:.0f} "
            f"aniso={m['anisotropy']:.4f} ∂H/∂u={m['ctrl_sens']:.4f}"
        )


class SemanticCollapseOperator:
    """Σ₀ — detects the underdetermined regime and collapses the state."""

    def __init__(self,
                 grad_eps: float = 1e-2,
                 rank_frac: float = 0.5,
                 anisotropy_eps: float = 5e-2,
                 ctrl_eps: float = 1e-2,
                 eig_eps: float = 1e-2) -> None:
        self.grad_eps = grad_eps          # ∇ₓL below this ⇒ no optimization signal
        self.rank_frac = rank_frac        # eff_rank/dim below this ⇒ rank-deficient
        self.anisotropy_eps = anisotropy_eps  # Σ eigval spread below this ⇒ flat
        self.ctrl_eps = ctrl_eps          # ∂H/∂u below this ⇒ control singularity
        self.eig_eps = eig_eps            # |λ| below this ⇒ null eigenmode

    @torch.no_grad()
    def _effective_rank(self, A: Tensor) -> float:
        # mean Jacobian over the batch; effective numerical rank via singular values
        Abar = A.mean(0)
        s = torch.linalg.svdvals(Abar)
        if s.numel() == 0 or s.max() <= 0:
            return 0.0
        return float((s > self.eig_eps * s.max()).sum().item())

    @torch.no_grad()
    def _anisotropy_per_sample(self, sigma: Tensor) -> Tensor:
        # spread of Σ eigenvalues, normalized — low ⇒ isotropic flatness. Unbiased std, so
        # a(Σ)·μ·√(d−1) = ‖Σ−μI‖_F, the form the lift proof uses.
        sym = 0.5 * (sigma + sigma.transpose(-1, -2))
        ev = torch.linalg.eigvalsh(sym).clamp_min(1e-12)
        return ev.std(dim=-1) / ev.mean(dim=-1)

    @torch.no_grad()
    def _anisotropy(self, sigma: Tensor) -> float:
        return float(self._anisotropy_per_sample(sigma).mean().item())

    def _grad_norm(self, model, x: Tensor, u: Tensor) -> float:
        xr = x.detach().clone().requires_grad_(True)
        # .sum(), not .mean(): each sample's gradient must stay that sample's gradient. A mean
        # divides it by the batch size, which silently made ε_g depend on B.
        L = model.stage_cost(xr, u.detach()).sum()
        (g,) = torch.autograd.grad(L, xr)
        return float(g.norm(dim=-1).mean().item())

    @torch.no_grad()
    def _effective_rank_per_sample(self, A: Tensor) -> Tensor:
        """Numerical rank of each Jacobian independently (never rank(mean(A)))."""
        if A.dim() == 2:
            A = A.unsqueeze(0)
        s = torch.linalg.svdvals(A)
        smax = s.max(dim=-1, keepdim=True).values
        return (s > self.eig_eps * smax).sum(dim=-1).to(dtype=A.dtype)

    def _grad_norm_per_sample(self, model, x: Tensor, u: Tensor) -> Tensor:
        xr = x.detach().clone().requires_grad_(True)
        L = model.stage_cost(xr, u.detach()).sum()
        (g,) = torch.autograd.grad(L, xr)
        return g.norm(dim=-1)

    def _ctrl_sensitivity_per_sample(self, model, x: Tensor, u: Tensor) -> Tensor:
        xr = x.detach().clone().requires_grad_(True)
        (lam,) = torch.autograd.grad(model.stage_cost(xr, u.detach()).sum(), xr)
        ur = u.detach().clone().requires_grad_(True)
        H = model.stage_cost(x.detach(), ur)
        active = getattr(getattr(model, "graph", None), "active", None)
        if active is not None:
            H = H + (lam.detach() * active.drift(x.detach(), ur)).sum(-1)
        (g,) = torch.autograd.grad(H.sum(), ur)
        return g.norm(dim=-1)

    def _ctrl_sensitivity(self, model, x: Tensor, u: Tensor) -> float:
        """‖∂H/∂u‖ with H = L + λᵀf and λ = ∇ₓL, the instantaneous adjoint.

        The stage cost alone reads 0 at u=0 however much leverage the control has, which is
        not "control cannot distinguish actions". This sees only the model's own cost: a goal
        held outside it (a Question Machine terminal anchor) reaches the gate through x_target.
        """
        xr = x.detach().clone().requires_grad_(True)
        (lam,) = torch.autograd.grad(model.stage_cost(xr, u.detach()).sum(), xr)
        ur = u.detach().clone().requires_grad_(True)
        H = model.stage_cost(x.detach(), ur)
        active = getattr(getattr(model, "graph", None), "active", None)
        if active is not None:
            H = H + (lam.detach() * active.drift(x.detach(), ur)).sum(-1)
        (g,) = torch.autograd.grad(H.sum(), ur)
        return float(g.norm(dim=-1).mean().item())

    @torch.no_grad()
    def _collapse_state(self, x: Tensor, A: Tensor) -> tuple[Tensor, CollapseOutcome]:
        # Project onto null(A), the actual fixed points of the linearised flow, so f(x*)≈0 for
        # ANY A. The null space of A_s is a different set: a rotation block has A_s=0 and keeps
        # moving, so projecting there left ‖Ax*‖ large even for normal A. Uses the same relative
        # singular-value cutoff as _effective_rank, so cond_rank firing implies k ≥ d/2.
        Abar = A.mean(0) if A.dim() == 3 else A
        _, s, Vh = torch.linalg.svd(Abar)
        null_mask = s <= self.eig_eps * s.max()
        k = int(null_mask.sum().item())
        if k == 0:
            # no invariant directions at all → semantic null ⊥ₛ
            return torch.zeros_like(x), CollapseOutcome.NULL
        V = Vh.T[:, null_mask]                  # (d, k) basis of null(A)
        P = V @ V.T                             # projector onto the fixed points

        # Collapse is the orthogonal projection onto the invariant null manifold.
        # P = V Vᵀ is idempotent and symmetric, so it is non-expansive:
        # ‖P x‖ ≤ ‖x‖ for all x — the projection is already a contraction toward
        # the manifold and there is no boundary to enforce. (The former
        # "log-barrier" multiplicative shrink was misnamed and, for strengths
        # above 1/ln(100) ≈ 0.217, flipped sign and grew ‖x*‖ — the opposite of
        # collapse. See issue #661.)
        x_star = x @ P.T
        return x_star, CollapseOutcome.ATTRACTOR

    def evaluate(self, model, x: Tensor, u: Tensor, sigma: Tensor,
                 A: Tensor) -> CollapseResult:
        dim = float(x.shape[-1])
        grad_norm = self._grad_norm(model, x, u)
        eff_rank = self._effective_rank(A)
        anisotropy = self._anisotropy(sigma)
        ctrl_sens = self._ctrl_sensitivity(model, x, u)

        cond_grad = grad_norm < self.grad_eps
        cond_rank = eff_rank < self.rank_frac * dim
        cond_flat = anisotropy < self.anisotropy_eps
        cond_ctrl = ctrl_sens < self.ctrl_eps
        triggered = cond_grad and cond_rank and cond_flat and cond_ctrl

        metrics = {
            "grad_norm": grad_norm, "eff_rank": eff_rank, "dim": dim,
            "anisotropy": anisotropy, "ctrl_sens": ctrl_sens,
        }
        if not triggered:
            return CollapseResult(False, CollapseOutcome.NONE, x, metrics)

        x_star, outcome = self._collapse_state(x, A)
        return CollapseResult(True, outcome, x_star, metrics)


# ── Lyapunov collapse-guarantee theorem ──────────────────────────────────────

@dataclass
class CollapseCertificate:
    """
    A computable certificate for the collapse-guarantee theorem.

    Theorem.  Let A be the drift Jacobian at a point and A_s = ½(A+Aᵀ) its
    symmetric part. Split the state space into the near-null subspace
    N = span{ vᵢ : |λᵢ(A_s)| < ε } and its complement M (the "active" modes).
    Take the Lyapunov function V(x) = ½‖P_M x‖² on the active subspace.

    If α = max{ λᵢ(A_s) : vᵢ ∈ M } < 0 AND A commutes with P_M (automatic for normal A, and
    when N is empty), then V̇ ≤ 2αV, so ‖P_M x(t)‖ ≤ ‖P_M x(0)‖·e^{αt}.

    `guaranteed` means that hypothesis holds AND the null block does not grow or rotate, so
    the state actually settles. Without the commutation the energy bound fails outright (use
    dichotomy_certificate). Without the null-block check a mode growing at +0.009 sits inside
    the null band and the "collapse" diverges.
    """
    guaranteed: bool
    alpha: float            # small-gain INDEX max λ(A_s)+‖A−A_s‖₂. Telemetry, NOT a bound: V̇ picks
                            # up ‖A_k‖‖P_M x‖‖P_N x‖, which ‖A_k‖‖P_M x‖² does not dominate
    contraction_rate: float # |α| when guaranteed with active modes, else 0
    null_dim: int           # dimension of the invariant manifold
    active_dim: int
    # Authoritative full-spectrum test (§1.2): the EXACT spectral abscissa of the
    # full (possibly non-normal) Jacobian. max Re λ(A) < 0 is necessary for strict
    # contraction; it is tighter than the conservative small-gain `alpha` bound.
    spectral_abscissa: float = float("nan")  # max Re λ(A) on the full A (via eig)
    full_contracting: bool = False           # spectral_abscissa < −margin
    # #768 Tier-A provable region-wideners (see stability_gates()). Sufficient
    # contraction certificates that do not rest on the small-gain `alpha` index.
    numerical_range_abscissa: float = float("nan")  # ω(A)=λ_max(A_s); rightmost pt of W(A)
    gate_numerical_range: bool = False  # ω(A) < −margin → monotone Euclidean contraction
    gate_lyapunov: bool = False         # ∃P≻0 ⟺ max Re λ(A) < −margin (accepts non-normal)
    lyapunov_transient_bound: float = float("nan")  # √cond(P): bound on sup_t‖e^{tA}‖
    cross_term: float = 0.0             # ‖P_M A P_N‖₂: the theorem's hypothesis is cross_term≈0
    null_kind: str = "none"             # none | decaying | frozen | rotating | defective | growing

    def summary(self) -> str:
        verdict = "GUARANTEED" if self.guaranteed else "NOT guaranteed"
        return (
            f"collapse {verdict}: α={self.alpha:+.4f} (small-gain index) "
            f"maxReλ(A)={self.spectral_abscissa:+.4f} "
            f"({'contracting' if self.full_contracting else 'non-contracting'}) "
            f"rate={self.contraction_rate:.4f} cross={self.cross_term:.3g} "
            f"null_dim={self.null_dim} ({self.null_kind}) active_dim={self.active_dim}"
        )

    @property
    def proven_contracting(self) -> bool:
        """#768: certified contracting by EITHER provable gate — a strictly wider
        proven region than the conservative small-gain `guaranteed`/`alpha`."""
        return self.gate_numerical_range or self.gate_lyapunov


def _null_block_kind(A_N: Tensor, tol: float) -> str:
    """How the near-null block behaves on its own, given the split is A-invariant."""
    import numpy as np
    if A_N.numel() == 0:
        return "none"
    M = A_N.detach().cpu().numpy().astype(float)
    w = np.linalg.eigvals(M)
    if float(w.real.max()) > tol:
        return "growing"
    if float(w.real.max()) < -tol:
        return "decaying"
    return _boundary_kind(M, w, np.abs(w.real) <= tol, 0.0, tol)


@torch.no_grad()
def collapse_certificate(A: Tensor, eig_eps: float = 1e-2,
                         margin: float = 0.0) -> CollapseCertificate:
    """Evaluate the collapse-guarantee theorem for a Jacobian A (every batch member must pass).

    Model-collapse grounding (Dohmatob et al., "A Tale of Tails", arXiv:2402.07043,
    ICML 2024): synthetic data changes the scaling law and truncates gains; a
    contraction margin keeps spectral distance from the collapse boundary
    (α < -margin). The matrix-measure bound is classical contraction analysis
    (Lohmiller & Slotine 1998, Automatica 34(6):683-696).
    """
    members = _batch_members(A)
    if len(members) > 1:
        certs = [collapse_certificate(m, eig_eps, margin) for m in members]
        return min(certs, key=lambda c: (c.guaranteed, c.contraction_rate))
    Abar = members[0]
    A_s = 0.5 * (Abar + Abar.T)
    evals, evecs = torch.linalg.eigh(A_s)

    # Authoritative full-spectrum abscissa (§1.2): exact max Re λ(A) on the FULL,
    # possibly non-normal, Jacobian via `eigvals` (complex). This is the tight
    # necessary condition for strict contraction; the small-gain `alpha` below is
    # a conservative index that can over-reject genuinely-contracting non-normal systems.
    spectral_abscissa = float(torch.linalg.eigvals(Abar).real.max().item())
    full_contracting = spectral_abscissa < -margin

    # #768 Tier-A provable gates (widen the proven region vs the small-gain `alpha`).
    g = stability_gates(Abar, margin=margin)

    null_mask = evals.abs() < eig_eps
    active = evals[~null_mask]
    null_dim = int(null_mask.sum().item())
    active_dim = int(active.numel())
    alpha_sym = float(active.max().item()) if active_dim else float("-inf")
    alpha = alpha_sym + torch.linalg.norm(Abar - A_s, ord=2).item()

    # The theorem's hypothesis, measured: A commutes with P_M ⟺ P_M A P_N = 0 (A_s is block
    # diagonal in this split, so the off-diagonal blocks are the skew part's and vanish together).
    Vm, Vn = evecs[:, ~null_mask], evecs[:, null_mask]
    scale = max(1.0, torch.linalg.norm(Abar, ord=2).item())
    tol = max(1e-9, 20.0 * torch.finfo(Abar.dtype).eps) * scale
    cross = (torch.linalg.norm(Vm.T @ Abar @ Vn, ord=2).item()
             if active_dim and null_dim else 0.0)
    null_kind = _null_block_kind(Vn.T @ Abar @ Vn, tol)

    guaranteed = (
        (active_dim == 0 or alpha_sym < -margin)
        and cross <= tol
        and null_kind in ("none", "decaying", "frozen")
    )
    return CollapseCertificate(
        guaranteed=guaranteed,
        alpha=alpha,
        contraction_rate=(-alpha_sym if guaranteed and active_dim else 0.0),
        null_dim=null_dim,
        active_dim=active_dim,
        spectral_abscissa=spectral_abscissa,
        full_contracting=full_contracting,
        numerical_range_abscissa=g.numerical_range_abscissa,
        gate_numerical_range=g.gate_numerical_range,
        gate_lyapunov=g.gate_lyapunov,
        lyapunov_transient_bound=g.lyapunov_transient_bound,
        cross_term=cross,
        null_kind=null_kind,
    )


@dataclass
class StabilityGates:
    """#768 Tier-A provable region-wideners for (possibly non-normal) A."""
    numerical_range_abscissa: float   # ω(A)=λ_max(A_s) — rightmost point of W(A)
    spectral_abscissa: float          # max Re λ(A)
    gate_numerical_range: bool        # ω(A) < −margin  → MONOTONE Euclidean contraction
    gate_lyapunov: bool               # ∃P≻0 ⟺ max Re λ(A) < −margin (accepts non-normal)
    lyapunov_transient_bound: float   # √cond(P): bound on sup_t‖e^{tA}‖ (nan if not Hurwitz)
    monotone_transient_bound: float   # 1 when W(A) ⊂ closed LHP (ω ≤ 0), else nan
    # #768 gate #2 — ε-pseudospectral abscissa + Kreiss constant (transient-growth bounds).
    pseudospectral_abscissa: float    # provable upper bound: α_ε(A) ≤ ω(A)+ε (field-of-values)
    gate_pseudospectral: bool         # α_ε(A) < −margin → no ε-transient escapes the LHP
    kreiss_bound: float               # K(A) lower bound (continuous Kreiss const) ≤ sup_t‖e^{tA}‖
    pseudospectral_eps: float         # the ε used for the pseudospectral abscissa/gate
    margin: float

    @property
    def proven_contracting(self) -> bool:
        return self.gate_numerical_range or self.gate_lyapunov

    def summary(self) -> str:
        nr = "PASS" if self.gate_numerical_range else "fail"
        ly = "PASS" if self.gate_lyapunov else "fail"
        return (f"gates[#768]: numerical-range(ω={self.numerical_range_abscissa:+.4f})={nr} "
                f"lyapunov(maxReλ={self.spectral_abscissa:+.4f})={ly} "
                f"transient≤{self.lyapunov_transient_bound:.3g} "
                f"α_ε≤{self.pseudospectral_abscissa:+.4f} K(A)≥{self.kreiss_bound:.3g} → "
                f"{'PROVEN contracting' if self.proven_contracting else 'not certified'}")


def _worst_gates(gates: Sequence[StabilityGates]) -> StabilityGates:
    """A batch passes a gate only if every member does; numbers report the worst member."""
    import math

    def worst(attr: str) -> float:
        vals = [getattr(g, attr) for g in gates]
        return float("nan") if any(math.isnan(v) for v in vals) else max(vals)

    return replace(
        max(gates, key=lambda g: g.spectral_abscissa),
        numerical_range_abscissa=worst("numerical_range_abscissa"),
        spectral_abscissa=worst("spectral_abscissa"),
        gate_numerical_range=all(g.gate_numerical_range for g in gates),
        gate_lyapunov=all(g.gate_lyapunov for g in gates),
        lyapunov_transient_bound=worst("lyapunov_transient_bound"),
        monotone_transient_bound=worst("monotone_transient_bound"),
        pseudospectral_abscissa=worst("pseudospectral_abscissa"),
        gate_pseudospectral=all(g.gate_pseudospectral for g in gates),
        kreiss_bound=worst("kreiss_bound"),
    )


@torch.no_grad()
def stability_gates(A: Tensor, margin: float = 0.0, pseudo_eps: float = 1e-2) -> StabilityGates:
    """#768 Tier-A provable region-wideners for a (possibly non-normal) Jacobian A.

    Two SUFFICIENT contraction certificates. Neither rests on the small-gain index
    (alpha_sym + ‖A−A_s‖₂) that collapse_certificate() reports, which bounds nothing:

    1. Numerical-range gate (monotone, Euclidean):
         ω(A) = λ_max(A_s) < −margin  ⟹  ‖e^{tA}‖₂ ≤ e^{ω t}
       a strict, no-transient contraction (matrix measure μ₂; Lohmiller–Slotine 1998,
       Automatica 34(6)). ω(A) is the rightmost point of the numerical range W(A); since
       spec(A) ⊂ W(A), this gate IMPLIES the Lyapunov gate — it is the stricter of the two.

    2. Lyapunov gate (asymptotic, optimal metric):
         ∃P≻0 : (A+margin·I)ᵀP + P(A+margin·I) ≺ 0   ⟺   max Re λ(A) < −margin
       (classical Lyapunov theorem; equivalent to inf_T μ₂(T A T⁻¹) < −margin). Certified
       by solving the Lyapunov equation and checking P≻0. Accepts strongly non-normal A
       with transient growth (e.g. [[−1,10],[0,−1]]) that the numerical-range gate rejects.
       √cond(P) upper-bounds the Euclidean transient amplification sup_t ‖e^{tA}‖.

    Two transient-growth quantities round out the certificate (#768 gate #2):
      • pseudospectral abscissa — PROVABLE upper bound α_ε(A) ≤ ω(A)+ε via the field-of-
        values resolvent inequality ‖(zI−A)⁻¹‖₂ ≤ 1/dist(z, W(A)). gate_pseudospectral
        certifies α_ε(A) < −margin: no ε-sized perturbation pushes a mode into the RHP, a
        transient-aware strengthening of the monotone gate (reduces to ω(A) < −ε−margin).
      • Kreiss constant — K(A)=sup_{Re z>0} Re(z)·‖(zI−A)⁻¹‖₂, LOWER-bounded by sampling the
        RHP. Kreiss matrix theorem (continuous): K(A) ≤ sup_t‖e^{tA}‖ ≤ e·n·K(A), so it is a
        rigorous lower bound on the transient peak (complements √cond(P) / Crouzeix uppers).

    HONEST SCOPE: sufficient, not necessary; certify the FULL Jacobian's contraction
    (not collapse-onto-manifold). When W(A) ⊂ closed LHP (ω ≤ 0), ‖e^{tA}‖₂ ≤ 1 and there is
    no Euclidean transient at all (Lumer–Phillips). That covers [[−1,3],[−3,0]], whose ω=0:
    it fails the numerical-range gate only because the contraction is not strict. Applying
    Crouzeix–Palencia there gives 1+√2, which is true and vacuous, so it is not reported.
    """
    import numpy as np
    members = _batch_members(A)
    if len(members) > 1:
        return _worst_gates([stability_gates(m, margin, pseudo_eps) for m in members])
    Abar = members[0]
    M = Abar.detach().cpu().numpy().astype(float)
    n = M.shape[0]
    A_s = 0.5 * (M + M.T)
    omega = float(np.linalg.eigvalsh(A_s).max())
    spectral_abscissa = float(np.linalg.eigvals(M).real.max())

    gate_nr = omega < -margin

    gate_lyap = False
    transient = float("nan")
    try:
        import warnings
        from scipy.linalg import solve_continuous_lyapunov
        eye = np.eye(n)
        # Lyapunov theorem: A+margin·I Hurwitz ⟺ the solution P of (A+mI)ᵀP+P(A+mI)=−I
        # is ≻0  ⟺  max Re λ(A) < −margin. A near-singular Lyapunov operator (an
        # eigenvalue pair of A+mI summing to ≈0, i.e. A on the stability boundary) makes
        # scipy perturb the coefficients and warn; we reject BOTH that warning AND an
        # ill-conditioned P (relative test below), so the conservative "never certify on
        # the boundary" behavior does not depend on scipy's warning internals.
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            Pm = solve_continuous_lyapunov((M + margin * eye).T, -eye)
            pem = np.linalg.eigvalsh(0.5 * (Pm + Pm.T))
            if float(pem.min()) > 1e-12 * max(float(pem.max()), 1.0):
                gate_lyap = True
                # Transient bound for the ACTUAL dynamics e^{tA}: a margin-0 Lyapunov
                # solve (valid since gate-pass ⟹ A itself is Hurwitz). √cond(P₀) ≥
                # sup_t‖e^{tA}‖ exactly; the margin only sets the certified decay rate
                # (so this field is the true e^{tA} transient, not the m-inflated one).
                P0 = solve_continuous_lyapunov(M.T, -eye)
                pe0 = np.linalg.eigvalsh(0.5 * (P0 + P0.T))
                transient = float(np.sqrt(pe0.max() / pe0.min()))
    except Exception:
        pass

    monotone = 1.0 if omega <= 0.0 else float("nan")

    # #768 gate #2 — ε-pseudospectral abscissa: PROVABLE upper bound α_ε(A) ≤ ω(A)+ε
    # (every z in the ε-pseudospectrum has dist(z, W(A)) ≤ ε, so Re(z) ≤ ω(A)+ε). The gate
    # certifies α_ε(A) < −margin, i.e. no ε-sized perturbation reaches the RHP.
    pseudospectral_abscissa = omega + pseudo_eps
    gate_pseudospectral = pseudospectral_abscissa < -margin

    # Kreiss constant LOWER bound: K(A)=sup_{Re z>0} Re(z)·‖(zI−A)⁻¹‖₂ ≥ any sampled value.
    # ‖(zI−A)⁻¹‖₂ = 1/σ_min(zI−A). The resolvent SVD is O(n³); cap the sample budget for
    # large Jacobians (loop_lm's hidden-dim A) — a single RHP probe still gives a valid
    # lower bound. K(A) ≥ 1 always; >1 signals genuine non-normal transient growth.
    kreiss = 1.0
    try:
        eigs = np.linalg.eigvals(M)
        if n <= 64:
            y_span = float(np.max(np.abs(eigs.imag))) + 1.0
            scale = abs(spectral_abscissa) + 1.0
            xs = np.array([1e-3, 1e-2, 0.05, 0.1, 0.25, 0.5, 1.0]) * scale
            ys = np.linspace(-1.5 * y_span, 1.5 * y_span, 41)
        else:
            # one probe just inside the RHP, level with the rightmost eigenvalue
            xs = np.array([abs(spectral_abscissa) + 1e-2])
            ys = np.array([float(eigs.imag[int(np.argmax(eigs.real))])])
        eye_c = np.eye(n)
        for x in xs:
            for y in ys:
                smin = float(np.linalg.svd((x + 1j * y) * eye_c - M, compute_uv=False).min())
                if smin > 1e-15:
                    kreiss = max(kreiss, float(x) / smin)
    except Exception:
        kreiss = float("nan")

    return StabilityGates(
        numerical_range_abscissa=omega,
        spectral_abscissa=spectral_abscissa,
        gate_numerical_range=gate_nr,
        gate_lyapunov=gate_lyap,
        lyapunov_transient_bound=transient,
        monotone_transient_bound=monotone,
        pseudospectral_abscissa=pseudospectral_abscissa,
        gate_pseudospectral=gate_pseudospectral,
        kreiss_bound=kreiss,
        pseudospectral_eps=pseudo_eps,
        margin=margin,
    )


# ── #768 contraction half — Theorem 1 for NON-NORMAL A (spectral dichotomy) ───

def _boundary_kind(M, w, on_boundary, frozen_value: float, tol: float) -> str:
    """Classify the eigenvalues sitting on the stability boundary of M.

    "frozen"    every boundary mode is semisimple at `frozen_value` (λ=0 for a flow, λ=1 for a
                map): the state stops on a manifold of true fixed points.
    "rotating"  some semisimple boundary mode moves (±iω, or |λ|=1 with λ≠1, including the
                period-2 λ=−1): bounded forever and never frozen. A real third fate.
    "defective" a boundary eigenvalue has a Jordan block: polynomial growth, unbounded.
    """
    import numpy as np
    n = M.shape[0]
    scale = max(1.0, float(np.linalg.norm(M, 2)))
    # Merge generously: a Jordan block's eigenvalues split by ~√machine-eps, and a false merge
    # can only report "defective", which is the conservative side.
    near = max(10.0 * tol, 1e-6) * scale
    kind = "frozen"
    seen: List[complex] = []
    for lam in w[on_boundary]:
        if any(abs(lam - s) <= near for s in seen):
            continue
        seen.append(lam)
        algebraic = int(np.sum(np.abs(w - lam) <= near))
        singular = np.linalg.svd(M - lam * np.eye(n), compute_uv=False)
        geometric = int(np.sum(singular <= near))
        if geometric < algebraic:
            return "defective"
        if abs(lam - frozen_value) > near:
            kind = "rotating"
    return kind


def _settle_boundary(kind: str) -> Tuple[str, bool]:
    """(fate, collapses) for a slow block whose extreme eigenvalue is on the boundary."""
    if kind == "defective":
        return "DIVERGE", False
    return "MARGINAL", kind == "frozen"


def _coupling_norm(T, r: int) -> float:
    """‖Π‖₂ of the spectral projector for the split of block-triangular T at index r.

    Π_M = [[I, −X], [0, 0]] with T₁₁X − XT₂₂ = −T₁₂, so ‖Π_M‖ = ‖Π_N‖ = √(1+‖X‖²). This is where
    the cross-term went: the split makes it vanish in OBLIQUE coordinates, and this norm is its
    price, multiplying every bound stated in those coordinates."""
    import numpy as np
    from scipy.linalg import solve_sylvester
    if r <= 0 or r >= T.shape[0]:
        return 1.0
    X = solve_sylvester(T[:r, :r], -T[r:, r:], -T[:r, r:])
    return float(np.sqrt(1.0 + np.linalg.norm(X, 2) ** 2))


def _eigenbasis_condition(T) -> float:
    """κ(V) for T = VΛV⁻¹, which bounds sup‖e^{tT}‖ (or sup‖Tᵏ‖) once no mode grows."""
    import numpy as np
    return float(np.linalg.cond(np.linalg.eig(T)[1]))


def _worst_fate(certs, extreme_of):
    """A batch collapses only if every member does; report the worst member."""
    rank = {"COLLAPSE": 0, "MARGINAL": 1, "DIVERGE": 2}
    return max(certs, key=lambda c: (rank[c.fate], not c.collapses, extreme_of(c)))


@dataclass
class DichotomyCertificate:
    """Fate of the linear flow ẋ=Ax, for non-normal A, split by A's OWN spectrum.

    Theorem 1 (CollapseCertificate) splits the state by the SYMMETRIC part A_s and
    runs an energy V=½‖P_M x‖² on the active modes. For non-normal A the cross-term
    P_M A P_N ≠ 0 breaks V̇ ≤ 2αV, and the A_s-null manifold is not even invariant —
    so that proof genuinely fails. The fix is to split by A's OWN spectrum:

      active M = {Re λ < −δ},  slow/center N = {Re λ ≥ −δ}.

    These are A-invariant, so the oblique Riesz projector commutes with A and the
    cross-term is zero in those oblique coordinates. It reappears as `coupling_norm`:

      • (active) on M, A is Hurwitz (abscissa ≤ −δ). The reduced Lyapunov metric P
        (AᴹᵀP+PAᴹ=−I) gives ‖e^{tA}Π_M x‖ ≤ √cond(P)·e^{−t/(2λ_max(P))}‖Π_M x‖ → 0.
        `transient_bound` is that √cond(P): the ACTIVE BLOCK's overshoot, relative to
        ‖Π_M x‖. It says nothing about ‖x‖, which is what `full_transient_bound` bounds:
        sup_t‖e^{tA}‖ ≤ ‖Π‖·(sup‖e^{tAᴹ}‖ + sup‖e^{tAᴺ}‖). [[−1,1000],[0,0]] has
        transient_bound=1 and a true peak of 1000.
      • (fate) decided by β = max Re λ(N):
          β > 0                     DIVERGE
          β < 0                     COLLAPSE (the whole system is Hurwitz)
          β ≈ 0, Jordan block       DIVERGE, polynomially (marginal_kind="defective")
          β ≈ 0, semisimple at 0    MARGINAL, collapses: a manifold of fixed points ("frozen")
          β ≈ 0, semisimple ±iω     MARGINAL, does NOT collapse: sustained rotation ("rotating")

    So the linear regime has three outcomes, not two. Rotation is non-generic for an arbitrary
    matrix and structural for a skew-dominated or orthogonal one.

    For NORMAL A the Riesz projector IS the orthogonal A_s-projector, coupling_norm=1, and
    this reduces to Theorem 1 exactly.

    HONEST SCOPE: the LOCAL linear Jacobian only — NOT a global statement. Nonlinear systems
    also have limit cycles and chaos. Grounding remains the safety mechanism.
    See docs/SIGMA0-T1-NONNORMAL-DICHOTOMY.md.
    """
    fate: str                  # "COLLAPSE" | "MARGINAL" | "DIVERGE"
    collapses: bool            # active decays AND the slow block settles (no rotation, no growth)
    active_dim: int
    slow_dim: int
    active_abscissa: float     # max Re λ on M  (≤ −δ by construction; −inf if empty)
    slow_abscissa: float       # β = max Re λ on N — the quantity that decides the fate
    active_decay_rate: float   # 1/(2λ_max(P)): provable finite-t Lyapunov rate on M
    transient_bound: float     # √cond(P): the ACTIVE BLOCK's overshoot, not the whole state's
    invariance_residual: float # ‖(I−BBᵀ)A B‖: zero by construction of the Schur form
    delta: float
    marginal_kind: str = "none"          # "frozen" | "rotating" | "defective" when β ≈ 0
    coupling_norm: float = float("nan")  # ‖Π‖₂: how oblique the split is (1 for normal A)
    full_transient_bound: float = float("nan")  # bound on sup_t‖e^{tA}‖ (inf if unbounded)

    def summary(self) -> str:
        kind = f"/{self.marginal_kind}" if self.marginal_kind != "none" else ""
        return (
            f"dichotomy[#768]: fate={self.fate}{kind} "
            f"(active maxReλ={self.active_abscissa:+.4f} on {self.active_dim} modes, "
            f"slow β={self.slow_abscissa:+.4f} on {self.slow_dim}) "
            f"decay≥{self.active_decay_rate:.4f} active-transient≤{self.transient_bound:.3g} "
            f"coupling={self.coupling_norm:.3g} sup‖e^tA‖≤{self.full_transient_bound:.3g}"
        )


@torch.no_grad()
def dichotomy_certificate(A: Tensor, delta: float = 0.0,
                          tol: float = 1e-7) -> DichotomyCertificate:
    """Evaluate the non-normal spectral dichotomy on A (every batch member must pass).

    Splits A by its own spectrum at −δ (active = {Re λ < −δ}), certifies that the
    active block decays (reduced Lyapunov, bounded transient), and classifies the
    fate from the slow block's abscissa. Reuses the SAME Lyapunov metric as
    stability_gates(), applied to the active block Aᴹ.

    `delta ≥ 0` is the split threshold; use a value inside a spectral gap so the
    Schur reordering and the Sylvester solve stay well-conditioned. Robust on DEFECTIVE A
    (orthonormal Schur basis, no eigenvector inverse; #1989). Never raises on degeneracy —
    returns −inf abscissae and inf transient for the empty/ill-posed blocks.
    """
    import numpy as np
    members = _batch_members(A)
    if len(members) > 1:
        return _worst_fate([dichotomy_certificate(m, delta, tol) for m in members],
                           lambda c: c.slow_abscissa)
    M = members[0].detach().cpu().numpy().astype(float)
    n = M.shape[0]

    # eigenvalues (values only) for the split counts + abscissae; the SUBSPACE comes
    # from an ordered Schur factorization below, never from these eigenvectors
    w = np.linalg.eigvals(M)
    active_mask = w.real < -delta
    n_active = int(active_mask.sum())
    n_slow = n - n_active
    active_abscissa = float(w.real[active_mask].max()) if n_active else float("-inf")
    slow_abscissa = float(w.real[~active_mask].max()) if n_slow else float("-inf")

    # fate — decided by the slow block's abscissa β, and on the boundary by its structure
    marginal_kind = "none"
    if slow_abscissa > tol:
        fate, collapses = "DIVERGE", False
    elif slow_abscissa < -tol:
        fate, collapses = "COLLAPSE", True
    else:
        marginal_kind = _boundary_kind(M, w, np.abs(w.real) <= tol, 0.0, tol)
        fate, collapses = _settle_boundary(marginal_kind)

    # invariant-subspace split via ORDERED REAL SCHUR (orthonormal Z; #1989): the
    # leading sdim columns span the active invariant subspace EXACTLY (block-triangular
    # T ⇒ (I−BBᵀ)MB = 0 to machine eps), with NO eigenvector inverse — robust even for
    # DEFECTIVE A, where the old eig + oblique-Riesz split was ill-conditioned / abstained.
    invariance_residual = 0.0
    rate, transient = 0.0, float("nan")
    coupling, full = float("nan"), float("nan")
    # A MISSING DEPENDENCY must not be indistinguishable from "the rate is zero".
    # This import used to sit inside the broad `except Exception: pass` below, so on any
    # box without scipy the function silently returned a certificate claiming
    # active_decay_rate=0.0 and transient_bound=NaN — a provable bound that was never
    # computed, presented as if it had been. That is the exact failure the certificate
    # exists to prevent, so refuse instead of fabricating one.
    try:
        from scipy.linalg import schur, solve_continuous_lyapunov
    except ImportError as exc:
        raise RuntimeError(
            "dichotomy_certificate requires scipy (scipy.linalg.schur + "
            "solve_continuous_lyapunov) to compute the Lyapunov rate. Refusing to "
            "return an uncomputed certificate. Install scipy, or guard the caller."
        ) from exc
    try:
        T, Z, sdim = schur(M, output="real", sort=lambda z: z.real < -delta)
        r = int(sdim)
        if 0 < r <= n:
            B = Z[:, :r]
            invariance_residual = float(np.linalg.norm((np.eye(n) - B @ B.T) @ M @ B))
            A_M = T[:r, :r]                       # active block of the ordered Schur form
            # reduced Lyapunov P on Aᴹ (the SAME metric as stability_gates): AᴹᵀP+PAᴹ=−I
            P = solve_continuous_lyapunov(A_M.T, -np.eye(r))
            pe = np.linalg.eigvalsh(0.5 * (P + P.T))
            if float(pe.min()) > 0:
                rate = float(1.0 / (2.0 * pe.max()))            # finite-t Lyapunov rate
                transient = float(np.sqrt(pe.max() / pe.min())) # √cond(P) overshoot
        if fate == "DIVERGE":
            sup_slow = float("inf")
        elif r == n:
            sup_slow = 0.0
        elif slow_abscissa < -tol:
            Ps = solve_continuous_lyapunov(T[r:, r:].T, -np.eye(n - r))
            ps = np.linalg.eigvalsh(0.5 * (Ps + Ps.T))
            sup_slow = float(np.sqrt(ps.max() / ps.min()))
        else:
            sup_slow = _eigenbasis_condition(T[r:, r:])
        coupling = _coupling_norm(T, r)
        full = coupling * ((transient if r > 0 else 0.0) + sup_slow)
    except (np.linalg.LinAlgError, ValueError):
        # Genuine numerical failure (singular/ill-conditioned Lyapunov solve) — degrade
        # to rate 0.0, which callers read as "no provable rate". Narrowed from a bare
        # `except Exception` so a missing dependency or a coding error can no longer
        # masquerade as an honest numerical abstention.
        pass

    return DichotomyCertificate(
        fate=fate,
        collapses=collapses,
        active_dim=n_active,
        slow_dim=n_slow,
        active_abscissa=active_abscissa,
        slow_abscissa=slow_abscissa,
        active_decay_rate=rate,
        transient_bound=transient,
        invariance_residual=invariance_residual,
        delta=delta,
        marginal_kind=marginal_kind,
        coupling_norm=coupling,
        full_transient_bound=full,
    )


def _discrete_kreiss_lower_bound(M, tol: float = 1e-7) -> float:
    """Lower bound on the discrete Kreiss constant
    K_d(A) = sup_{|z|>1} (|z|−1)·‖(zI−A)⁻¹‖₂, by sampling z just outside the unit
    circle. Discrete Kreiss matrix theorem: K_d(A) ≤ sup_k‖Aᵏ‖ ≤ e·n·K_d(A), so this
    rigorously LOWER-bounds the transient peak (complements the √cond(P) upper bound)."""
    import numpy as np
    n = M.shape[0]
    Id = np.eye(n)
    best = 1.0  # K_d ≥ 1 always (k=0: ‖A⁰‖ = ‖I‖ = 1)
    for rr in (1.001, 1.01, 1.05, 1.2, 1.5, 2.0):
        for th in np.linspace(0.0, np.pi, 24):  # upper half-plane suffices (real M)
            z = rr * np.exp(1j * th)
            try:
                res = float(np.linalg.norm(np.linalg.inv(z * Id - M), 2))
            except np.linalg.LinAlgError:
                continue
            best = max(best, (rr - 1.0) * res)
    return float(best)


@dataclass
class DiscreteDichotomyCertificate:
    """Discrete-time analogue of DichotomyCertificate for the iteration x_{k+1}=A x_k.

    dichotomy_certificate certifies the CONTINUOUS flow e^{tA} (contraction ⟺
    max Re λ(A) < 0). But the §6 router demonstration — and any step-by-step
    generator — lives in DISCRETE time, where contraction is ρ(A) < 1: a different
    condition on a different object (§6 measures spectral radius ρ≈1.064, not an
    abscissa). This certifies the discrete condition by splitting A at the circle
    |z| = 1 − δ:

        active M = {|λ| < 1 − δ},  slow/center N = {|λ| ≥ 1 − δ}.

    The split comes from an ORDERED REAL SCHUR factorization (orthonormal Z), so it
    is A-invariant to machine precision even for DEFECTIVE A — no eigenvector inverse
    (the eig-based continuous path abstains on Jordan blocks; see #1989). Then:

      • (active) on M, A is Schur-stable (ρ ≤ 1 − δ). The reduced DISCRETE Lyapunov
        metric P (AᴹᵀPAᴹ − P = −I, so P ⪰ I) gives ‖Aᴹᵏ x‖ ≤ √cond(P)·γ^{k/2}‖x‖
        with γ = 1 − 1/λ_max(P) ∈ [0,1): the active modes ALWAYS decay, after a
        bounded transient √cond(P).
      • (fate) decided by the slow spectral radius ρ_N = max|λ(N)| = ρ(A):
          ρ_N > 1                  DIVERGE
          ρ_N < 1                  COLLAPSE (whole iteration Schur-stable)
          ρ_N ≈ 1, Jordan block    DIVERGE, polynomially (marginal_kind="defective")
          ρ_N ≈ 1, semisimple at 1 MARGINAL, collapses: fixed points ("frozen")
          ρ_N ≈ 1, otherwise       MARGINAL, does NOT collapse: rotation or period-2 ("rotating")

    `transient_bound` is the active block's overshoot; `full_transient_bound` bounds
    sup_k‖Aᵏ‖ for the whole state, including the coupling between the blocks.

    For NORMAL A this reduces to "ρ(A) < 1 ⟺ convergence" exactly. HONEST SCOPE:
    contraction of the LOCAL linear Jacobian's discrete iteration — NOT a global
    guarantee; grounding remains the safety mechanism. See #1988 and
    docs/SIGMA0-COLLAPSE-CERTIFICATE.md §6.
    """
    fate: str                    # "COLLAPSE" | "MARGINAL" | "DIVERGE"
    collapses: bool              # active decays AND the slow block settles (no rotation, no growth)
    active_dim: int
    slow_dim: int
    active_radius: float         # max|λ| on M (≤ 1−δ by construction; 0 if empty)
    slow_radius: float           # ρ_N = max|λ| on N — the quantity that decides the fate
    active_decay_factor: float   # √γ = √(1−1/λ_max(P)): provable per-step contraction on M
    transient_bound: float       # √cond(P): bound on sup_k ‖Aᴹᵏ‖ (nan if not Schur-stable)
    kreiss_bound: float          # discrete Kreiss lower bound ≤ sup_k ‖Aᵏ‖
    invariance_residual: float   # ‖(I−BBᵀ)A B‖: zero by construction of the Schur form
    delta: float
    marginal_kind: str = "none"          # "frozen" | "rotating" | "defective" when ρ_N ≈ 1
    coupling_norm: float = float("nan")  # ‖Π‖₂: how oblique the split is (1 for normal A)
    full_transient_bound: float = float("nan")  # bound on sup_k‖Aᵏ‖ (inf if unbounded)

    def summary(self) -> str:
        kind = f"/{self.marginal_kind}" if self.marginal_kind != "none" else ""
        return (
            f"discrete-dichotomy[#1988]: fate={self.fate}{kind} "
            f"(active ρ={self.active_radius:.4f} on {self.active_dim} modes, "
            f"slow ρ_N={self.slow_radius:.4f} on {self.slow_dim}) "
            f"decay≤{self.active_decay_factor:.4f}/step active-transient≤{self.transient_bound:.3g} "
            f"coupling={self.coupling_norm:.3g} sup‖Aᵏ‖≤{self.full_transient_bound:.3g}"
        )


@torch.no_grad()
def discrete_dichotomy_certificate(A: Tensor, delta: float = 0.0,
                                   tol: float = 1e-7) -> DiscreteDichotomyCertificate:
    """Evaluate the discrete-time spectral dichotomy on A (iteration x_{k+1}=A x_k).

    Discrete analogue of dichotomy_certificate: splits A by MODULUS at |z| = 1 − δ
    (active = {|λ| < 1 − δ}) via an ORDERED REAL SCHUR factorization, certifies the
    active block's per-step contraction with the discrete Lyapunov (Stein) metric,
    and classifies the fate from the slow block's spectral radius ρ_N = ρ(A). Robust
    on defective A (orthonormal Schur basis, no eigenvector inverse).

    `delta ∈ [0,1)` shrinks the split circle; use a value inside a spectral gap so
    the Schur reordering stays well-conditioned. Counts + fate are numpy-only (always
    computed); the certified Lyapunov/Kreiss metrics need scipy and degrade to nan if
    it is absent. Never raises on degeneracy.
    """
    import numpy as np
    members = _batch_members(A)
    if len(members) > 1:
        return _worst_fate([discrete_dichotomy_certificate(m, delta, tol) for m in members],
                           lambda c: c.slow_radius)
    M = members[0].detach().cpu().numpy().astype(float)
    n = M.shape[0]
    radius = 1.0 - float(delta)

    # eigen-moduli: split counts + slow-block radius (values only; the SUBSPACE comes
    # from Schur below, never from these eigenvectors)
    w = np.linalg.eigvals(M)
    moduli = np.abs(w)
    active_mask = moduli < radius
    n_active = int(active_mask.sum())
    n_slow = n - n_active
    active_radius = float(moduli[active_mask].max()) if n_active else 0.0
    slow_radius = float(moduli[~active_mask].max()) if n_slow else 0.0

    # fate — decided by the slow block's spectral radius ρ_N = ρ(A), and at the circle by
    # its structure
    marginal_kind = "none"
    if n_slow == 0:
        fate, collapses = "COLLAPSE", True           # every mode inside the split circle
    elif slow_radius > 1.0 + tol:
        fate, collapses = "DIVERGE", False
    elif slow_radius < 1.0 - tol:
        fate, collapses = "COLLAPSE", True
    else:
        marginal_kind = _boundary_kind(M, w, np.abs(moduli - 1.0) <= tol, 1.0, tol)
        fate, collapses = _settle_boundary(marginal_kind)

    invariance_residual = float("nan")
    rate_factor, transient, kreiss = 0.0, float("nan"), float("nan")
    coupling, full = float("nan"), float("nan")
    # Same reasoning as the continuous certificate above: a missing dependency must not
    # be reported as "rate_factor = 0.0", which reads as a computed result.
    try:
        from scipy.linalg import schur, solve_discrete_lyapunov
    except ImportError as exc:
        raise RuntimeError(
            "discrete_dichotomy_certificate requires scipy (scipy.linalg.schur + "
            "solve_discrete_lyapunov). Refusing to return an uncomputed certificate."
        ) from exc
    try:
        # ordered real Schur: active (|λ|<radius) eigenvalues to the top-left block.
        # Z orthonormal ⇒ leading sdim columns span the active invariant subspace
        # EXACTLY (block-triangular T ⇒ (I−BBᵀ)MB=0 to machine eps) — defective-safe.
        T, Z, sdim = schur(M, output="real", sort=lambda z: abs(z) < radius)
        r = int(sdim)
        invariance_residual = 0.0
        if 0 < r <= n:
            B = Z[:, :r]
            invariance_residual = float(np.linalg.norm((np.eye(n) - B @ B.T) @ M @ B))
            A_M = T[:r, :r]                       # active block of the ordered Schur form
            # discrete Lyapunov AᴹᵀPAᴹ − P = −I (scipy solves aXaᵀ−X+q=0 ⇒ a=Aᴹᵀ, q=I)
            P = solve_discrete_lyapunov(A_M.T, np.eye(r))
            P = 0.5 * (P + P.T)
            pe = np.linalg.eigvalsh(P)
            if float(pe.min()) > 0:
                lam_max = float(pe.max())
                gamma = min(max(1.0 - 1.0 / lam_max, 0.0), 1.0)  # per-step V-contraction
                rate_factor = float(np.sqrt(gamma))
                transient = float(np.sqrt(lam_max / float(pe.min())))
        kreiss = _discrete_kreiss_lower_bound(M, tol)
        if fate == "DIVERGE":
            sup_slow = float("inf")
        elif r == n:
            sup_slow = 0.0
        elif slow_radius < 1.0 - tol:
            Ps = solve_discrete_lyapunov(T[r:, r:].T, np.eye(n - r))
            ps = np.linalg.eigvalsh(0.5 * (Ps + Ps.T))
            sup_slow = float(np.sqrt(ps.max() / ps.min()))
        else:
            sup_slow = _eigenbasis_condition(T[r:, r:])
        coupling = _coupling_norm(T, r)
        full = coupling * ((transient if r > 0 else 0.0) + sup_slow)
    except Exception:
        pass

    return DiscreteDichotomyCertificate(
        fate=fate,
        collapses=collapses,
        active_dim=n_active,
        slow_dim=n_slow,
        active_radius=active_radius,
        slow_radius=slow_radius,
        active_decay_factor=rate_factor,
        transient_bound=transient,
        kreiss_bound=kreiss,
        invariance_residual=invariance_residual,
        delta=float(delta),
        marginal_kind=marginal_kind,
        coupling_norm=coupling,
        full_transient_bound=full,
    )


@dataclass
class JsrrCertificate:
    """Jacobian Spectral Radius acceptance gate for the discrete loop x_{k+1}=A x_k.

    Ports the stability criterion validated externally on real looped LLMs — STARS,
    "Stabilizing Recurrent Dynamics for Test-Time Scalable Latent Reasoning in Looped
    Language Models" (arXiv:2605.26733): a recurrent fixed point h* is asymptotically
    stable iff ρ(J(h*)) < 1, and STARS trains toward it by penalising the JSRR loss
    ‖J v‖₂² (their Eq. 3) estimated by single-step power iteration on a Jacobian-vector
    product. Here the loop's empirical exit-depth Jacobian A is already materialised, so
    ρ is taken EXACTLY from its eigen-moduli (the canonical discrete-family computation,
    shared with discrete_dichotomy_certificate); the STARS single-step surrogate is
    reported alongside for continuity with a JVP-only training/serving path (the matvec
    form lives in experiments/sigma0_jacobian_stability.py, #2029).
    """
    spectral_radius: float      # exact ρ(A)=max|λ| — the discrete asymptotic-stability criterion
    radius_estimate: float      # STARS single-step power-iteration proxy ‖A v‖₂ (‖v‖=1)
    spectral_norm: float        # σ_max=‖A‖₂ — the quantity the surrogate bounds (ρ ≤ σ_max always)
    penalty: float              # STARS JSRR loss surrogate ‖A v‖₂² (Eq. 3); reusable as a regulariser
    margin: float               # safety band: stable demands ρ < 1 − margin
    stable: bool                # ρ < 1 − margin  → accept (asymptotically stable fixed point)
    regime: str                 # 'contraction' (ρ<1) | 'critical' (ρ≈1) | 'divergent' (ρ>1)

    def summary(self) -> str:
        return (f"JSRR: ρ={self.spectral_radius:.4f} (‖Av‖≈{self.radius_estimate:.4f}, "
                f"σ_max={self.spectral_norm:.4f}) {self.regime} → "
                f"{'ACCEPT' if self.stable else 'reject'} (margin {self.margin:g})")


@torch.no_grad()
def jsrr_certificate(A: Tensor, margin: float = 0.0, seed: int = 0) -> JsrrCertificate:
    """Discrete spectral-radius acceptance gate (JSRR / STARS, arXiv:2605.26733).

    Accept iff ρ(A) < 1 − `margin`, where ρ is the exact largest eigen-modulus of the
    (mean) Jacobian A. Unlike the continuous #768 gates (stability_gates), which certify
    contraction of e^{tA} and conservatively over-reject non-normal A with transient
    growth, this is the DISCRETE criterion appropriate to an iterated recurrent loop —
    the same object STARS regularises on real looped LLMs. numpy-only (no scipy), so it
    is importable in the minimal inference venv; never raises (nan-safe verdict on a
    degenerate A). `margin=0` is STARS' literal ρ<1; a small band (~0.05) rejects states
    hugging the critical circle, and CART (arXiv:2606.01495) found trained gates settle
    ρ∈[0.79,0.83], i.e. comfortably inside a 0.05 band.

    This reads the spectrum only. [[.99,1000],[0,.99]] passes with 37,000× transient growth,
    and passing at each step says nothing about a sequence of different maps: [[0,2],[0,0]] and
    [[0,0],[2,0]] both have ρ=0 while their product has ρ=4. For the serve path's own verdict
    use loop_contraction_certificate, which is a norm measured on the iterates.
    """
    import numpy as np
    members = _batch_members(A)
    if len(members) > 1:
        certs = [jsrr_certificate(m, margin, seed) for m in members]
        return max(certs, key=lambda c: c.spectral_radius if c.spectral_radius == c.spectral_radius
                   else float("inf"))
    M = members[0].detach().cpu().numpy().astype(float)

    # exact discrete spectral radius ρ = max|λ| (canonical; shares the eigvals path with
    # discrete_dichotomy_certificate). σ_max = largest singular value ≥ ρ, the bound the
    # STARS single-step surrogate ‖Av‖ approximates from below.
    try:
        rho = float(np.abs(np.linalg.eigvals(M)).max())
    except Exception:
        rho = float("nan")
    try:
        spectral_norm = float(np.linalg.svd(M, compute_uv=False).max())
    except Exception:
        spectral_norm = float("nan")

    # STARS single-step power iteration on a random unit v: estimate ‖Av‖ (radius proxy)
    # and the JSRR training-loss surrogate ‖Av‖² (Eq. 3). One step matches STARS exactly;
    # it is a σ_max estimate (a ρ upper bound), reported for parity with the JVP-only path.
    try:
        rng = np.random.RandomState(seed)
        v = rng.randn(M.shape[0])
        v = v / (np.linalg.norm(v) or 1.0)
        Av = M @ v
        radius_estimate = float(np.linalg.norm(Av))
        penalty = float(radius_estimate ** 2)
    except Exception:
        radius_estimate, penalty = float("nan"), float("nan")

    # regime + verdict (mirrors experiments/sigma0_jacobian_stability.stability_verdict)
    if rho != rho:                       # nan ⇒ cannot certify → do not accept
        regime, stable = "divergent", False
    elif abs(rho - 1.0) < 1e-9:
        regime, stable = "critical", (rho < 1.0 - margin)
    elif rho < 1.0:
        regime, stable = "contraction", (rho < 1.0 - margin)
    else:
        regime, stable = "divergent", False

    return JsrrCertificate(
        spectral_radius=rho,
        radius_estimate=radius_estimate,
        spectral_norm=spectral_norm,
        penalty=penalty,
        margin=float(margin),
        stable=bool(stable),
        regime=regime,
    )


def depth_contraction_stats(hidden_per_step: Sequence[Tensor],
                            tol: float = 1e-6) -> Optional[Tuple[float, float]]:
    """One token's contraction, measured on the loop's own iterates h¹…hᴷ.

    With residuals eₖ = hᵏ⁺¹ − hᵏ we have eₖ₊₁ = f(hᵏ⁺¹) − f(hᵏ) ≈ J·eₖ, so ‖eₖ₊₁‖/‖eₖ‖ is a
    finite-difference Jacobian-vector norm of the recurrent map along its own residual. It needs
    no extra forward passes, does not depend on the scale of h, and is a norm rather than an
    eigenvalue, so it sees non-normal growth.

    Returns (ratio, amplification), or None with fewer than three iterates:
      ratio          ‖e_last‖/‖e_prev‖ at the deepest step still above numerical noise
      amplification  max_k ‖eₖ‖/‖e₁‖, the residual growth anywhere inside the loop
    Residuals below the numerical floor (tol·‖h‖, or 8 machine epsilons·‖h‖ if larger: float16
    is what the serve path runs) count as converged, so a token already at its fixed point
    reads (0.0, 1.0) rather than dividing noise by noise.
    """
    hs = list(hidden_per_step)
    if len(hs) < 3:
        return None
    noise = 8.0 * torch.finfo(hs[0].dtype).eps
    floor = max(tol, noise) * (max(float(h.norm()) for h in hs) or 1.0)
    e = [float((hs[k + 1] - hs[k]).norm()) for k in range(len(hs) - 1)]
    if e[0] <= floor:
        return 0.0, 1.0
    ratio = 0.0
    for k in range(len(e) - 1, 0, -1):
        if e[k - 1] > floor:
            ratio = e[k] / e[k - 1]
            break
    return ratio, max(e) / e[0]


@dataclass
class LoopContractionCertificate:
    """Did the recurrent loop contract on this generation? Measured, not proven: it covers the
    residuals the loop actually produced, not every direction, and it is not a statement about
    truth. Takes the 90th percentile across tokens, so one odd token does not decide.
    `transient_max` is a design default, not calibrated on a real model."""
    factor: float           # 90th percentile of per-token last-step ‖e_last‖/‖e_prev‖
    worst_factor: float     # max over tokens
    transient: float        # 90th percentile of per-token residual amplification inside the loop
    n_tokens: int
    margin: float           # stable demands factor < 1 − margin
    transient_max: float    # stable demands transient ≤ this
    stable: bool
    regime: str             # contraction | critical | transient | plateau | divergent

    def summary(self) -> str:
        return (f"loop contraction: factor={self.factor:.4f} (worst {self.worst_factor:.4f}) "
                f"transient={self.transient:.3g} over {self.n_tokens} tokens → {self.regime}"
                f"{' ACCEPT' if self.stable else ' reject'}")


def loop_contraction_certificate(stats, margin: float = 0.0, transient_max: float = 10.0,
                                 quantile: float = 0.9) -> Optional[LoopContractionCertificate]:
    """Aggregate depth_contraction_stats over a generation. None when no token had enough
    iterates: an honest unknown, not a verdict. numpy-only, like jsrr_certificate."""
    import numpy as np
    usable = [s for s in (stats or []) if s is not None]
    if not usable:
        return None
    ratios = np.array([s[0] for s in usable], dtype=float)
    amps = np.array([s[1] for s in usable], dtype=float)
    factor = float(np.quantile(ratios, quantile))
    transient = float(np.quantile(amps, quantile))
    if factor >= 1.0:
        # Stopped shrinking. Past its starting size that is growth; below it, the loop has settled
        # on a non-zero plateau, which is what real Ouro does past its trained depth (residuals fall
        # from ~30 to ~3 and stay there): bounded, moving, and neither frozen nor diverging.
        regime = "divergent" if transient >= 1.25 else "plateau"
    elif transient > transient_max:
        regime = "transient"
    elif factor >= 1.0 - margin:
        regime = "critical"
    else:
        regime = "contraction"
    return LoopContractionCertificate(
        factor=factor,
        worst_factor=float(ratios.max()),
        transient=transient,
        n_tokens=len(usable),
        margin=float(margin),
        transient_max=float(transient_max),
        stable=regime == "contraction",
        regime=regime,
    )


@torch.no_grad()
def lyapunov_value(x: Tensor, A: Tensor, eig_eps: float = 1e-2) -> float:
    """V(x) = ½‖P_M x‖² — energy in the active (non-null) subspace of A_s."""
    Abar = A.mean(0) if A.dim() == 3 else A
    A_s = 0.5 * (Abar + Abar.T)
    evals, evecs = torch.linalg.eigh(A_s)
    active = evecs[:, evals.abs() >= eig_eps]      # (d, m)
    if active.shape[1] == 0:
        return 0.0
    xm = x @ active                                # project onto active modes
    return float(0.5 * (xm ** 2).sum(-1).mean().item())


# ── Σ₀⁻¹ Anti-Collapse Operator ──────────────────────────────────────────────

class AntiCollapseOperator:
    """
    Σ₀⁻¹ — prevents 42-states by persistent excitation along null modes.

    Where Σ₀ projects ONTO the null subspace (collapse), Σ₀⁻¹ injects energy
    ALONG it. As the system approaches the collapse boundary it loses
    directional structure; Σ₀⁻¹ restores rank and re-anisotropizes Σ by adding a
    perturbation in exactly the directions that have gone flat — the
    persistent-excitation principle from adaptive control.

        dx = f dt + dW + Σ₀⁻¹,   Σ₀⁻¹ = strength · p · (V_null · ξ)

    `p ∈ [0,1]` is collapse proximity: 0 when far from the boundary (no-op),
    rising to 1 as ∇L, Jacobian rank, Σ anisotropy and control sensitivity all
    approach their collapse thresholds. The excitation is gated by p so it costs
    nothing in healthy regimes and only fires near a 42-state.

    What is proven about the two legs (docs/SIGMA0-COLLAPSE-CERTIFICATE.md §3):
      • covariance leg (C3): after the engine's own projection, a(Σ_next) ≥ ε_a, so the gate
        cannot be true on consecutive evaluations.
      • state leg (S1): each firing leaves the ball {‖∇ₓL‖ < ε_g} with probability ≥ ½, for any
        drift and any p.
    Neither promises perpetual motion. A system with no drift, no noise and no grounding rests
    at an equilibrium once the gate has cleared.
    """

    # Target a(Σ⁺) ≥ 1.02·ε_a, so that a(Σ_next) ≥ ε_a survives raising near-zero eigenvalues to
    # the covariance floor, whenever d·eps/sigma_max ≤ 9e-4 (d up to ~9000 at the defaults).
    LIFT_MARGIN = 1.02

    def __init__(self, detector: Optional[SemanticCollapseOperator] = None,
                 strength: float = 0.5, eig_eps: float = 1e-2) -> None:
        self.detector = detector or SemanticCollapseOperator()
        self.strength = strength
        self.eig_eps = eig_eps

    def proximity_per_sample(self, model, x: Tensor, u: Tensor, sigma: Tensor,
                              A: Tensor) -> Tensor:
        """Per-member collapse proximity; no batch averaging can hide one failing member."""
        d = self.detector
        grad_norm = d._grad_norm_per_sample(model, x, u)
        eff_rank = d._effective_rank_per_sample(A)
        aniso = d._anisotropy_per_sample(sigma)
        ctrl = d._ctrl_sensitivity_per_sample(model, x, u)
        dim = float(x.shape[-1])

        def below(values, threshold):
            if threshold <= 0:
                return torch.zeros_like(values)
            return (1.0 - values / threshold).clamp(0.0, 1.0)

        return torch.stack((
            below(grad_norm, d.grad_eps),
            below(eff_rank, d.rank_frac * dim),
            below(aniso, d.anisotropy_eps),
            below(ctrl, d.ctrl_eps),
        ), dim=0).amin(dim=0)

    def proximity(self, model, x: Tensor, u: Tensor, sigma: Tensor,
                  A: Tensor) -> float:
        """Compatibility summary: maximum per-sample proximity in the batch."""
        return float(self.proximity_per_sample(model, x, u, sigma, A).max().item())

    @torch.no_grad()
    def _near_null_basis(self, A: Tensor) -> Tensor:
        """The m smallest-|λ(A_s)| eigenvectors — the banded near-null subspace (Fix B).

        m = clamp(max(hard_null_count, d − round(eff_rank)), 1, d−1).

        Two corrections over the old hard `|λ| < eig_eps` cutoff (see
        docs/SIGMA0-C3-NONCOLLAPSE-NORMAL.md §2.2):
          • G13 — modes parked just above eig_eps no longer yield a rank-0 (blank)
            bump: the rank deficit `d − eff_rank` guarantees `m ≥ 1` whenever
            `cond_rank` fires.
          • k=d clamp — `m ≤ d−1` always leaves ≥1 mode unbumped, so the covariance
            bump creates genuine anisotropy. Bumping ALL d modes is `Σ + b·I`, a
            uniform shift that LOWERS anisotropy (std unchanged, mean up) — the
            opposite of the intent, and L2's denominator √(k(d−k)) − ε·k is negative
            at k=d. Full degeneracy is handled as a k=d−1 bump.
          • feasibility — above d≈100 the rank must also stay below _max_lift_rank(d), because
            a rank-m bump tops out at a(Σ⁺) ≈ √((d−m)/m) and d−1 modes cannot reach ε_a at all
            once d > 401. L2′ allows any projector, so bumping fewer modes loses nothing.
        """
        Abar = 0.5 * (A.mean(0) + A.mean(0).T) if A.dim() == 3 else 0.5 * (A + A.T)
        d = Abar.shape[-1]
        evals, evecs = torch.linalg.eigh(Abar)
        absval = evals.abs()
        hard_null = int((absval < self.eig_eps).sum().item())
        eff_rank = self.detector._effective_rank(A if A.dim() == 3 else A.unsqueeze(0))
        m = max(hard_null, d - int(round(eff_rank)))
        m = max(1, min(m, self._max_lift_rank(d)))         # proper AND feasible subspace
        idx = torch.argsort(absval)[:m]                    # m smallest |λ| modes
        return evecs[:, idx]                               # (d, m)

    def _max_lift_rank(self, d: int) -> int:
        """Largest m with ε·m ≤ ½√(m(d−m)), i.e. m ≤ d/(1+4ε²), clamped to [1, d−1]. Keeping the
        L2′ denominator at least half its numerator bounds Δ by about (1+a/ε)μ across the trigger
        regime (m ≥ d/2) in EVERY dimension, rather than letting it blow up as m→d−1 and then
        become impossible."""
        eps = self.detector.anisotropy_eps * self.LIFT_MARGIN
        return max(1, min(d - 1, int(d / (1.0 + 4.0 * eps * eps))))

    @torch.no_grad()
    @torch.no_grad()
    def _near_null_projector_per_sample(self, A: Tensor, batch_size: int) -> tuple[Tensor, Tensor]:
        """Batched right near-kernel projectors from each member's SVD.

        Returns (P, m), with P[b] the rank-m[b] projector onto that member's
        smallest right-singular directions. This avoids batch-mean rank masking
        and symmetric-part eigenvectors that need not lie in ker(A) for non-normal A.
        """
        if A.dim() == 2:
            A = A.unsqueeze(0)
        if A.shape[0] == 1 and batch_size > 1:
            A = A.expand(batch_size, -1, -1)
        if A.shape[0] != batch_size:
            raise ValueError("Jacobian batch must match state batch")
        _, singular_values, vh = torch.linalg.svd(A, full_matrices=True)
        d = A.shape[-1]
        smax = singular_values.max(dim=-1, keepdim=True).values
        hard_null = (singular_values <= self.eig_eps * smax).sum(dim=-1)
        rank = (singular_values > self.eig_eps * smax).sum(dim=-1)
        m = torch.maximum(hard_null, d - rank).clamp(
            min=1, max=self._max_lift_rank(d)
        )
        max_m = int(m.max().item())
        order = torch.argsort(singular_values, dim=-1)[:, :max_m]
        basis = vh.transpose(-1, -2).gather(
            2, order.unsqueeze(1).expand(-1, d, -1)
        )
        mask = (
            torch.arange(max_m, device=A.device).unsqueeze(0)
            < m.unsqueeze(-1)
        ).to(dtype=A.dtype)
        projector = (basis * mask.unsqueeze(1)) @ basis.transpose(-1, -2)
        return projector, m

    def _cov_floor(self, sigma: Tensor, d: int, m: Tensor | int) -> Tensor:
        """Per-sample L2′ bump threshold for each sample's own projector rank."""
        eps = self.detector.anisotropy_eps * self.LIFT_MARGIN
        m = torch.as_tensor(m, device=sigma.device, dtype=sigma.dtype)
        if m.ndim == 0:
            m = m.expand(sigma.shape[0])
        denom = torch.sqrt(m * (d - m)) - eps * m
        if bool((denom <= 0).any()):
            raise ValueError("no finite covariance bump for one or more per-sample ranks")
        sym = 0.5 * (sigma + sigma.transpose(-1, -2))
        ev = torch.linalg.eigvalsh(sym).clamp_min(1e-12)
        mu = ev.mean(dim=-1)
        a = ev.std(dim=-1) / mu
        return (eps + a) * mu * d / denom

    def _kick_scale(self, p: Tensor | float) -> Tensor | float:
        """State-kick magnitude κ, evaluated independently for each active sample."""
        if self.strength <= 0.0:
            return torch.zeros_like(p) if torch.is_tensor(p) else 0.0
        floor = self.detector.grad_eps / (2.0 * _MEDIAN_CHI_1)
        if torch.is_tensor(p):
            return torch.maximum(self.strength * p, torch.full_like(p, floor))
        return max(self.strength * p, floor)

    @torch.no_grad()
    def excite(self, x: Tensor, sigma: Tensor, A: Tensor, p: Tensor | float,
               noise: Tensor) -> tuple[Tensor, Tensor]:
        """Apply per-sample right-kernel excitation and covariance shape lift.

        Each member gets its own right near-kernel projector. Samples with p=0
        receive neither a state kick nor a covariance bump.
        """
        p = torch.as_tensor(p, device=x.device, dtype=x.dtype)
        if p.ndim == 0:
            p = p.expand(x.shape[0])
        if p.shape != (x.shape[0],):
            raise ValueError("proximity must be scalar or one value per sample")

        d = x.shape[-1]
        projector, m = self._near_null_projector_per_sample(A, x.shape[0])
        active = (p > 0).to(dtype=x.dtype)
        projector = projector * active[:, None, None]

        projected_noise = torch.bmm(noise.unsqueeze(1), projector).squeeze(1)
        kappa = self._kick_scale(p) * active
        dx_extra = kappa.unsqueeze(-1) * projected_noise

        b_cov = torch.maximum(self._cov_floor(sigma, d, m), self.strength * p)
        sigma_extra = b_cov[:, None, None] * projector
        return dx_extra, sigma_extra


def _below(value: float, threshold: float) -> float:
    """Soft indicator → 1 when value ≪ threshold, 0 when value ≥ threshold."""
    if threshold <= 0:
        return 0.0
    return max(0.0, min(1.0, 1.0 - value / threshold))


# ── Σ₀ᴿ Reconstruction Operator ───────────────────────────────────────────────

class ReconstructionOperator:
    """
    Σ₀ᴿ — reference-driven reconstruction: the "put the smoke back" operator.

    Σ₀ collapse contracts the ACTIVE modes (|λ(A_s)| ≥ ε) to zero and freezes the
    state onto the null manifold — the structure that lived in the active modes is
    the "smoke" that disperses. `AntiCollapseOperator.excite` re-injects RANDOM
    energy: it can un-freeze a collapsed state, but random ξ carries no information
    about the original, so it lights *a* fire, not *the* fire.

    ReconstructionOperator keeps a compact SEED of the pre-collapse active content
    (the top-k mode coefficients — the "speck of dust") and regenerates from it.
    The minimal seed size that hits a target fidelity is the state's effective
    dimension: a hard floor. You cannot reconstruct information you did not keep —
    the speck holds the world only as far as the world is compressible. This is
    the encode side of the certificate: convergence as compression, with the
    second law showing up as the floor of the rate–distortion curve.
    """

    def __init__(self, eig_eps: float = 1e-2) -> None:
        self.eig_eps = eig_eps

    @torch.no_grad()
    def _active_basis(self, A: Tensor) -> Tensor:
        """Eigenvectors of A_s for the structured (non-null) modes — (d, m)."""
        Abar = A.mean(0) if A.dim() == 3 else A
        A_s = 0.5 * (Abar + Abar.T)
        evals, evecs = torch.linalg.eigh(A_s)
        return evecs[:, evals.abs() >= self.eig_eps]

    @torch.no_grad()
    def collapse(self, x: Tensor, A: Tensor) -> Tensor:
        """Burn: contract the active modes, keep only the null manifold (P_null x)."""
        V = self._active_basis(A)
        return x - (x @ V) @ V.T

    @torch.no_grad()
    def seed(self, x: Tensor, A: Tensor, k: int) -> Dict:
        """Compress x to its top-k active-mode coefficients — the 'speck of dust'."""
        V = self._active_basis(A)                          # (d, m)
        coeffs = x @ V                                     # (..., m)
        score = coeffs.abs().mean(0) if coeffs.dim() > 1 else coeffs.abs()
        k = max(0, min(int(k), V.shape[1]))
        idx = (torch.topk(score, k).indices if k > 0
               else torch.empty(0, dtype=torch.long, device=x.device))
        return {"idx": idx, "coeffs": coeffs.index_select(-1, idx),
                "basis": V, "k": k, "active_dim": int(V.shape[1])}

    @torch.no_grad()
    def reconstruct(self, x_collapsed: Tensor, seed: Dict) -> Tensor:
        """Regrow from the collapsed state + the retained seed."""
        idx, coeffs, V = seed["idx"], seed["coeffs"], seed["basis"]
        if idx.numel() == 0:
            return x_collapsed
        Vk = V.index_select(-1, idx)                       # (d, k)
        return x_collapsed + coeffs @ Vk.T
