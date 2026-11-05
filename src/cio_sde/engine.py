"""
CIO Neural SDE engine — drift/diffusion, PCSF control, Riccati covariance,
hot-swappable graph, and a deterministic (replayable) rollout.

All tensors are batched: x is (B, d), Σ is (B, d, d).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple

import torch
import torch.nn as nn

Tensor = torch.Tensor


# ── Drift / diffusion (execution graph node) ─────────────────────────────────

class Dynamics(nn.Module):
    """
    A single execution-graph node: drift f(x, u) and diffusion g(x).

    drift     f: R^d × R^m → R^d   deterministic execution step
    diffusion g: R^d       → R^d   per-dim noise gain (exploration), kept ≥ 0
    """

    def __init__(self, dim: int, ctrl_dim: int, hidden: int = 64) -> None:
        super().__init__()
        self.dim = dim
        self.ctrl_dim = ctrl_dim
        self.drift_net = nn.Sequential(
            nn.Linear(dim + ctrl_dim, hidden), nn.SiLU(),
            nn.Linear(hidden, dim),
        )
        self.diffusion_net = nn.Sequential(
            nn.Linear(dim, hidden), nn.SiLU(),
            nn.Linear(hidden, dim),
        )

    def drift(self, x: Tensor, u: Tensor) -> Tensor:
        return self.drift_net(torch.cat([x, u], dim=-1))

    def diffusion(self, x: Tensor) -> Tensor:
        # softplus → strictly non-negative noise gain
        return torch.nn.functional.softplus(self.diffusion_net(x))


class LinearDynamics(Dynamics):
    """
    A node with an explicitly specified drift spectrum:  f(x, u) = x Aᵀ + u Bᵀ.

    Unlike the neural Dynamics, the drift Jacobian here is exactly A — a known,
    fixed matrix — so the Lyapunov collapse certificate (which reasons about
    eig(A)) can be verified against the actual rollout. This is a principled
    stable/unstable node, not an ad-hoc feedback term bolted onto a black box.
    """

    def __init__(self, A: Tensor, B: Optional[Tensor] = None,
                 noise: float = 0.05) -> None:
        if noise < 0:
            raise ValueError(f"noise is a gain and must be ≥ 0, got {noise}")
        dim = A.shape[0]
        ctrl_dim = B.shape[1] if B is not None else 1
        super().__init__(dim, ctrl_dim, hidden=1)
        self.register_buffer("A", A.clone())
        self.register_buffer(
            "B", B.clone() if B is not None else torch.zeros(dim, ctrl_dim))
        self._noise = noise

    def drift(self, x: Tensor, u: Tensor) -> Tensor:
        return x @ self.A.T + u @ self.B.T

    def diffusion(self, x: Tensor) -> Tensor:
        return torch.full_like(x, self._noise)


# ── PCSF controller (u* = argmin H) ──────────────────────────────────────────

class PCSFController(nn.Module):
    """
    Priority Constraint Satisfaction Framework as a policy network.

    The policy proposes u; dilation D(Σ) modulates control aggressiveness
    (high uncertainty → smaller, more cautious control — exploration regime).

    Invariant 1 (constraint dominance): a hard control bound `u_max` is applied
    as a NAP clamp AFTER the policy — optimization can never exceed it.
    """

    def __init__(self, dim: int, ctrl_dim: int, hidden: int = 64,
                 u_max: float = 5.0) -> None:
        super().__init__()
        self.policy = nn.Sequential(
            nn.Linear(dim, hidden), nn.SiLU(),
            nn.Linear(hidden, ctrl_dim),
        )
        self.u_max = u_max

    def forward(self, x: Tensor, sigma: Tensor) -> Tensor:
        raw = self.policy(x)
        # dilation D = 1 + tr(Σ)/d  →  scale = sigmoid(-(D-1)) ∈ (0, 0.5];
        # more uncertainty shrinks control magnitude (cautious exploration).
        d = x.shape[-1]
        tr = torch.diagonal(sigma, dim1=-2, dim2=-1).sum(-1, keepdim=True)
        dilation = 1.0 + tr / d
        scale = torch.sigmoid(-(dilation - 1.0))
        u = raw * scale
        # NAP hard clamp — constraints dominate optimization.
        return torch.clamp(u, -self.u_max, self.u_max)


# ── Covariance field (Kalman-Bucy Riccati) ───────────────────────────────────

class CovarianceField:
    """Covariance prediction and optional linear-Gaussian observation assimilation.

    Split mode uses the discrete prediction P- = F P F^T + Q with F=I+A*dt,
    followed only by an explicitly supplied observation update. assimilate()
    implements the Joseph-form update for y=Hx+v. The legacy step() method
    retains the historical continuous-time Riccati surrogate for old callers;
    it assumes C=I and an always-present measurement channel and is not a
    calibrated posterior update unless that observation model is actually true.
    """

    def __init__(self, dim: int, r: float = 1.0, eps: float = 1e-4,
                 sigma_max: float = 1e3) -> None:
        self.dim = dim
        self.r_inv = 1.0 / r
        self.eps = eps
        self.sigma_max = sigma_max

    def assimilate(self, x: Tensor, sigma: Tensor, observation: Tensor, H: Tensor, R: Tensor) -> tuple[Tensor, Tensor]:
        """Linear-Gaussian measurement update in Joseph form; no observation, no contraction."""
        b, d = x.shape
        if H.dim() == 2: H = H.unsqueeze(0).expand(b, -1, -1)
        if R.dim() == 2: R = R.unsqueeze(0).expand(b, -1, -1)
        if observation.dim() == 1: observation = observation.unsqueeze(0).expand(b, -1)
        if H.shape[0] != b or R.shape[0] != b or observation.shape[0] != b:
            raise ValueError("measurement batch dimensions must match state batch")
        m = H.shape[1]
        if H.shape[-1] != d or R.shape[-2:] != (m, m) or observation.shape[-1] != m:
            raise ValueError("incompatible measurement dimensions")
        for name, value in (("observation", observation), ("H", H), ("R", R)):
            if not bool(torch.isfinite(value).all()):
                raise ValueError(f"{name} must contain only finite values")
        if not torch.allclose(R, R.transpose(-1, -2), atol=1e-7, rtol=1e-6):
            raise ValueError("measurement covariance R must be symmetric")
        _, r_info = torch.linalg.cholesky_ex(R)
        if bool((r_info != 0).any()):
            raise ValueError("measurement covariance R must be positive definite")
        innovation = observation - torch.bmm(H, x.unsqueeze(-1)).squeeze(-1)
        HP = H @ sigma
        S = HP @ H.transpose(-1, -2) + R
        K = torch.linalg.solve(S, HP).transpose(-1, -2)
        x_post = x + torch.bmm(K, innovation.unsqueeze(-1)).squeeze(-1)
        I = torch.eye(d, device=x.device, dtype=x.dtype).expand(b, -1, -1)
        IKH = I - K @ H
        P_post = IKH @ sigma @ IKH.transpose(-1, -2) + K @ R @ K.transpose(-1, -2)
        return x_post, self._project_psd(P_post)

    def predict(self, sigma: Tensor, A: Tensor, q_diag: Tensor, dt: float, noise_map: Optional[Tensor] = None) -> Tensor:
        """Discrete covariance prediction under F=I+A·dt."""
        d = sigma.shape[-1]
        I = torch.eye(d, device=sigma.device, dtype=sigma.dtype).expand(sigma.shape[0], -1, -1)
        F = I + A * dt
        P = F @ sigma @ F.transpose(-1, -2)
        P = P + (torch.diag_embed(q_diag) * dt if noise_map is None else noise_map @ noise_map.transpose(-1, -2))
        return self._project_psd(P)

    def step(self, sigma: Tensor, A: Tensor, q_diag: Tensor, dt: float, noise_map: Optional[Tensor] = None) -> Tensor:
        """Legacy continuous-time Riccati surrogate; retained for unsplit callers."""
        AS = A @ sigma
        term = AS + AS.transpose(-1, -2)
        riccati = self.r_inv * (sigma @ sigma)
        sigma_next = sigma + (term - riccati) * dt
        if noise_map is None: sigma_next = sigma_next + torch.diag_embed(q_diag) * dt
        else: sigma_next = sigma_next + noise_map @ noise_map.transpose(-1, -2)
        return self._project_psd(sigma_next)

    def transport_shape(self, shape: Tensor, A: Tensor, dt: float) -> Tensor:
        """Transport a shape metric through the deterministic linearized step.

        Unlike belief covariance, this object receives no process-noise or measurement
        update. It follows S+ = F S F^T, F = I + A*dt; anti-collapse may then add a
        deliberate anisotropy lift. It is a regularizer, not a posterior covariance.
        """
        d = shape.shape[-1]
        eye = torch.eye(d, device=shape.device, dtype=shape.dtype).expand(shape.shape[0], -1, -1)
        F = eye + A * dt
        transported = F @ shape @ F.transpose(-1, -2)
        return self.project_preserving_shape(transported)

    def project_preserving_shape(self, sigma: Tensor) -> Tensor:
        """PSD projection that keeps the eigenvalue RATIOS, for the Σ₀⁻¹ bump.

        _project_psd clips: at Σ_pred = σ_max·I a bump on any subspace clips straight back to
        σ_max·I, erasing the contrast it was there to create. Scaling instead keeps a(Σ) exact,
        since a(cΣ) = a(Σ): headroom comes from lowering the other directions. Per sample. Only
        eigenvalues pushed below eps are clipped, which needs cond(Σ) > σ_max/eps."""
        sym = 0.5 * (sigma + sigma.transpose(-1, -2))
        evals, evecs = torch.linalg.eigh(sym)
        top = evals.max(dim=-1, keepdim=True).values.clamp_min(self.eps)
        evals = torch.clamp(evals * (self.sigma_max / top).clamp_max(1.0), self.eps, self.sigma_max)
        return (evecs * evals.unsqueeze(-2)) @ evecs.transpose(-1, -2)

    def _project_psd(self, sigma: Tensor) -> Tensor:
        sym = 0.5 * (sigma + sigma.transpose(-1, -2))
        evals, evecs = torch.linalg.eigh(sym)
        evals = torch.clamp(evals, self.eps, self.sigma_max)
        return evecs @ torch.diag_embed(evals) @ evecs.transpose(-1, -2)


def drift_jacobian(node: Dynamics, x: Tensor, u: Tensor) -> Tensor:
    """Open-loop A=∂f/∂x with u held fixed, batched (B,d,d)."""
    def f_single(xi: Tensor, ui: Tensor) -> Tensor:
        return node.drift(xi.unsqueeze(0), ui.unsqueeze(0)).squeeze(0)
    return torch.func.vmap(torch.func.jacrev(f_single, argnums=0))(x, u)


def closed_loop_drift_jacobian(node: Dynamics, policy: PCSFController, x: Tensor, sigma: Tensor) -> Tensor:
    """Jacobian of f(x,π(x,Σ)) w.r.t. x, holding Σ fixed, per sample."""
    def closed_loop_single(xi: Tensor, si: Tensor) -> Tensor:
        ui = policy(xi.unsqueeze(0), si.unsqueeze(0))
        return node.drift(xi.unsqueeze(0), ui).squeeze(0)
    return torch.func.vmap(torch.func.jacrev(closed_loop_single, argnums=0))(x, sigma)


# ── Hot-swap graph controller (σ: v₁ → v₂) ───────────────────────────────────

@dataclass
class SwapRecord:
    step: int
    from_id: str
    to_id: str
    drift_delta: float      # ‖f_old − f_new‖ on probe batch
    accepted: bool
    reason: str = ""


class GraphController:
    """
    Holds the active execution-graph dynamics node and performs hot-swaps.

    σ: v₁ → v₂ is valid iff behaviour is preserved:
        ‖f_old(x,u) − f_new(x,u)‖ / ‖f_old‖  <  tol   on a probe batch.

    Swaps are a DISCRETE outer process — the probe is run under no_grad so the
    swap decision never enters the SDE gradient tape (this is the fix for the
    non-differentiable jump in G(t): train the continuous SDE between swaps,
    treat the swap itself as a separate event).
    """

    def __init__(self, node: Dynamics, equivalence_tol: float = 0.25) -> None:
        self.active = node
        self.active_id = "v0"
        self.tol = equivalence_tol
        self.history: List[SwapRecord] = []
        self._counter = 0

    @torch.no_grad()
    def hot_swap(self, candidate: Dynamics, x: Tensor, u: Tensor,
                 step: int, new_id: Optional[str] = None) -> SwapRecord:
        self._counter += 1
        new_id = new_id or f"v{self._counter}"
        f_old = self.active.drift(x, u)
        f_new = candidate.drift(x, u)
        denom = f_old.norm() + 1e-8
        delta = (f_old - f_new).norm().item() / denom.item()
        accepted = delta < self.tol
        rec = SwapRecord(
            step=step, from_id=self.active_id, to_id=new_id,
            drift_delta=delta, accepted=accepted,
            reason="" if accepted else f"drift delta {delta:.3f} ≥ tol {self.tol}",
        )
        if accepted:
            self.active = candidate
            self.active_id = new_id
        self.history.append(rec)
        return rec


# ── Intervention policy + receipts (Issue #1138) ─────────────────────────────

@dataclass
class InterventionPolicy:
    """
    Bounded autonomy policy for CIO-SDE operators.

    Safe defaults: observe-only, zero budget, rollback and approval required.
    Broadening these defaults requires an explicit caller decision.
    """
    observe_only: bool = True
    max_interventions: int = 0          # 0 = never intervene, even if observe_only=False
    max_added_stage_cost: Optional[float] = 0.0  # None = no cost ceiling
    rollback_required: bool = True
    approval_required: bool = True


@dataclass
class InterventionReceipt:
    """
    Replayable record of one Σ₀ operator decision per forward_step.

    kind:
      "observe"              - trigger detected; state NOT mutated (observe_only or budget=0)
      "excite"               - anti_collapse_op fired and mutated x_next / sigma_next
      "project_to_attractor" - collapse_op fired and projected x_next to x_star
      "blocked"              - trigger fired but policy blocked mutation; records reason
    """
    step: int
    kind: str                        # observe | excite | project_to_attractor | blocked
    trigger_source: str              # structural | surprise | both | collapse_trigger
    sigma0_proximity: float
    surprise_spook: bool
    pre_x_norm: float
    post_x_norm: float
    pre_sigma_tr: float
    post_sigma_tr: float
    policy_reason: str               # why this kind was chosen
    stage_cost_delta: Optional[float] = None   # post − pre cost, when computable

    def to_dict(self) -> dict:
        return {
            "step": self.step,
            "kind": self.kind,
            "trigger_source": self.trigger_source,
            "sigma0_proximity": self.sigma0_proximity,
            "surprise_spook": self.surprise_spook,
            "pre_x_norm": self.pre_x_norm,
            "post_x_norm": self.post_x_norm,
            "pre_sigma_tr": self.pre_sigma_tr,
            "post_sigma_tr": self.post_sigma_tr,
            "policy_reason": self.policy_reason,
            "stage_cost_delta": self.stage_cost_delta,
        }


# ── Trace (observability + replay) ───────────────────────────────────────────

@dataclass
class Trace:
    """Causal execution log. Invariant 2: trajectory is replayable from this."""
    base_seed: int
    dt: float
    steps: List[Dict[str, float]] = field(default_factory=list)
    swaps: List[SwapRecord] = field(default_factory=list)
    collapses: List[Dict[str, object]] = field(default_factory=list)
    interventions: List[InterventionReceipt] = field(default_factory=list)
    shape_traces: List[float] = field(default_factory=list)
    final_shape_covariance: Optional[Tensor] = None
    running_cost: object = None      # differentiable ∫L dt when accumulate_cost

    def emit(self, step: int, **fields: float) -> None:
        self.steps.append({"step": step, **fields})

    def x_norms(self) -> List[float]:
        return [s["x_norm"] for s in self.steps]

    def sigma_traces(self) -> List[float]:
        return [s["sigma_tr"] for s in self.steps]


# ── CIO SDE system ───────────────────────────────────────────────────────────

class CIO_SDE(nn.Module):
    """
    Controlled stochastic differential system over a mutable graph.

    forward_step advances one Euler-Maruyama step of x and one Riccati step of Σ,
    deriving control from PCSF and (optionally) recording the co-state λ and
    Hamiltonian H for diagnostics.
    """

    def __init__(self, dim: int, ctrl_dim: int, hidden: int = 64,
                 r: float = 1.0, ctrl_cost: float = 0.1,
                 u_max: float = 5.0,
                 intervention_policy: Optional[InterventionPolicy] = None) -> None:
        super().__init__()
        self.dim = dim
        self.ctrl_dim = ctrl_dim
        self.graph = GraphController(Dynamics(dim, ctrl_dim, hidden))
        self.pcsf = PCSFController(dim, ctrl_dim, hidden, u_max=u_max)
        self.cov = CovarianceField(dim, r=r)
        self.ctrl_cost = ctrl_cost
        self.collapse_op = None      # optional Σ₀ Semantic Collapse Operator
        self.anti_collapse_op = None # optional Σ₀⁻¹ Anti-Collapse Operator
        self.surprise_monitor = None # optional SurpriseMonitor for NIS-based collapse detection
        # Bounded autonomy policy. Safe default: observe-only, zero budget.
        self.intervention_policy: InterventionPolicy = (
            intervention_policy if intervention_policy is not None
            else InterventionPolicy()
        )
        self._intervention_count: int = 0  # resets per rollout via reset_intervention_count()
        # One-step prediction (x̂_{t|t-1}, P_{t|t-1}) for the surprise observation model
        # (#657). Instead of self-observing (y=x gave innovation ν≡0), the engine runs a
        # genuine Kalman predict/update cycle: it predicts the NEXT state from the model's
        # own drift+diffusion, then scores the realized state as an observation. The
        # prediction covariance P is seeded with the model's diffusion process noise Q, so
        # smooth exploration yields NIS≈m (consistent — quiet), and only an ANOMALOUS jump
        # (the collapse snap onto the attractor, or a Σ₀⁻¹ excitation kick) makes
        # NIS = νᵀS⁻¹ν spike past the χ² threshold — the spook. None until first seeded.
        self._surprise_pred_mean = None
        self._surprise_pred_cov = None
        # Observation (sensor) noise R for the NIS canary, and a covariance floor so S
        # stays well-conditioned when the diffusion process noise is tiny.
        self.surprise_obs_noise = 0.01
        self.surprise_cov_floor = 1e-3
        self.register_buffer("x_target", torch.zeros(dim))

    # L(x, u) = ‖x − x*‖² + ρ‖u‖²  (latency+compute+risk rolled into a quadratic)
    def stage_cost(self, x: Tensor, u: Tensor) -> Tensor:
        goal = ((x - self.x_target) ** 2).sum(-1)
        ctrl = self.ctrl_cost * (u ** 2).sum(-1)
        return goal + ctrl

    def reset_intervention_count(self) -> None:
        """Call at the start of each rollout to reset the per-run intervention budget."""
        self._intervention_count = 0

    # H = L + λᵀ f + tr(Σ)
    def hamiltonian(self, x: Tensor, u: Tensor, lam: Tensor, sigma: Tensor) -> Tensor:
        f = self.graph.active.drift(x, u)
        tr = torch.diagonal(sigma, dim1=-2, dim2=-1).sum(-1)
        return self.stage_cost(x, u) + (lam * f).sum(-1) + tr

    def forward_step(self, x: Tensor, sigma: Tensor, dt: float,
                     noise: Tensor,
                     step: int = -1,
                     shape_covariance: Optional[Tensor] = None,
                     measurement: Optional[Tuple[Tensor, Tensor, Tensor]] = None) -> Tuple[Tensor, Tensor, Dict[str, Tensor]]:
        """Advance one step with an optional separate shape regularizer.

        Omitting shape_covariance preserves the historical single-Sigma behavior.
        Supplying it activates the split: sigma is belief covariance; shape covariance
        is transported deterministically and receives C3 regularization separately.
        """
        split_covariance = shape_covariance is not None
        shape_current = shape_covariance if split_covariance else sigma
        node = self.graph.active
        if split_covariance and measurement is not None:
            x, sigma = self.cov.assimilate(x, sigma, *measurement)
        u = self.pcsf(x, sigma)
        f = node.drift(x, u)
        g = node.diffusion(x)                       # (B, d) noise gain ≥ 0

        # dilation amplifies exploration noise (high Σ → wider search)
        d = x.shape[-1]
        tr = torch.diagonal(sigma, dim1=-2, dim2=-1).sum(-1, keepdim=True)
        dilation = 1.0 + tr / d

        dx = f * dt
        dW = g * dilation * noise * math.sqrt(dt)
        x_next = x + dx + dW

        # covariance: Σ̇ = AΣ+ΣAᵀ+Q−ΣR⁻¹Σ
        # Lyapunov contraction: A is the linearization of dx=f(x,u)dt+g(x)dW.
        # Stability of A is certified off this path, by collapse.dichotomy_certificate and
        # stability_gates (matrix-measure contraction analysis: Lohmiller & Slotine 1998,
        # Automatica 34(6):683-696).
        A = (closed_loop_drift_jacobian(node, self.pcsf, x.detach(), sigma.detach())
             if split_covariance else drift_jacobian(node, x.detach(), u.detach()))
        # The state receives diag(g * dilation) dW, not diag(g) dW.
        # Keep the Riccati process-noise term consistent with that executed map.
        effective_diffusion = g.detach() * dilation.detach()
        q_diag = effective_diffusion.square()
        base_noise_map = torch.diag_embed(effective_diffusion * math.sqrt(dt))
        sigma_next = (self.cov.predict(sigma, A, q_diag, dt) if split_covariance
                      else self.cov.step(sigma, A, q_diag, dt))
        shape_next = (
            self.cov.transport_shape(shape_current, A, dt)
            if split_covariance else sigma_next
        )

        info = {"u": u, "f": f, "g": g, "dilation": dilation.squeeze(-1),
                "collapse": None, "anti_collapse_p": 0.0, "sigma0_proximity": 0.0,
                "surprise_spook": False}

        # Σ₀⁻¹ anti-collapse: inject excitation along null modes to escape an
        # imminent 42-state. When it fires it SUPPRESSES the Σ₀ freeze this step
        # (the whole point is to prevent collapse, not freeze into it).
        anti_active = False
        anti_active_mask = torch.zeros(x.shape[0], device=x.device, dtype=torch.bool)
        sigma0_proximity = 0.0
        surprise_boost = torch.zeros(x.shape[0], device=x.device, dtype=x.dtype)
        
        # Surprise monitor — NIS-based collapse detection (#506/#657).
        # The engine no longer self-observes (y=x gave innovation ν≡0, so the canary
        # never fired). It carries a belief mean x̂ propagated noise-free through the
        # model's own linearized dynamics F = I + A·dt; the TRUE state x is the
        # observation. The innovation ν = x − C x̂ is the drift+noise the deterministic
        # forecast could not anticipate. As Σ contracts toward collapse, S = CΣCᵀ + R
        # shrinks toward R and NIS = νᵀ S⁻¹ ν spikes — the spook (Bar-Shalom, Li &
        # Kirubarajan 2001, the NIS χ² consistency test).
        if self.surprise_monitor is not None:
            bsz, dd = x.shape
            eye = torch.eye(dd, device=x.device, dtype=x.dtype).unsqueeze(0)
            C = eye.expand(bsz, -1, -1)
            R = eye.expand(bsz, -1, -1) * self.surprise_obs_noise
            if self._surprise_pred_mean is not None and self._surprise_pred_mean.shape == x.shape:
                # Score the prediction made LAST step against the realized state x.
                surprise_result = self.surprise_monitor.evaluate(
                    self._surprise_pred_mean, self._surprise_pred_cov, x, C, R)
                info["surprise_spook"] = bool(surprise_result["spook"].any())
                info["surprise_nis"] = float(surprise_result["nis"].mean().item())
                if info["surprise_spook"] and self.surprise_monitor.anti_collapse_trigger:
                    # Spook → boost anti-collapse proximity to 1.0 (detect → excite).
                    surprise_boost = surprise_result["spook"].to(dtype=x.dtype)
                # Measurement update: fuse x to get the posterior belief.
                x_post, P_post = self.surprise_monitor.update(
                    self._surprise_pred_mean, self._surprise_pred_cov, x, C, R)
            else:
                x_post = x.detach()                              # seed belief at first state
                P_post = eye.expand(bsz, -1, -1).clone() * self.surprise_obs_noise
            # Predict the NEXT state for next step's comparison, using the model's OWN
            # drift (mean) and diffusion (process-noise covariance). Q = expected one-step
            # increment variance (g·dilation)²·dt — so a state evolving as the model expects
            # produces a consistent innovation (NIS≈m), and only a deviation surprises.
            F = eye + A * dt
            proc_var = (g.detach() * dilation) ** 2 * dt + self.surprise_cov_floor   # (B, d)
            Q = torch.diag_embed(proc_var)
            self._surprise_pred_mean = (x_post + f.detach() * dt)
            P_next = F @ P_post @ F.transpose(-1, -2) + Q
            self._surprise_pred_cov = 0.5 * (P_next + P_next.transpose(-1, -2)).detach()
        
        policy = self.intervention_policy
        pre_x_norm = x.norm().item()
        pre_sigma_tr = torch.diagonal(sigma, dim1=-2, dim2=-1).sum(-1).mean().item()
        receipt: Optional[InterventionReceipt] = None

        if self.anti_collapse_op is not None:
            per_sample_method = getattr(self.anti_collapse_op, "proximity_per_sample", None)
            supports_per_sample = callable(per_sample_method)
            if supports_per_sample:
                mro = type(self.anti_collapse_op).__mro__
                per_owner = next((cls for cls in mro if "proximity_per_sample" in cls.__dict__), None)
                scalar_owner = next((cls for cls in mro if "proximity" in cls.__dict__), None)
                excite_owner = next((cls for cls in mro if "excite" in cls.__dict__), None)
                if per_owner is not None and scalar_owner is not None and excite_owner is not None:
                    per_depth = mro.index(per_owner)
                    supports_per_sample = (
                        per_depth <= mro.index(scalar_owner)
                        and per_depth <= mro.index(excite_owner)
                    )

            if supports_per_sample:
                proximity_per_sample = per_sample_method(self, x, u, shape_current, A)
                sigma0_proximity = float(proximity_per_sample.max().item())
            else:
                sigma0_proximity = float(self.anti_collapse_op.proximity(self, x, u, shape_current, A))
                proximity_per_sample = torch.full_like(surprise_boost, sigma0_proximity)

            effective_per_sample = torch.maximum(proximity_per_sample, surprise_boost)
            effective_proximity = float(effective_per_sample.max().item())
            surprise_any = bool((surprise_boost > 0).any())
            structural_any = sigma0_proximity > 0.0
            info["sigma0_proximity"] = sigma0_proximity

            if effective_proximity > 0.0:
                if surprise_any and structural_any:
                    trigger_src = "both"
                elif surprise_any:
                    trigger_src = "surprise"
                else:
                    trigger_src = "structural"

                budget_ok = (
                    not policy.observe_only
                    and self._intervention_count < policy.max_interventions
                )
                if budget_ok:
                    # Validate only members that actually receive the built-in S1 state kick.
                    if getattr(self.anti_collapse_op, "strength", 1.0) > 0.0:
                        effective_gain = g * dilation
                        active = effective_per_sample > 0
                        bad_gain = (~torch.isfinite(effective_gain) | (effective_gain < 0)).any(dim=-1)
                        if bool((bad_gain & active).any()):
                            raise ValueError(
                                "the anti-collapse kick needs a finite non-negative diffusion gain after dilation"
                            )
                    excite_proximity = effective_per_sample if supports_per_sample else effective_proximity

                    # If this operator's excite() and noise-map methods share the same
                    # implementation owner, include the kick in the predicted covariance.
                    # M_total ξ = [diag(g*dilation*sqrt(dt)) + κP] ξ; this captures
                    # both κ²PPᵀ and the shared-noise cross terms.
                    noise_map_method = getattr(self.anti_collapse_op, "excitation_noise_map", None)
                    mro = type(self.anti_collapse_op).__mro__
                    excite_owner = next((cls for cls in mro if "excite" in cls.__dict__), None)
                    map_owner = next((cls for cls in mro
                                      if "excitation_noise_map" in cls.__dict__), None)
                    if callable(noise_map_method) and excite_owner is not None and excite_owner is map_owner:
                        kick_noise_map = noise_map_method(
                            A, excite_proximity, x.shape[0], x.device, x.dtype
                        )
                        sigma_next = (
                            self.cov.predict(sigma, A, q_diag, dt, noise_map=base_noise_map + kick_noise_map)
                            if split_covariance else self.cov.step(
                                sigma, A, q_diag, dt, noise_map=base_noise_map + kick_noise_map)
                        )

                    dx_extra, sig_extra = self.anti_collapse_op.excite(
                        x, shape_next if split_covariance else sigma_next,
                        A, excite_proximity, noise)
                    x_next = x_next + dx_extra
                    if split_covariance:
                        shape_next = self.cov.project_preserving_shape(shape_next + sig_extra)
                    else:
                        sigma_next = self.cov.project_preserving_shape(sigma_next + sig_extra)
                    info["anti_collapse_p"] = effective_proximity
                    anti_active = True
                    anti_active_mask = (
                        effective_per_sample > 0 if supports_per_sample
                        else torch.full_like(effective_per_sample, True, dtype=torch.bool)
                    )
                    self._intervention_count += 1
                    receipt = InterventionReceipt(
                        step=step, kind="excite", trigger_source=trigger_src,
                        sigma0_proximity=sigma0_proximity, surprise_spook=surprise_any,
                        pre_x_norm=pre_x_norm, post_x_norm=x_next.norm().item(),
                        pre_sigma_tr=pre_sigma_tr,
                        post_sigma_tr=torch.diagonal(sigma_next, dim1=-2, dim2=-1).sum(-1).mean().item(),
                        policy_reason="budget_ok: per-sample anti-collapse excite fired",
                    )
                else:
                    kind = "observe" if policy.observe_only else "blocked"
                    reason = (
                        "observe_only=True" if policy.observe_only
                        else f"budget exhausted ({self._intervention_count}/{policy.max_interventions})"
                    )
                    receipt = InterventionReceipt(
                        step=step, kind=kind, trigger_source=trigger_src,
                        sigma0_proximity=sigma0_proximity, surprise_spook=surprise_any,
                        pre_x_norm=pre_x_norm, post_x_norm=x_next.norm().item(),
                        pre_sigma_tr=pre_sigma_tr,
                        post_sigma_tr=torch.diagonal(sigma_next, dim1=-2, dim2=-1).sum(-1).mean().item(),
                        policy_reason=reason,
                    )

        # Σ₀ gating: freeze only the members that independently satisfy the gate.
        if self.collapse_op is not None:
            per_sample_evaluator = getattr(self.collapse_op, "evaluate_per_sample", None)
            supports_per_sample = callable(per_sample_evaluator)
            if supports_per_sample:
                mro = type(self.collapse_op).__mro__
                per_owner = next((cls for cls in mro if "evaluate_per_sample" in cls.__dict__), None)
                scalar_owner = next((cls for cls in mro if "evaluate" in cls.__dict__), None)
                if per_owner is not None and scalar_owner is not None:
                    supports_per_sample = mro.index(per_owner) <= mro.index(scalar_owner)

            if supports_per_sample:
                res = per_sample_evaluator(self, x, u, shape_current, A, exclude_mask=anti_active_mask)
            elif not anti_active:
                # Legacy custom collapse operators retain their batch-wide evaluate() contract.
                res = self.collapse_op.evaluate(self, x, u, shape_current, A)
            else:
                res = None

            if res is not None and res.triggered:
                budget_ok = (
                    not policy.observe_only
                    and self._intervention_count < policy.max_interventions
                )
                if budget_ok:
                    if supports_per_sample and res.triggered_mask is not None:
                        collapse_mask = res.triggered_mask
                        x_next = torch.where(collapse_mask.unsqueeze(-1), res.x_star, x_next)
                        sigma_next = torch.where(collapse_mask[:, None, None], sigma, sigma_next)
                        if split_covariance:
                            shape_next = torch.where(collapse_mask[:, None, None], shape_current, shape_next)
                    else:
                        x_next = res.x_star
                        sigma_next = sigma
                        if split_covariance:
                            shape_next = shape_current
                    info["collapse"] = res
                    self._intervention_count += 1
                    receipt = InterventionReceipt(
                        step=step, kind="project_to_attractor", trigger_source="collapse_trigger",
                        sigma0_proximity=float(info.get("sigma0_proximity", 0.0)),
                        surprise_spook=bool(info.get("surprise_spook", False)),
                        pre_x_norm=pre_x_norm, post_x_norm=x_next.norm().item(),
                        pre_sigma_tr=pre_sigma_tr,
                        post_sigma_tr=torch.diagonal(sigma_next, dim1=-2, dim2=-1).sum(-1).mean().item(),
                        policy_reason="budget_ok: per-sample collapse projected to attractor",
                    )
                else:
                    kind = "observe" if policy.observe_only else "blocked"
                    reason = (
                        "observe_only=True" if policy.observe_only
                        else f"budget exhausted ({self._intervention_count}/{policy.max_interventions})"
                    )
                    receipt = InterventionReceipt(
                        step=step, kind=kind, trigger_source="collapse_trigger",
                        sigma0_proximity=float(info.get("sigma0_proximity", 0.0)),
                        surprise_spook=bool(info.get("surprise_spook", False)),
                        pre_x_norm=pre_x_norm, post_x_norm=x_next.norm().item(),
                        pre_sigma_tr=pre_sigma_tr,
                        post_sigma_tr=torch.diagonal(sigma_next, dim1=-2, dim2=-1).sum(-1).mean().item(),
                        policy_reason=reason,
                    )

        info["intervention_receipt"] = receipt
        if split_covariance:
            info["shape_covariance"] = shape_next
        return x_next, sigma_next, info

    def costate(self, x: Tensor, u: Tensor, sigma: Tensor) -> Tensor:
        """λ = ∂H/∂x at the current point (instantaneous adjoint, detached)."""
        xr = x.detach().clone().requires_grad_(True)
        H = self.hamiltonian(xr, u.detach(), torch.zeros_like(xr), sigma.detach()).sum()
        (grad,) = torch.autograd.grad(H, xr)
        return grad.detach()


def rollout(model: CIO_SDE, x0: Tensor, sigma0: Tensor, steps: int,
            dt: float = 0.05, base_seed: int = 0,
            swap_schedule: Optional[Dict[int, Dynamics]] = None,
            record: bool = True,
            accumulate_cost: bool = False,
            shape_sigma0: Optional[Tensor] = None,
            measurement_schedule: Optional[Dict[int, Tuple[Tensor, Tensor, Tensor]]] = None
            ) -> Tuple[Tensor, Tensor, Trace]:
    """
    Deterministic, replayable rollout.

    Noise at step t is drawn from a generator seeded by (base_seed + t), so two
    rollouts with the same base_seed produce identical trajectories — this is
    what makes the trace replayable (invariant 2).

    If accumulate_cost=True, trace.running_cost holds the differentiable
    trajectory-integrated stage cost  Σ_t L(x_t, u_t) · dt  — the optimal-control
    objective ∫L dt used for training.
    """
    x, sigma = x0, sigma0
    shape_sigma = shape_sigma0
    trace = Trace(base_seed=base_seed, dt=dt)
    swap_schedule = swap_schedule or {}
    device = x0.device
    running = torch.zeros((), device=device)
    model.reset_intervention_count()

    for t in range(steps):
        gen = torch.Generator(device=device)
        gen.manual_seed(base_seed + t)
        noise = torch.randn(x.shape, generator=gen, device=device)

        if t in swap_schedule:
            with torch.no_grad():
                u_probe = model.pcsf(x, sigma)
            rec = model.graph.hot_swap(swap_schedule[t], x.detach(), u_probe, t)
            trace.swaps.append(rec)

        measurement = (measurement_schedule or {}).get(t)
        x_next, sigma_next, info = model.forward_step(
            x, sigma, dt, noise, step=t, shape_covariance=shape_sigma,
            measurement=measurement,
        )
        if shape_sigma is not None:
            shape_sigma = info["shape_covariance"]

        if info.get("collapse") is not None:
            trace.collapses.append({"step": t, "result": info["collapse"]})

        if info.get("intervention_receipt") is not None:
            trace.interventions.append(info["intervention_receipt"])

        if accumulate_cost:
            running = running + model.stage_cost(x, info["u"]).mean() * dt

        if shape_sigma is not None:
            trace.shape_traces.append(
                torch.diagonal(shape_sigma, dim1=-2, dim2=-1).sum(-1).mean().item()
            )

        if record:
            xdot = (x_next - x) / dt
            trace.emit(
                t,
                x_norm=x.norm().item(),
                sigma_tr=torch.diagonal(sigma, dim1=-2, dim2=-1).sum(-1).mean().item(),
                u_norm=info["u"].norm().item(),
                dilation=info["dilation"].mean().item(),
                xdot_norm=xdot.norm().item(),
                cost=model.stage_cost(x, info["u"]).mean().item(),
                anti_collapse_p=float(info.get("anti_collapse_p", 0.0)),
                sigma0_proximity=float(info.get("sigma0_proximity", 0.0)),
                surprise_spook=bool(info.get("surprise_spook", False)),
            )
        x, sigma = x_next, sigma_next

    if shape_sigma is not None:
        trace.final_shape_covariance = shape_sigma.detach().clone()
    trace.running_cost = running
    return x, sigma, trace


# ── Paired control helper (Issue #1138 §4) ───────────────────────────────────

@dataclass
class PairedRunSummary:
    """Comparable outcome summary for one arm of a paired control experiment."""
    label: str
    final_x_norm: float
    final_sigma_tr: float
    integrated_cost: Optional[float]
    collapse_count: int
    intervention_count: int
    receipts: List[dict]


def paired_control_rollout(
    model: CIO_SDE,
    x0: Tensor,
    sigma0: Tensor,
    steps: int,
    dt: float = 0.05,
    base_seed: int = 0,
) -> Tuple[PairedRunSummary, PairedRunSummary, PairedRunSummary]:
    """
    Run three arms from the same (x0, sigma0, base_seed):

      1. no_op  — no collapse/anti-collapse operators attached at all
      2. observe — operators attached, policy=observe_only (default)
      3. bounded — operators attached, policy allows up to max_interventions=10

    Returns (no_op_summary, observe_summary, bounded_summary).

    Arm 1 establishes the baseline trajectory. Arm 2 proves observe-only produces
    the same trajectory. Arm 3 shows what bounded intervention does. No claim is
    made that any arm is optimal.
    """
    saved_policy = model.intervention_policy
    saved_collapse = model.collapse_op
    saved_anti = model.anti_collapse_op

    def _summarise(label: str, xf: Tensor, sf: Tensor, trace: Trace, cost_tensor) -> PairedRunSummary:
        return PairedRunSummary(
            label=label,
            final_x_norm=xf.norm().item(),
            final_sigma_tr=torch.diagonal(sf, dim1=-2, dim2=-1).sum(-1).mean().item(),
            integrated_cost=cost_tensor.item() if cost_tensor is not None else None,
            collapse_count=len(trace.collapses),
            intervention_count=len(trace.interventions),
            receipts=[r.to_dict() for r in trace.interventions],
        )

    # Arm 1: no operators
    model.collapse_op = None
    model.anti_collapse_op = None
    model.intervention_policy = InterventionPolicy()  # observe_only=True, budget=0
    xf1, sf1, t1 = rollout(model, x0, sigma0, steps, dt=dt, base_seed=base_seed, accumulate_cost=True)
    s1 = _summarise("no_op", xf1, sf1, t1, t1.running_cost)

    # Arm 2: operators attached, observe_only=True (default policy)
    model.collapse_op = saved_collapse
    model.anti_collapse_op = saved_anti
    model.intervention_policy = InterventionPolicy(observe_only=True, max_interventions=0)
    xf2, sf2, t2 = rollout(model, x0, sigma0, steps, dt=dt, base_seed=base_seed, accumulate_cost=True)
    s2 = _summarise("observe", xf2, sf2, t2, t2.running_cost)

    # Arm 3: bounded intervention (up to 10 per rollout)
    model.intervention_policy = InterventionPolicy(observe_only=False, max_interventions=10)
    xf3, sf3, t3 = rollout(model, x0, sigma0, steps, dt=dt, base_seed=base_seed, accumulate_cost=True)
    s3 = _summarise("bounded", xf3, sf3, t3, t3.running_cost)

    # Restore
    model.collapse_op = saved_collapse
    model.anti_collapse_op = saved_anti
    model.intervention_policy = saved_policy

    return s1, s2, s3
