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

import math
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
    batch (LinearDynamics) reduces to one member, so it costs one evaluation. Identical means
    exactly: 0.999995·I and 1.000004·I are "close" and sit on opposite sides of the boundary.
    """
    if A.dim() != 3:
        return [A]
    if A.shape[0] == 1 or torch.equal(A, A[0].expand_as(A)):
        return [A[0]]
    return list(A)


def _worst_value(certs, attr: str, pick=max) -> float:
    """One number for a batch: the worst member's, or NaN if any member could not compute it."""
    vals = [getattr(c, attr) for c in certs]
    return float("nan") if any(math.isnan(v) for v in vals) else pick(vals)


class CollapseOutcome(str, Enum):
    NONE      = "none"        # not triggered
    ATTRACTOR = "attractor"   # x* — collapsed onto invariant manifold
    NULL      = "null"        # ⊥ₛ — semantic null state


def _numerical_rank(s: Tensor, eig_eps: float) -> Tensor:
    """Numerical rank of each matrix from its singular values s (..., d): the count above eig_eps·σ_max.
    The gate's rank signal and the kick basis both use this one definition."""
    return (s > eig_eps * s.max(dim=-1, keepdim=True).values).sum(dim=-1)


@dataclass
class CollapseResult:
    """One evaluation of the gate over a batch. Each trajectory is decided on its own signals.

    triggered  some trajectory in the batch triggered
    mask       (B,) which ones did
    x_star     the triggered rows projected onto their own null(A); every other row unchanged
    metrics    the four signals, one value per sample, and `dim`
    """
    triggered: bool
    outcome: CollapseOutcome
    x_star: Tensor
    metrics: Dict[str, object]
    mask: Optional[Tensor] = None

    def summary(self) -> str:
        m = self.metrics

        def per_sample(v) -> str:
            v = torch.as_tensor(v).reshape(-1)
            cells = ", ".join(f"{float(e):.4g}" for e in v[:4])
            return f"[{cells}{', …' if v.numel() > 4 else ''}]"

        n = "" if self.mask is None else f" {int(self.mask.sum())}/{self.mask.numel()} triggered"
        return (
            f"Σ₀[{self.outcome.value}]{n} "
            f"∇L={per_sample(m['grad_norm'])} rank={per_sample(m['eff_rank'])}/{m['dim']:.0f} "
            f"aniso={per_sample(m['anisotropy'])} ∂H/∂u={per_sample(m['ctrl_sens'])}"
        )


class SemanticCollapseOperator:
    """Σ₀ — detects the underdetermined regime and collapses the state.

    The gate decides each trajectory on its own: the four signals are computed per sample, from that
    sample's state, covariance and Jacobian, and a sample triggers when its own four conditions hold.
    Nothing is averaged over the batch first. A batch-wide decision on mean signals let a collapsed
    member hide among healthy ones, and the mean of two rank-1 Jacobians has rank 2.
    """

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
    def _effective_rank(self, A: Tensor) -> Tensor:
        """Numerical rank of each sample's own Jacobian, (B,), from its singular values."""
        A = A if A.dim() == 3 else A.unsqueeze(0)
        return _numerical_rank(torch.linalg.svdvals(A), self.eig_eps).to(A.dtype)

    @torch.no_grad()
    def _anisotropy_per_sample(self, sigma: Tensor) -> Tensor:
        # spread of Σ eigenvalues, normalized — low ⇒ isotropic flatness. Unbiased std, so
        # a(Σ)·μ·√(d−1) = ‖Σ−μI‖_F, the form the lift proof uses.
        sym = 0.5 * (sigma + sigma.transpose(-1, -2))
        ev = torch.linalg.eigvalsh(sym).clamp_min(1e-12)
        if ev.shape[-1] < 2:                     # one eigenvalue has no spread; std would read NaN
            return torch.zeros_like(ev[..., 0])
        return ev.std(dim=-1) / ev.mean(dim=-1)

    @torch.no_grad()
    def _anisotropy(self, sigma: Tensor) -> float:
        """Batch mean of a(Σ), for telemetry and tests. The gate reads _anisotropy_per_sample."""
        return float(self._anisotropy_per_sample(sigma).mean().item())

    def _grad_norm(self, model, x: Tensor, u: Tensor) -> Tensor:
        """‖∇ₓL‖ for each sample, (B,)."""
        xr = x.detach().clone().requires_grad_(True)
        # .sum(), not .mean(): each sample's gradient must stay that sample's gradient. A mean
        # divides it by the batch size, which silently made ε_g depend on B.
        L = model.stage_cost(xr, u.detach()).sum()
        (g,) = torch.autograd.grad(L, xr)
        return g.norm(dim=-1).detach()

    def _ctrl_sensitivity(self, model, x: Tensor, u: Tensor) -> Tensor:
        """‖∂H/∂u‖ for each sample, (B,), with H = L + λᵀf and λ = ∇ₓL, the instantaneous adjoint.

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
        return g.norm(dim=-1).detach()

    def _signals(self, model, x: Tensor, u: Tensor, sigma: Tensor,
                 A: Tensor) -> Dict[str, Tensor]:
        """The four gate signals, one value per sample, in x's dtype. A Σ or Jacobian given once for
        the batch (leading dimension 1) is read as every sample's."""
        grad, rank, aniso, ctrl = torch.broadcast_tensors(*(
            t.to(x.dtype) for t in (self._grad_norm(model, x, u), self._effective_rank(A),
                                    self._anisotropy_per_sample(sigma),
                                    self._ctrl_sensitivity(model, x, u))))
        return {"grad_norm": grad, "eff_rank": rank, "anisotropy": aniso, "ctrl_sens": ctrl}

    def _fires(self, s: Dict[str, Tensor], dim: float) -> Tensor:
        """Each sample's own AND of the four conditions, (B,). Compared in float64, against the
        thresholds as given: a float32 comparison rounds ε_g = 0.01 to float32 first, and a signal
        equal to float32(0.01) then reads as not below it."""
        s = {k: v.double() for k, v in s.items()}
        return ((s["grad_norm"] < self.grad_eps) & (s["eff_rank"] < self.rank_frac * dim)
                & (s["anisotropy"] < self.anisotropy_eps) & (s["ctrl_sens"] < self.ctrl_eps))

    @torch.no_grad()
    def _collapse_state(self, x: Tensor, A: Tensor,
                        mask: Optional[Tensor] = None) -> tuple[Tensor, CollapseOutcome]:
        """Project each sample onto the null space of its OWN Jacobian; rows outside `mask` stay as they are.

        null(A) holds the actual fixed points of the linearised flow, so ‖Ax*‖ ≤ eig_eps·‖A‖₂·‖x*‖ for
        ANY A. That is a statement about the linear part: an affine or nonlinear drift can still move
        at x*. The null space of A_s is a different set: a rotation block has A_s=0 and keeps moving,
        so projecting there left ‖Ax*‖ large even for normal A. Uses the same relative singular-value
        cutoff as _effective_rank, so a sample whose cond_rank fires has k ≥ d/2 null directions. A row
        with none (k = 0, which the gate never passes here) goes to the semantic null ⊥ₛ, and the
        outcome reads NULL if any projected row did.

        P = V Vᵀ is idempotent and symmetric, so it is non-expansive: ‖P x‖ ≤ ‖x‖, and there is no
        boundary to enforce. (The former "log-barrier" multiplicative shrink was misnamed and, for
        strengths above 1/ln(100) ≈ 0.217, flipped sign and grew ‖x*‖. See issue #661.)
        """
        A = A if A.dim() == 3 else A.unsqueeze(0)
        _, s, Vh = torch.linalg.svd(A)
        null = (s <= self.eig_eps * s.max(dim=-1, keepdim=True).values).to(A.dtype)   # (B, d)
        P = Vh.transpose(-1, -2) @ (null.unsqueeze(-1) * Vh)    # (B, d, d) projector onto each null(A)
        x_star = (x.unsqueeze(-2) @ P.transpose(-1, -2)).squeeze(-2)
        rows = torch.ones(x_star.shape[:-1], dtype=torch.bool, device=x.device) if mask is None else mask
        if mask is not None:
            x_star = torch.where(mask.unsqueeze(-1), x_star, x)
        empty = torch.broadcast_to(null.sum(-1) == 0, rows.shape) & rows
        return x_star, CollapseOutcome.NULL if bool(empty.any()) else CollapseOutcome.ATTRACTOR

    def evaluate(self, model, x: Tensor, u: Tensor, sigma: Tensor,
                 A: Tensor) -> CollapseResult:
        """Decide each sample on its own signals, and collapse only the samples that triggered."""
        dim = float(x.shape[-1])
        signals = self._signals(model, x, u, sigma, A)
        mask = self._fires(signals, dim)
        metrics = {**signals, "dim": dim}
        if not bool(mask.any()):
            return CollapseResult(False, CollapseOutcome.NONE, x, metrics, mask)
        x_star, outcome = self._collapse_state(x, A, mask)
        return CollapseResult(True, outcome, x_star, metrics, mask)


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
                                        # | unresolved (frozen, to a rounding as wide as the band)

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


def _worst_collapse(certs: Sequence[CollapseCertificate]) -> CollapseCertificate:
    """A batch is guaranteed only if every member is. Gates are ANDed and numbers report the worst
    member, so no field of the result speaks for one lucky member."""
    return replace(
        min(certs, key=lambda c: (c.guaranteed, c.contraction_rate)),
        alpha=_worst_value(certs, "alpha"),
        spectral_abscissa=_worst_value(certs, "spectral_abscissa"),
        full_contracting=all(c.full_contracting for c in certs),
        numerical_range_abscissa=_worst_value(certs, "numerical_range_abscissa"),
        gate_numerical_range=all(c.gate_numerical_range for c in certs),
        gate_lyapunov=all(c.gate_lyapunov for c in certs),
        lyapunov_transient_bound=_worst_value(certs, "lyapunov_transient_bound"),
        cross_term=_worst_value(certs, "cross_term"),
    )


def _null_block_kind(A_N: Tensor, tol: float, abs_err: float) -> str:
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
    return _boundary_kind(M, w, np.abs(w.real) <= tol, 0.0, 1e-9, abs_err)


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
        return _worst_collapse([collapse_certificate(m, eig_eps, margin) for m in members])
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
    # Both thresholds sit just above rounding, measured on frozen and normal matrices up to d=512:
    # the cross-term reaches 9·eps·‖A‖ and null-block eigenvalues 1.4·eps·‖A‖. A fixed relative
    # tolerance read a real +0.009 growth or a rotation at ω=2 as rounding next to one large mode.
    scale = max(1.0, torch.linalg.norm(Abar, ord=2).item())
    eps = torch.finfo(Abar.dtype).eps
    cross = (torch.linalg.norm(Vm.T @ Abar @ Vn, ord=2).item()
             if active_dim and null_dim else 0.0)
    kind_tol = max(1e-9, 4.0 * eps * scale)
    null_kind = _null_block_kind(Vn.T @ Abar @ Vn, kind_tol, eps * scale)
    # "Frozen" means within rounding of zero. When rounding is as wide as the null band itself, that
    # says nothing: growth anywhere in the band reads the same (float32 beyond ‖A‖ ≈ 2·10⁴ at the
    # default eig_eps). A rotation or a Jordan block well outside the rounding is still read.
    if null_kind == "frozen" and kind_tol >= eig_eps:
        null_kind = "unresolved"

    guaranteed = (
        (active_dim == 0 or alpha_sym < -margin)
        and cross <= max(1e-9, 12.0 * eps * scale)
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
    def worst(attr: str) -> float:
        return _worst_value(gates, attr)

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

def _rounding(M, tol: float, eps: float) -> Tuple[float, float]:
    """(tol for the fates, rounding in M's entries). Eigenvalues of normal matrices moved by up to
    5·eps·‖M‖₂ in measurements up to d=512, so the fates use 16·eps·‖M‖₂ when that is larger. It
    does not cover strongly non-normal M, where rounding moves them by up to κ(V)·eps·‖M‖₂.
    `eps` is the input's: a float32 matrix has float32 error even after it is cast to float64."""
    import numpy as np
    abs_err = eps * float(np.linalg.norm(M, 2))
    return max(tol, 16.0 * abs_err), abs_err


def _boundary_kind(M, w, on_boundary, frozen_value: float, tol: float, abs_err: float) -> str:
    """Classify the eigenvalues sitting on the stability boundary of M. Pass the slow block, with
    `abs_err` the rounding in the entries of the matrix it came from: a large active mode makes the
    slow block's entries less certain, but must not set how large a gap counts as "the same".

    "frozen"    every boundary mode is semisimple at `frozen_value` (λ=0 for a flow, λ=1 for a
                map): the state stops on a manifold of true fixed points.
    "rotating"  some semisimple boundary mode moves (±iω, or |λ|=1 with λ≠1, including the
                period-2 λ=−1): bounded forever and never frozen. A real third fate.
    "defective" a boundary eigenvalue has a Jordan block: polynomial growth, unbounded.
    """
    import numpy as np
    n = M.shape[0]
    size = float(np.linalg.norm(M, 2))
    # Two tolerances. A computed eigenvalue is exact for a matrix abs_err away, so a singular value,
    # or a distance from the boundary point, within `zero` cannot be told apart from zero. Clusters
    # merge more generously: rounding splits a Jordan block of coupling c by about √(c·abs_err), and
    # a false merge can only report "defective", which is the conservative side. One tolerance for
    # both read a float32 Jordan block with coupling 10⁻³ as frozen.
    zero = max(max(10.0 * tol, 1e-6) * max(1.0, size), 10.0 * abs_err)
    merge = max(zero, 4.0 * math.sqrt(abs_err * size))
    kind = "frozen"
    seen: List[complex] = []
    for lam in w[on_boundary]:
        if any(abs(lam - s) <= merge for s in seen):
            continue
        seen.append(lam)
        algebraic = int(np.sum(np.abs(w - lam) <= merge))
        singular = np.linalg.svd(M - lam * np.eye(n), compute_uv=False)
        geometric = int(np.sum(singular <= zero))
        if geometric < algebraic:
            return "defective"
        if abs(lam - frozen_value) > zero:
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


def _worst_fate(certs, extreme_of, **worse):
    """A batch collapses only if every member does: the fate is the worst member's, and each bound
    the worst of any member's, so a bound holds for the whole batch and not just for that member.
    `worse` names the extra fields and which way is worse for each."""
    rank = {"COLLAPSE": 0, "MARGINAL": 1, "DIVERGE": 2}
    bounds = {attr: _worst_value(certs, attr)
              for attr in ("transient_bound", "coupling_norm", "full_transient_bound",
                           "invariance_residual")}
    bounds.update({attr: _worst_value(certs, attr, pick) for attr, pick in worse.items()})
    return replace(max(certs, key=lambda c: (rank[c.fate], not c.collapses, extreme_of(c))), **bounds)


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
    also have limit cycles and chaos. Grounding remains the safety mechanism. Rates and couplings
    below `tol` read as zero, which is a limit of resolution, not a finding that they are.
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
                           lambda c: c.slow_abscissa, active_decay_rate=min)
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
    M = members[0].detach().cpu().numpy().astype(float)
    n = M.shape[0]
    base_tol = tol
    tol, abs_err = _rounding(M, tol, torch.finfo(members[0].dtype).eps)

    # eigenvalues (values only) for the split counts + abscissae; the SUBSPACE comes
    # from an ordered Schur factorization below, never from these eigenvectors.
    # The cut sits tol inside the boundary. Rounding scatters a boundary eigenvalue to either side
    # of it, and a rotation at −1e-17 ± 2i counted as active would leave the slow block empty and
    # read as COLLAPSE. It stays slow, where its structure gets looked at.
    w = np.linalg.eigvals(M)
    cut = -delta - tol
    active_mask = w.real < cut
    n_active = int(active_mask.sum())
    n_slow = n - n_active
    active_abscissa = float(w.real[active_mask].max()) if n_active else float("-inf")
    slow_abscissa = float(w.real[~active_mask].max()) if n_slow else float("-inf")

    # invariant-subspace split via ORDERED REAL SCHUR (orthonormal Z; #1989): the
    # leading sdim columns span the active invariant subspace EXACTLY (block-triangular
    # T ⇒ (I−BBᵀ)MB = 0 to machine eps), with NO eigenvector inverse — robust even for
    # DEFECTIVE A, where the old eig + oblique-Riesz split was ill-conditioned / abstained.
    T, Z, r = None, None, 0
    try:
        T, Z, sdim = schur(M, output="real", sort=lambda z: z.real < cut)
        r = int(sdim)
    except (np.linalg.LinAlgError, ValueError):
        pass

    # fate — decided by the slow block's abscissa β, and on the boundary by its structure
    marginal_kind = "none"
    if slow_abscissa > tol:
        fate, collapses = "DIVERGE", False
    elif slow_abscissa < -tol:
        fate, collapses = "COLLAPSE", True
    else:
        S = T[r:, r:] if T is not None and r < n else M
        ws = np.linalg.eigvals(S)
        marginal_kind = _boundary_kind(S, ws, np.abs(ws.real) <= tol, 0.0, base_tol, abs_err)
        fate, collapses = _settle_boundary(marginal_kind)

    invariance_residual = 0.0
    rate, transient = 0.0, float("nan")
    coupling, full = float("nan"), float("nan")
    try:
        if T is None:
            raise ValueError("no Schur split")
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
    the Schur reordering stays well-conditioned. Requires scipy, and refuses rather than
    report an uncomputed rate. Never raises on degeneracy.
    """
    import numpy as np
    members = _batch_members(A)
    if len(members) > 1:
        return _worst_fate([discrete_dichotomy_certificate(m, delta, tol) for m in members],
                           lambda c: c.slow_radius, active_decay_factor=max, kreiss_bound=max)
    # Same reasoning as the continuous certificate above: a missing dependency must not
    # be reported as "rate_factor = 0.0", which reads as a computed result.
    try:
        from scipy.linalg import schur, solve_discrete_lyapunov
    except ImportError as exc:
        raise RuntimeError(
            "discrete_dichotomy_certificate requires scipy (scipy.linalg.schur + "
            "solve_discrete_lyapunov). Refusing to return an uncomputed certificate."
        ) from exc
    M = members[0].detach().cpu().numpy().astype(float)
    n = M.shape[0]
    radius = 1.0 - float(delta)
    base_tol = tol
    tol, abs_err = _rounding(M, tol, torch.finfo(members[0].dtype).eps)

    # eigen-moduli: split counts + slow-block radius (values only; the SUBSPACE comes
    # from Schur below, never from these eigenvectors). The cut sits tol inside the circle, for
    # the same reason as the continuous certificate: an orthogonal map's eigenvalues land on both
    # sides of |z|=1 by rounding, and they must stay slow.
    w = np.linalg.eigvals(M)
    moduli = np.abs(w)
    cut = radius - tol
    active_mask = moduli < cut
    n_active = int(active_mask.sum())
    n_slow = n - n_active
    active_radius = float(moduli[active_mask].max()) if n_active else 0.0
    slow_radius = float(moduli[~active_mask].max()) if n_slow else 0.0

    # ordered real Schur: active (|λ|<cut) eigenvalues to the top-left block.
    # Z orthonormal ⇒ leading sdim columns span the active invariant subspace
    # EXACTLY (block-triangular T ⇒ (I−BBᵀ)MB=0 to machine eps) — defective-safe.
    # The callback takes two arguments because real Schur passes (Re λ, Im λ). Given one it sees
    # only Re λ, which sorted every rotation and unstable complex pair into the active block.
    T, Z, r = None, None, 0
    try:
        T, Z, sdim = schur(M, output="real", sort=lambda re, im: abs(complex(re, im)) < cut)
        r = int(sdim)
    except (np.linalg.LinAlgError, ValueError):
        pass

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
        S = T[r:, r:] if T is not None and r < n else M
        ws = np.linalg.eigvals(S)
        marginal_kind = _boundary_kind(S, ws, np.abs(np.abs(ws) - 1.0) <= tol, 1.0, base_tol, abs_err)
        fate, collapses = _settle_boundary(marginal_kind)

    invariance_residual = float("nan")
    rate_factor, transient, kreiss = 0.0, float("nan"), float("nan")
    coupling, full = float("nan"), float("nan")
    try:
        if T is None:
            raise ValueError("no Schur split")
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
        regime, stable = "critical", False   # ρ on the boundary is not contraction, whichever side
                                             # rounding put it: 13 of 200 random orthogonal maps read
                                             # just under 1 and would have been accepted.
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


def _contraction_from_residuals(residuals: Sequence[float],
                                floor: float) -> Tuple[float, float, float]:
    """(ratio, net, rise) from one token's residual norms ‖e₀‖…‖eₙ‖. See depth_contraction_stats."""
    if not all(math.isfinite(x) for x in residuals):
        return math.inf, math.inf, math.inf
    e = [max(x, floor) for x in residuals]
    rise = max(e[j] / min(e[:j + 1]) for j in range(len(e)))
    if e[-1] <= floor:
        return 0.0, 0.0, rise
    # The larger of each two consecutive residuals. A period-2 map alternates high and low, and a
    # window over the raw sequence can start on one phase and end on the other; the envelope of a
    # growing period-2 sequence never decreases. With two residuals there is no pair to take.
    p = [max(e[k], e[k + 1]) for k in range(len(e) - 1)] if len(e) > 2 else e
    n = len(p) - 1
    net = (p[-1] / p[0]) ** (1.0 / n)
    half = math.ceil(n / 2)
    deep = (p[-1] / p[-1 - half]) ** (1.0 / half)
    return max(net, deep), net, rise


def depth_contraction_stats(hidden_per_step: Sequence[Tensor],
                            tol: float = 1e-6) -> Optional[Tuple[float, float, float]]:
    """One token's contraction, measured on the loop's own iterates h¹…hᴷ.

    With residuals eₖ = hᵏ⁺¹ − hᵏ we have eₖ₊₁ = f(hᵏ⁺¹) − f(hᵏ) ≈ J·eₖ, so ‖eₖ₊₁‖/‖eₖ‖ is a
    finite-difference Jacobian-vector norm of the recurrent map along its own residual. It needs
    no extra forward passes, does not depend on the scale of h, and is a norm rather than an
    eigenvalue, so it sees non-normal growth.

    Returns (ratio, net, rise), or None with fewer than three iterates. With pₖ = max(‖eₖ‖, ‖eₖ₊₁‖):
      ratio  the larger of net and the same geometric mean over the deepest half of the loop, so
             the whole loop and its end must both be shrinking. A last-step ratio accepted a
             period-2 map with ρ>1 whenever the loop stopped on its low step, and so did a window
             over the raw residuals that started and ended on different phases. From four iterates
             on, the envelope p closes that. With three, one ratio still decides.
      net    (pₙ₋₁/p₀)^(1/(n−1)), the geometric-mean factor per step over the whole loop
      rise   max_j ‖eⱼ‖ / min_{i≤j} ‖eᵢ‖, the largest climb above any earlier residual
    Residuals are clamped at the numerical floor (tol·‖h‖, or 4 machine epsilons·‖h‖ if larger:
    float16 is what the serve path runs). Growth that rises above the floor is seen; growth that
    stays under it is not. A token whose last residual is at the floor has reached a numerical
    fixed point and reads (0.0, 0.0, rise).
    A non-finite iterate reads (inf, inf, inf): a loop that overflowed did not converge.
    """
    hs = list(hidden_per_step)
    if len(hs) < 3:
        return None
    noise = 4.0 * torch.finfo(hs[0].dtype).eps
    # Norms in float64: float16 can hold a state whose norm it cannot represent (above 65504).
    hs = [h.detach().double() for h in hs]
    floor = max(tol, noise) * (max(float(h.norm()) for h in hs) or 1.0)
    return _contraction_from_residuals(
        [float((hs[k + 1] - hs[k]).norm()) for k in range(len(hs) - 1)], floor)


@dataclass
class LoopContractionCertificate:
    """Did the recurrent loop contract on this generation? Measured, not proven: it covers the
    residuals the loop actually produced, not every direction, and it is not a statement about
    truth. Takes the 90th percentile across tokens, so one odd token does not decide, unless it
    went non-finite, which rejects the generation. `transient_max` and the plateau band are design
    defaults, not calibrated on a real model."""
    factor: float           # 90th percentile of per-token ratio (depth_contraction_stats)
    worst_factor: float     # max over tokens
    net_factor: float       # 90th percentile of per-token net shrink per step over the whole loop
    transient: float        # 90th percentile of per-token rise: climb above an earlier residual
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
    table = np.array(usable, dtype=float)
    if not np.isfinite(table).all():
        return LoopContractionCertificate(
            factor=math.inf, worst_factor=math.inf, net_factor=math.inf, transient=math.inf,
            n_tokens=len(usable), margin=float(margin), transient_max=float(transient_max),
            stable=False, regime="divergent")
    ratios, nets, rises = table[:, 0], table[:, 1], table[:, 2]
    factor = float(np.quantile(ratios, quantile))
    net_factor = float(np.quantile(nets, quantile))
    transient = float(np.quantile(rises, quantile))
    if factor >= 1.0:
        # Stopped shrinking. A residual that is flat, or nearly so, has settled on a non-zero
        # plateau: bounded, moving, and neither frozen nor diverging. Saved Ouro runs do this past
        # their trained depth, falling from ~30 to ~3 and staying there. Anything steeper is growth.
        growing = factor >= 1.25 or net_factor > 1.05 or transient > transient_max
        regime = "divergent" if growing else "plateau"
    elif transient > transient_max:
        regime = "transient"
    elif factor >= 1.0 - margin:
        regime = "critical"
    else:
        regime = "contraction"
    return LoopContractionCertificate(
        factor=factor,
        worst_factor=float(ratios.max()),
        net_factor=net_factor,
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

        dx = f dt + dW + Σ₀⁻¹,   Σ₀⁻¹ = κ · P ξ,   P = V_null V_nullᵀ

    Everything is per trajectory. `p ∈ [0,1]` is each sample's collapse proximity: 0 when far from
    the boundary (no-op), rising to 1 as its ∇L, Jacobian rank, Σ anisotropy and control sensitivity
    all approach their collapse thresholds. V_null is that sample's own kick basis: the right
    singular vectors of its Jacobian for its smallest singular values, so when the gate fires the
    kick and the bump lie on (near-)fixed points of the linearised flow, ‖A·P‖₂ ≤ eig_eps·max(1, ‖A‖₂)
    at the default thresholds (any rank_frac ≤ 1), and not in a direction that the drift moves (see
    _kick_basis).

    What is proven about the two legs (docs/SIGMA0-COLLAPSE-CERTIFICATE.md §3), for each sample
    the operator acts on:
      • covariance leg (C3): after the engine's own projection, a(Σ_next) ≥ ε_a, so that sample's
        gate cannot be true on consecutive evaluations.
      • state leg (S1): each firing leaves the ball {‖∇ₓL‖ < ε_g} with probability ≥ ½, for any
        drift and any p.
    Both hold for any rank-m projector, so neither depends on which subspace is chosen.
    Neither promises perpetual motion. A system with no drift, no noise and no grounding rests
    at an equilibrium once the gate has cleared.
    """

    # Target a(Σ⁺) ≥ 1.02·ε_a, so that a(Σ_next) ≥ ε_a survives raising near-zero eigenvalues to
    # the covariance floor. With ρ = d·eps/sigma_max, a(Σ_next) ≥ (a(Σ⁺) − ½√(d/(d−1))·ρ)/(1+ρ), which
    # holds it whenever ρ ≤ 9e-4, for every d ≥ 2 (d up to 9000 at the defaults).
    LIFT_MARGIN = 1.02

    def __init__(self, detector: Optional[SemanticCollapseOperator] = None,
                 strength: float = 0.5, eig_eps: float = 1e-2) -> None:
        self.detector = detector or SemanticCollapseOperator()
        self.strength = strength
        self.eig_eps = eig_eps

    def proximity(self, model, x: Tensor, u: Tensor, sigma: Tensor,
                  A: Tensor) -> Tensor:
        """How close each sample is to a collapse, (B,): 0 = safe, 1 = collapsing.

        A sample's value is above 0 exactly when its own four-signal gate is true, so the engine
        excites exactly the samples that the gate would freeze."""
        d = self.detector
        dim = float(x.shape[-1])
        s = d._signals(model, x, u, sigma, A)
        # each term → 1 as it sinks below its trigger threshold; all must be near to act
        p = torch.stack([_below(s["grad_norm"], d.grad_eps),
                         _below(s["eff_rank"], d.rank_frac * dim),
                         _below(s["anisotropy"], d.anisotropy_eps),
                         _below(s["ctrl_sens"], d.ctrl_eps)]).amin(dim=0)
        # 1 − v/t rounds to 0 for v within an ulp of t, so tie p > 0 to the gate itself.
        return torch.where(d._fires(s, dim), p.clamp_min(torch.finfo(p.dtype).tiny),
                           torch.zeros_like(p))

    @torch.no_grad()
    def _kick_basis(self, A: Tensor) -> Tuple[Tensor, Tensor]:
        """(V, m) for each sample's own Jacobian: V (B, d, d) holds its right singular vectors in order
        of increasing singular value, and its kick basis is the first m (B,) columns.

            m = clamp(max(#{σᵢ < eig_eps}, d − rank(A)), 1, _max_lift_rank(d))

        with rank(A) the gate's own numerical rank. The right singular vectors for the small singular
        values span (near-)null(A): every one of the m counted singular values is at most
        max(eig_eps, detector.eig_eps·‖A‖₂), and so is ‖A·V_m‖₂, whenever the gate fires and
        rank_frac ≤ 1 (the default is ½). Only a numerically full-rank A takes the m = 1 floor above
        both, and with rank_frac ≤ 1 such an A never passes cond_rank. They
        come from an SVD of A itself: an eigendecomposition of AᵀA would square the condition number,
        and the eigenvectors of A_s are a different subspace once A is non-normal (under A = e₁e₂ᵀ one
        of the three smallest-|λ(A_s)| directions has ‖Av‖ = 1/√2).

        The count and the clamps carry over from the banded near-null fix (Fix B,
        SIGMA0-C3-NONCOLLAPSE-NORMAL.md §2.2 in lantern-os-research):
          • G13 — modes parked just above eig_eps no longer yield a rank-0 (blank)
            bump: the rank deficit `d − rank` guarantees `m ≥ 1` whenever `cond_rank` fires.
          • k=d clamp — `m ≤ d−1` always leaves ≥1 mode unbumped, so the covariance
            bump creates genuine anisotropy. Bumping ALL d modes is `Σ + b·I`, a
            uniform shift that LOWERS anisotropy (std unchanged, mean up) — the
            opposite of the intent, and L2's denominator √(k(d−k)) − ε·k is negative
            at k=d. Full degeneracy is handled as a k=d−1 bump.
          • feasibility — above d≈100 the rank must also stay below _max_lift_rank(d), because
            a rank-m bump tops out at a(Σ⁺) ≈ √((d−m)/m) and d−1 modes cannot reach ε_a at all
            once d > 401. L2′ allows any projector, so bumping fewer modes loses nothing.
        """
        A = A if A.dim() == 3 else A.unsqueeze(0)
        d = A.shape[-1]
        _, s, Vh = torch.linalg.svd(A)                     # s in decreasing order
        V = Vh.flip(-2).transpose(-1, -2)                  # columns by increasing singular value
        hard_null = (s < self.eig_eps).sum(dim=-1)
        rank_deficit = d - _numerical_rank(s, self.detector.eig_eps)
        m = torch.maximum(hard_null, rank_deficit).clamp(1, self._max_lift_rank(d))
        return V, m                                        # proper AND feasible subspace

    @torch.no_grad()
    def _near_null_basis(self, A: Tensor) -> Tensor:
        """The kick basis of ONE Jacobian (2-D, or a batch of one), (d, m). See _kick_basis."""
        if A.dim() == 3 and A.shape[0] != 1:
            raise ValueError("a batch has one kick basis per sample: use _kick_projector")
        V, m = self._kick_basis(A)
        return V[0, :, :int(m[0])]

    @torch.no_grad()
    def _kick_projector(self, A: Tensor) -> Tuple[Tensor, Tensor]:
        """(P, m): each sample's orthogonal projector (B, d, d) onto its own kick basis, and its rank (B,)."""
        V, m = self._kick_basis(A)
        keep = (torch.arange(V.shape[-1], device=V.device) < m.unsqueeze(-1)).to(V.dtype)
        return (V * keep.unsqueeze(-2)) @ V.transpose(-1, -2), m

    def _max_lift_rank(self, d: int) -> int:
        """Largest m with ε·m ≤ ½√(m(d−m)), i.e. m ≤ d/(1+4ε²), clamped to [1, d−1]. Keeping the
        L2′ denominator at least half its numerator bounds Δ by about (1+a/ε)μ across the trigger
        regime (m ≥ d/2) in EVERY dimension, rather than letting it blow up as m→d−1 and then
        become impossible."""
        eps = self.detector.anisotropy_eps * self.LIFT_MARGIN
        return max(1, min(d - 1, int(d / (1.0 + 4.0 * eps * eps))))

    @torch.no_grad()
    def _cov_floor(self, sigma: Tensor, d: int, m) -> Tensor:
        """L2′'s per-step bump threshold Δ(a, μ, d, m), for each sample: the μ-aware floor.

            Δ = (ε + a)·μ·d / (√(m(d−m)) − ε·m),   a = a(Σ), μ = mean λ(Σ), ε = LIFT_MARGIN·ε_a

        Holds for any rank-m orthogonal projector (reverse triangle inequality in Frobenius norm;
        no alignment and no normality). Each sample gets its own: one batch-wide μ leaves a
        high-scale sample flat. `m` is one rank for the batch or one per sample. `a` is not clipped
        at ε_a: `excite` reads the Riccati-propagated Σ, which can already be anisotropic, and a
        clipped floor lets a bump flatten it.
        Raises on an infeasible rank, where no finite bump can reach ε (excite never asks for one).
        """
        eps = self.detector.anisotropy_eps * self.LIFT_MARGIN
        m = torch.as_tensor(m, dtype=sigma.dtype, device=sigma.device)
        denom = (m * (d - m)).sqrt() - eps * m
        if bool((denom <= 0).any()):
            raise ValueError(f"no finite bump of rank {m.long().tolist()} lifts a(Σ) to {eps:g} "
                             f"in dimension {d}")
        sym = 0.5 * (sigma + sigma.transpose(-1, -2))
        ev = torch.linalg.eigvalsh(sym).clamp_min(1e-12)
        mu = ev.mean(dim=-1)
        a = ev.std(dim=-1) / mu
        return (eps + a) * mu * d / denom

    def _kick_scale(self, p):
        """State-kick magnitude κ, one per sample when p is. Lemma S1: for x⁺ = c + (D + κP)ξ with
        D ⪰ 0 and any c, P(‖x⁺‖ ≥ r) ≥ P(χ_m ≥ r/κ), by Anderson's inequality and Weyl's. With
        r = ε_g/2 (where ‖∇ₓL‖ = 2‖x−x_target‖ crosses ε_g) this floor makes that at least ½. Without
        it the kick was strength·p, which vanishes at the gate boundary exactly where it is needed.
        strength=0 still disables the state leg."""
        if self.strength <= 0.0:
            return torch.zeros_like(p) if isinstance(p, Tensor) else 0.0
        floor = self.detector.grad_eps / (2.0 * _MEDIAN_CHI_1)
        if isinstance(p, Tensor):
            return (self.strength * p).clamp_min(floor)
        return max(self.strength * p, floor)

    @torch.no_grad()
    def excite(self, x: Tensor, sigma: Tensor, A: Tensor, p,
               noise: Tensor) -> tuple[Tensor, Tensor]:
        """Return (dx_extra, sigma_extra), each sample's along its own kick subspace (_kick_basis).

        Every row passed is excited: the engine passes only the rows whose gate fired. `p` is one
        proximity for all of them, or one per row. Two decoupled legs:
          • covariance leg — the bump `b_cov · P` that breaks `cond_flat`, floored per sample to
            L2′'s threshold Δ at that sample's own rank m, so one bump provably lifts anisotropy
            above ε_a (Theorem C3). The engine must apply it with
            CovarianceField.project_preserving_shape, or the σ_max cap can erase it.
          • state-kick leg — the random `dx_extra = κ·Pξ`, floored by _kick_scale (Lemma S1), so the
            state itself leaves the gradient ball with probability ≥ ½ however small p is. This is
            the only leg that moves x.
        """
        P, m = self._kick_projector(A)                    # (B, d, d), feasible 1 ≤ m ≤ d−1 each
        d = P.shape[-1]
        kappa = self._kick_scale(p)
        if isinstance(kappa, Tensor):
            kappa = kappa.unsqueeze(-1)
        dx_extra = kappa * (noise.unsqueeze(-2) @ P).squeeze(-2)   # κ·Pξ, P symmetric
        if d < 2:                       # one eigenvalue has no shape to restore: C3 needs d ≥ 2, S1 does not
            return dx_extra, torch.zeros_like(sigma)

        b_cov = self._cov_floor(sigma, d, m)
        b_cov = torch.maximum(b_cov, torch.as_tensor(self.strength * p, dtype=b_cov.dtype,
                                                     device=b_cov.device))   # each sample ≥ its Δ
        sigma_extra = b_cov.unsqueeze(-1).unsqueeze(-1) * P    # (B, d, d), rank m per sample
        return dx_extra, sigma_extra


def _below(value: Tensor, threshold: float) -> Tensor:
    """Soft indicator, elementwise → 1 when value ≪ threshold, 0 when value ≥ threshold."""
    if threshold <= 0:
        return torch.zeros_like(value)
    return (1.0 - value / threshold).clamp(0.0, 1.0)


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
