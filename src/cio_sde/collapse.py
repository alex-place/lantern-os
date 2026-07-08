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

from dataclasses import dataclass
from enum import Enum
from typing import Dict, Optional

import torch

Tensor = torch.Tensor


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
    def _anisotropy(self, sigma: Tensor) -> float:
        # spread of Σ eigenvalues, normalized — low ⇒ isotropic flatness
        sym = 0.5 * (sigma + sigma.transpose(-1, -2))
        ev = torch.linalg.eigvalsh(sym).clamp_min(1e-12)
        return float((ev.std(dim=-1) / ev.mean(dim=-1)).mean().item())

    def _grad_norm(self, model, x: Tensor, u: Tensor) -> float:
        xr = x.detach().clone().requires_grad_(True)
        L = model.stage_cost(xr, u.detach()).mean()
        (g,) = torch.autograd.grad(L, xr)
        return float(g.norm(dim=-1).mean().item())

    def _ctrl_sensitivity(self, model, x: Tensor, u: Tensor) -> float:
        ur = u.detach().clone().requires_grad_(True)
        H = model.stage_cost(x.detach(), ur).mean()
        (g,) = torch.autograd.grad(H, ur)
        return float(g.norm(dim=-1).mean().item())

    @torch.no_grad()
    def _collapse_state(self, x: Tensor, A: Tensor) -> tuple[Tensor, CollapseOutcome]:
        # project onto null eigenmodes of the (symmetrized) mean Jacobian
        Abar = 0.5 * (A.mean(0) + A.mean(0).T)
        evals, evecs = torch.linalg.eigh(Abar)
        null_mask = evals.abs() < self.eig_eps
        k = int(null_mask.sum().item())
        if k == 0:
            # no invariant directions at all → semantic null ⊥ₛ
            return torch.zeros_like(x), CollapseOutcome.NULL
        V = evecs[:, null_mask]                 # (d, k) null subspace basis
        P = V @ V.T                             # projector onto invariant manifold

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

    If the spectral abscissa of A_s restricted to M is
            α = max{ λᵢ(A_s) : vᵢ ∈ M }  <  0,
    then  V̇ ≤ 2α V,  so  ‖P_M x(t)‖ ≤ ‖P_M x(0)‖ · e^{α t}:
    the active modes decay exponentially at rate |α| and the trajectory
    contracts onto the invariant null manifold N. Σ₀ collapse is GUARANTEED.

    If α ≥ 0 some active mode is non-contracting → collapse not guaranteed
    (the system may wander or diverge instead).
    """
    guaranteed: bool
    alpha: float            # small-gain bound: max λ(A_s) + ‖A−A_s‖₂ (conservative)
    contraction_rate: float # |α| when guaranteed, else 0
    null_dim: int           # dimension of the invariant manifold
    active_dim: int
    # Authoritative full-spectrum test (§1.2): the EXACT spectral abscissa of the
    # full (possibly non-normal) Jacobian. max Re λ(A) < 0 is necessary for strict
    # contraction; it is tighter than the conservative small-gain `alpha` bound.
    spectral_abscissa: float = float("nan")  # max Re λ(A) on the full A (via eig)
    full_contracting: bool = False           # spectral_abscissa < −margin
    # #768 Tier-A provable region-wideners (see stability_gates()). Sufficient
    # contraction certificates that strictly EXTEND the conservative small-gain `alpha`.
    numerical_range_abscissa: float = float("nan")  # ω(A)=λ_max(A_s); rightmost pt of W(A)
    gate_numerical_range: bool = False  # ω(A) < −margin → monotone Euclidean contraction
    gate_lyapunov: bool = False         # ∃P≻0 ⟺ max Re λ(A) < −margin (accepts non-normal)
    lyapunov_transient_bound: float = float("nan")  # √cond(P): bound on sup_t‖e^{tA}‖

    def summary(self) -> str:
        verdict = "GUARANTEED" if self.guaranteed else "NOT guaranteed"
        return (
            f"collapse {verdict}: α={self.alpha:+.4f} (small-gain) "
            f"maxReλ(A)={self.spectral_abscissa:+.4f} "
            f"({'contracting' if self.full_contracting else 'non-contracting'}) "
            f"rate={self.contraction_rate:.4f} "
            f"null_dim={self.null_dim} active_dim={self.active_dim}"
        )

    @property
    def proven_contracting(self) -> bool:
        """#768: certified contracting by EITHER provable gate — a strictly wider
        proven region than the conservative small-gain `guaranteed`/`alpha`."""
        return self.gate_numerical_range or self.gate_lyapunov


@torch.no_grad()
def collapse_certificate(A: Tensor, eig_eps: float = 1e-2,
                         margin: float = 0.0) -> CollapseCertificate:
    """Evaluate the collapse-guarantee theorem for a (batched) Jacobian A.

    For non-normal A, uses the small-gain theorem bound:
        α ≤ max_i Re(λ_i) + ‖A - A_s‖_2
    where A_s is the symmetric part. This provides a conservative bound
    that accounts for cross-terms in the non-normal case.

    Model-collapse grounding (Dohmatob et al., "A Tale of Tails", arXiv:2402.07043,
    ICML 2024): synthetic data changes the scaling law and truncates gains; a
    contraction margin keeps spectral distance from the collapse boundary
    (α < -margin). The matrix-measure bound is classical contraction analysis
    (Lohmiller & Slotine 1998, Automatica 34(6):683-696).
    """
    Abar = A.mean(0) if A.dim() == 3 else A
    A_s = 0.5 * (Abar + Abar.T)
    evals = torch.linalg.eigvalsh(A_s)

    # Authoritative full-spectrum abscissa (§1.2): exact max Re λ(A) on the FULL,
    # possibly non-normal, Jacobian via `eigvals` (complex). This is the tight
    # necessary condition for strict contraction; the small-gain `alpha` below is
    # a conservative upper bound that can over-reject genuinely-contracting non-
    # normal systems.
    spectral_abscissa = float(torch.linalg.eigvals(Abar).real.max().item())
    full_contracting = spectral_abscissa < -margin

    # #768 Tier-A provable gates (widen the proven region vs the small-gain `alpha`).
    g = stability_gates(Abar, margin=margin)

    null_mask = evals.abs() < eig_eps
    active = evals[~null_mask]
    null_dim = int(null_mask.sum().item())
    if active.numel() == 0:
        # entirely null — already on the manifold, trivially collapsed
        return CollapseCertificate(True, float("-inf"), float("inf"),
                                   null_dim, 0,
                                   spectral_abscissa=spectral_abscissa,
                                   full_contracting=full_contracting,
                                   numerical_range_abscissa=g.numerical_range_abscissa,
                                   gate_numerical_range=g.gate_numerical_range,
                                   gate_lyapunov=g.gate_lyapunov,
                                   lyapunov_transient_bound=g.lyapunov_transient_bound)

    # Small-gain bound for non-normal case
    alpha_sym = float(active.max().item())
    cross_term_norm = torch.linalg.norm(Abar - A_s, ord=2).item()
    alpha = alpha_sym + cross_term_norm  # conservative bound

    guaranteed = alpha < -margin
    return CollapseCertificate(
        guaranteed=guaranteed,
        alpha=alpha,
        contraction_rate=(-alpha if guaranteed else 0.0),
        null_dim=null_dim,
        active_dim=int(active.numel()),
        spectral_abscissa=spectral_abscissa,
        full_contracting=full_contracting,
        numerical_range_abscissa=g.numerical_range_abscissa,
        gate_numerical_range=g.gate_numerical_range,
        gate_lyapunov=g.gate_lyapunov,
        lyapunov_transient_bound=g.lyapunov_transient_bound,
    )


@dataclass
class StabilityGates:
    """#768 Tier-A provable region-wideners for (possibly non-normal) A."""
    numerical_range_abscissa: float   # ω(A)=λ_max(A_s) — rightmost point of W(A)
    spectral_abscissa: float          # max Re λ(A)
    gate_numerical_range: bool        # ω(A) < −margin  → MONOTONE Euclidean contraction
    gate_lyapunov: bool               # ∃P≻0 ⟺ max Re λ(A) < −margin (accepts non-normal)
    lyapunov_transient_bound: float   # √cond(P): bound on sup_t‖e^{tA}‖ (nan if not Hurwitz)
    crouzeix_transient_bound: float   # 1+√2 when W(A) ⊂ LHP (ω ≤ 0), else nan
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


@torch.no_grad()
def stability_gates(A: Tensor, margin: float = 0.0, pseudo_eps: float = 1e-2) -> StabilityGates:
    """#768 Tier-A provable region-wideners for a (possibly non-normal) Jacobian A.

    Two SUFFICIENT contraction certificates, each strictly wider than the conservative
    small-gain bound (alpha_sym + ‖A−A_s‖₂) used by collapse_certificate():

    1. Numerical-range gate (monotone, Euclidean):
         ω(A) = λ_max(A_s) < −margin  ⟹  ‖e^{tA}‖₂ ≤ e^{ω t}
       a strict, no-transient contraction (matrix measure μ₂; Lohmiller–Slotine 1998,
       Automatica 34(6)). ω(A) is the rightmost point of the numerical range W(A); since
       spec(A) ⊂ W(A), this gate IMPLIES the Lyapunov gate — it is the stricter of the two.

    2. Lyapunov gate (asymptotic, optimal metric):
         ∃P≻0 : (A+margin·I)ᵀP + P(A+margin·I) ≺ 0   ⟺   max Re λ(A) < −margin
       (classical Lyapunov theorem; equivalent to inf_T μ₂(T A T⁻¹) < −margin). Certified
       by solving the Lyapunov equation and checking P≻0. Accepts strongly non-normal A
       with transient growth (e.g. [[−1,3],[−3,0]]) that small-gain over-rejects.
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
    (not collapse-onto-manifold). Crouzeix–Palencia (2017) gives the PROVEN transient
    bound ‖e^{tA}‖ ≤ (1+√2) when W(A) ⊂ LHP (ω ≤ 0); constant 2 is Crouzeix's conjecture.
    """
    import numpy as np
    Abar = A.mean(0) if A.dim() == 3 else A
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

    crouzeix = (1.0 + 2.0 ** 0.5) if omega <= 0.0 else float("nan")

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
        crouzeix_transient_bound=crouzeix,
        pseudospectral_abscissa=pseudospectral_abscissa,
        gate_pseudospectral=gate_pseudospectral,
        kreiss_bound=kreiss,
        pseudospectral_eps=pseudo_eps,
        margin=margin,
    )


# ── #768 contraction half — Theorem 1 for NON-NORMAL A (spectral dichotomy) ───

@dataclass
class DichotomyCertificate:
    """Theorem 1's collapse-onto-the-manifold guarantee, extended to NON-NORMAL A.

    Theorem 1 (CollapseCertificate) splits the state by the SYMMETRIC part A_s and
    runs an energy V=½‖P_M x‖² on the active modes. For non-normal A the cross-term
    P_M A P_N ≠ 0 breaks V̇ ≤ 2αV, and the A_s-null manifold is not even invariant —
    so that proof genuinely fails. The fix is to split by A's OWN spectrum:

      active M = {Re λ < −δ},  slow/center N = {Re λ ≥ −δ}.

    These are A-invariant, so the oblique Riesz projector commutes with A and the
    cross-term that defeats the energy proof is identically zero (measured by
    `invariance_residual`). Then:

      • (active) on M, A is Hurwitz (abscissa ≤ −δ). The reduced Lyapunov metric P
        (AᴹᵀP+PAᴹ=−I) gives ‖e^{tA}Π_M x‖ ≤ √cond(P)·e^{−t/(2λ_max(P))}‖Π_M x‖ → 0:
        the active modes ALWAYS decay, after a bounded transient √cond(P) (the
        non-normality shows up only as that finite overshoot, never as a failure to
        contract). This is the SAME Lyapunov metric as stability_gates(), on Aᴹ.
      • (fate) decided purely by β = max Re λ(N): β > 0 ⇒ DIVERGE; β < 0 ⇒ COLLAPSE
        (whole system Hurwitz); β ≈ 0 ⇒ MARGINAL — bounded collapse onto the center
        manifold (assuming the axis modes are semisimple; a defective imaginary-axis
        eigenvalue gives polynomial growth, a measure-zero boundary). No third fate:
        the active part always dies, so only sign(β) decides.

    For NORMAL A the Riesz projector IS the orthogonal A_s-projector and this reduces
    to Theorem 1 exactly — so this strictly generalizes CollapseCertificate.

    HONEST SCOPE: contraction of the LOCAL linear Jacobian onto its slow manifold —
    NOT a global non-collapse guarantee. Grounding remains the safety mechanism.
    See docs/SIGMA0-T1-NONNORMAL-DICHOTOMY.md.
    """
    fate: str                  # "COLLAPSE" | "MARGINAL" | "DIVERGE"
    collapses: bool            # active decays AND slow stays bounded (β ≤ tol)
    active_dim: int
    slow_dim: int
    active_abscissa: float     # max Re λ on M  (≤ −δ by construction; −inf if empty)
    slow_abscissa: float       # β = max Re λ on N — the quantity that decides the fate
    active_decay_rate: float   # 1/(2λ_max(P)): provable finite-t Lyapunov rate on M
    transient_bound: float     # √cond(P): bound on the active transient overshoot
    invariance_residual: float # ‖(I−BBᵀ)A B‖ — numerical quality of the split (→0)
    delta: float

    def summary(self) -> str:
        return (
            f"dichotomy[#768]: fate={self.fate} "
            f"(active maxReλ={self.active_abscissa:+.4f} on {self.active_dim} modes, "
            f"slow β={self.slow_abscissa:+.4f} on {self.slow_dim}) "
            f"decay≥{self.active_decay_rate:.4f} transient≤{self.transient_bound:.3g} "
            f"split-resid={self.invariance_residual:.2e}"
        )


@torch.no_grad()
def dichotomy_certificate(A: Tensor, delta: float = 0.0,
                          tol: float = 1e-7) -> DichotomyCertificate:
    """Evaluate the non-normal spectral-dichotomy extension of Theorem 1 on A.

    Splits A by its own spectrum at −δ (active = {Re λ < −δ}), certifies that the
    active block decays (reduced Lyapunov, bounded transient), and classifies the
    fate from the slow block's abscissa. Reuses the SAME Lyapunov metric as
    stability_gates(), applied to the active block Aᴹ.

    `delta ≥ 0` is the split threshold; use a value inside a spectral gap so the
    Schur reordering stays well-conditioned (a near-split-line eigenvalue inflates
    `invariance_residual`). Robust on DEFECTIVE A (orthonormal Schur basis, no
    eigenvector inverse; #1989). Never raises on degeneracy — returns −inf abscissae
    and inf transient for the empty/ill-posed blocks.
    """
    import numpy as np
    Abar = A.mean(0) if A.dim() == 3 else A
    M = Abar.detach().cpu().numpy().astype(float)
    n = M.shape[0]

    # eigenvalues (values only) for the split counts + abscissae; the SUBSPACE comes
    # from an ordered Schur factorization below, never from these eigenvectors
    w = np.linalg.eigvals(M)
    active_mask = w.real < -delta
    n_active = int(active_mask.sum())
    n_slow = n - n_active
    active_abscissa = float(w.real[active_mask].max()) if n_active else float("-inf")
    slow_abscissa = float(w.real[~active_mask].max()) if n_slow else float("-inf")

    # invariant-subspace split via ORDERED REAL SCHUR (orthonormal Z; #1989): the
    # leading sdim columns span the active invariant subspace EXACTLY (block-triangular
    # T ⇒ (I−BBᵀ)MB = 0 to machine eps), with NO eigenvector inverse — robust even for
    # DEFECTIVE A, where the old eig + oblique-Riesz split was ill-conditioned / abstained.
    invariance_residual = 0.0
    rate, transient = 0.0, float("nan")
    try:
        from scipy.linalg import schur, solve_continuous_lyapunov
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
    except Exception:
        pass

    # fate — decided purely by the slow block's abscissa β (no third option)
    if slow_abscissa > tol:
        fate, collapses = "DIVERGE", False
    elif slow_abscissa < -tol:
        fate, collapses = "COLLAPSE", True
    else:
        fate, collapses = "MARGINAL", True   # bounded onto center (axis modes semisimple)

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
      • (fate) decided purely by the slow spectral radius ρ_N = max|λ(N)| = ρ(A):
        ρ_N > 1 ⇒ DIVERGE; ρ_N < 1 ⇒ COLLAPSE (whole iteration Schur-stable);
        ρ_N ≈ 1 ⇒ MARGINAL — bounded onto the unit-circle center (semisimple).
        No third fate: the active part always dies, so only ρ_N decides.

    For NORMAL A this reduces to "ρ(A) < 1 ⟺ collapse" exactly. HONEST SCOPE:
    contraction of the LOCAL linear Jacobian's discrete iteration — NOT a global
    guarantee; grounding remains the safety mechanism. See #1988 and
    docs/SIGMA0-COLLAPSE-CERTIFICATE.md §6.
    """
    fate: str                    # "COLLAPSE" | "MARGINAL" | "DIVERGE"
    collapses: bool              # active decays AND slow stays bounded (ρ_N ≤ 1+tol)
    active_dim: int
    slow_dim: int
    active_radius: float         # max|λ| on M (≤ 1−δ by construction; 0 if empty)
    slow_radius: float           # ρ_N = max|λ| on N — the quantity that decides the fate
    active_decay_factor: float   # √γ = √(1−1/λ_max(P)): provable per-step contraction on M
    transient_bound: float       # √cond(P): bound on sup_k ‖Aᴹᵏ‖ (nan if not Schur-stable)
    kreiss_bound: float          # discrete Kreiss lower bound ≤ sup_k ‖Aᵏ‖
    invariance_residual: float   # ‖(I−BBᵀ)A B‖ — split quality (→0 by Schur)
    delta: float

    def summary(self) -> str:
        return (
            f"discrete-dichotomy[#1988]: fate={self.fate} "
            f"(active ρ={self.active_radius:.4f} on {self.active_dim} modes, "
            f"slow ρ_N={self.slow_radius:.4f} on {self.slow_dim}) "
            f"decay≤{self.active_decay_factor:.4f}/step transient≤{self.transient_bound:.3g} "
            f"split-resid={self.invariance_residual:.2e}"
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
    Abar = A.mean(0) if A.dim() == 3 else A
    M = Abar.detach().cpu().numpy().astype(float)
    n = M.shape[0]
    radius = 1.0 - float(delta)

    # eigen-moduli: split counts + slow-block radius (values only; the SUBSPACE comes
    # from Schur below, never from these eigenvectors)
    moduli = np.abs(np.linalg.eigvals(M))
    active_mask = moduli < radius
    n_active = int(active_mask.sum())
    n_slow = n - n_active
    active_radius = float(moduli[active_mask].max()) if n_active else 0.0
    slow_radius = float(moduli[~active_mask].max()) if n_slow else 0.0

    invariance_residual = float("nan")
    rate_factor, transient, kreiss = 0.0, float("nan"), float("nan")
    try:
        from scipy.linalg import schur, solve_discrete_lyapunov
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
    except Exception:
        pass

    # fate — decided purely by the slow block's spectral radius ρ_N = ρ(A) (no third)
    if n_slow == 0:
        fate, collapses = "COLLAPSE", True           # every mode inside the split circle
    elif slow_radius > 1.0 + tol:
        fate, collapses = "DIVERGE", False
    elif slow_radius < 1.0 - tol:
        fate, collapses = "COLLAPSE", True
    else:
        fate, collapses = "MARGINAL", True           # bounded onto the unit circle

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
    """
    import numpy as np
    Abar = A.mean(0) if A.dim() == 3 else A
    M = Abar.detach().cpu().numpy().astype(float)

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
    """

    def __init__(self, detector: Optional[SemanticCollapseOperator] = None,
                 strength: float = 0.5, eig_eps: float = 1e-2) -> None:
        self.detector = detector or SemanticCollapseOperator()
        self.strength = strength
        self.eig_eps = eig_eps

    def proximity(self, model, x: Tensor, u: Tensor, sigma: Tensor,
                  A: Tensor) -> float:
        """How close the state is to a collapse (0 = safe, 1 = collapsing)."""
        d = self.detector
        grad_norm = d._grad_norm(model, x, u)
        eff_rank = d._effective_rank(A)
        aniso = d._anisotropy(sigma)
        ctrl = d._ctrl_sensitivity(model, x, u)
        dim = float(x.shape[-1])
        # each term → 1 as it sinks below its trigger threshold
        p_grad = _below(grad_norm, d.grad_eps)
        p_rank = _below(eff_rank, d.rank_frac * dim)
        p_flat = _below(aniso, d.anisotropy_eps)
        p_ctrl = _below(ctrl, d.ctrl_eps)
        return min(p_grad, p_rank, p_flat, p_ctrl)   # all must be near to act

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
        """
        Abar = 0.5 * (A.mean(0) + A.mean(0).T) if A.dim() == 3 else 0.5 * (A + A.T)
        d = Abar.shape[-1]
        evals, evecs = torch.linalg.eigh(Abar)
        absval = evals.abs()
        hard_null = int((absval < self.eig_eps).sum().item())
        eff_rank = self.detector._effective_rank(A if A.dim() == 3 else A.unsqueeze(0))
        m = max(hard_null, d - int(round(eff_rank)))
        m = max(1, min(m, d - 1))                          # proper subspace: 1 ≤ m ≤ d−1
        idx = torch.argsort(absval)[:m]                    # m smallest |λ| modes
        return evecs[:, idx]                               # (d, m)

    @torch.no_grad()
    def _cov_floor(self, sigma: Tensor, d: int, m: int) -> float:
        """L2's exact per-step bump threshold Δ(a, μ, d, m) — the μ-aware floor (Fix A).

            Δ = (ε_a + a)·μ·d / (√(m(d−m)) − ε_a·m),   a = clip(a(Σ),0,ε_a), μ = mean λ(Σ)

        Scale-equivariant (Δ ∝ μ), so a rescaling Σ ↦ cΣ — which leaves the trigger
        invariant — cannot defeat it. Denominator > 0 since m ≤ d−1.
        """
        eps_a = self.detector.anisotropy_eps
        sym = 0.5 * (sigma + sigma.transpose(-1, -2))
        ev = torch.linalg.eigvalsh(sym).clamp_min(1e-12)
        mu = float(ev.mean().item())
        a = min(self.detector._anisotropy(sigma), eps_a)
        denom = (m * (d - m)) ** 0.5 - eps_a * m
        if denom <= 0:
            return 0.0
        return (eps_a + a) * mu * d / denom

    @torch.no_grad()
    def excite(self, x: Tensor, sigma: Tensor, A: Tensor, p: float,
               noise: Tensor) -> tuple[Tensor, Tensor]:
        """Return (dx_extra, sigma_extra) injected along the banded near-null subspace.

        Two decoupled legs (docs/SIGMA0-C3-NONCOLLAPSE-NORMAL.md §2.2):
          • covariance leg — the bump `b_cov · P_N` that breaks `cond_flat`. Its
            magnitude is FLOORED to L2's threshold Δ (μ-aware), so one bump provably
            lifts anisotropy above ε_a (Theorem C3, normal A). This is the certificate
            leg.
          • state-kick leg — the random `dx_extra` that raises ‖x‖ (and so the gradient
            signal); kept at `strength·p` exactly as before, so the measured escape
            behavior is unchanged.
        """
        null = self._near_null_basis(A)                   # (d, m), 1 ≤ m ≤ d−1
        m = null.shape[1]
        d = null.shape[0]

        # state-kick leg — unchanged (cond_grad escape)
        coeff = noise @ null                              # (B, m) random in null
        dx_extra = self.strength * p * (coeff @ null.T)   # back to state space

        # covariance leg — μ-aware floor so b_cov ≥ Δ (L2 hypothesis), breaking cond_flat
        b_cov = max(self.strength * p, self._cov_floor(sigma, d, m))
        bump = b_cov * (null @ null.T)                    # (d, d), rank m
        sigma_extra = bump.unsqueeze(0).expand_as(sigma)
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
