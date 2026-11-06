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

from .surprise import scored_mean

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
    """
    Bayesian uncertainty dynamics via the Kalman-Bucy Riccati equation:

        Σ̇ = AΣ + ΣAᵀ + Q − Σ Cᵀ R⁻¹ C Σ

    with C = I (full observation). A is the drift Jacobian ∂f/∂x (the actual
    local linearization, not a step-magnitude proxy), Q = diag(g(x)²) is the
    process-noise covariance, R is measurement noise. Σ is kept symmetric PSD.

    This is the correction over an ad-hoc OU update: Σ tracks genuine posterior
    uncertainty, so it shrinks when observations are informative and the
    Riccati −ΣR⁻¹Σ term provides the contraction that bounds Σ.
    """

    def __init__(self, dim: int, r: float = 1.0, eps: float = 1e-4,
                 sigma_max: float = 1e3) -> None:
        self.dim = dim
        self.r_inv = 1.0 / r
        self.eps = eps
        self.sigma_max = sigma_max

    def step(self, sigma: Tensor, A: Tensor, q_diag: Tensor, dt: float) -> Tensor:
        # AΣ + ΣAᵀ
        AS = A @ sigma
        term = AS + AS.transpose(-1, -2)
        # + Q  (diagonal process noise from diffusion gain²)
        Q = torch.diag_embed(q_diag)
        # − Σ R⁻¹ Σ   (C = I)
        riccati = self.r_inv * (sigma @ sigma)
        dsigma = term + Q - riccati
        sigma_next = sigma + dsigma * dt
        return self._project_psd(sigma_next)

    def project_preserving_shape(self, sigma: Tensor) -> Tensor:
        """PSD projection that keeps the eigenvalue RATIOS, for the Σ₀⁻¹ bump.

        _project_psd clips: at Σ_pred = σ_max·I a bump on any subspace clips straight back to
        σ_max·I, erasing the contrast it was there to create. Scaling instead keeps a(Σ) exact,
        since a(cΣ) = a(Σ): headroom comes from lowering the other directions. Per sample. Only
        eigenvalues pushed below eps are clipped, which needs cond(Σ) > σ_max/eps. A sample that
        holds a NaN or inf is returned unprojected, as _project_psd returns it."""
        sym, ok, safe = _split_nonfinite(sigma)
        evals, evecs = torch.linalg.eigh(safe)
        top = evals.max(dim=-1, keepdim=True).values.clamp_min(self.eps)
        evals = torch.clamp(evals * (self.sigma_max / top).clamp_max(1.0), self.eps, self.sigma_max)
        return _rejoin_nonfinite((evecs * evals.unsqueeze(-2)) @ evecs.transpose(-1, -2), ok, sym)

    def _project_psd(self, sigma: Tensor) -> Tensor:
        """Clip each sample's eigenvalues to [eps, σ_max]. A sample that holds a NaN or inf is returned
        unprojected (symmetrized, still not finite): it has no eigendecomposition, and a batched one
        raises for every sample on a NaN, or returns numbers for it. It no longer reaches the
        decomposition, so one broken trajectory cannot fail the step for the rest."""
        sym, ok, safe = _split_nonfinite(sigma)
        evals, evecs = torch.linalg.eigh(safe)
        evals = torch.clamp(evals, self.eps, self.sigma_max)
        return _rejoin_nonfinite(evecs @ torch.diag_embed(evals) @ evecs.transpose(-1, -2), ok, sym)


def _split_nonfinite(sigma: Tensor) -> Tuple[Tensor, Tensor, Tensor]:
    """(sym, ok, safe) for a batched eigendecomposition: sym = ½(Σ+Σᵀ), ok marks the samples whose sym
    is finite, and safe is sym with every other sample zeroed. safe IS sym when all are finite, so a
    finite batch is decomposed exactly as before."""
    sym = 0.5 * (sigma + sigma.transpose(-1, -2))
    ok = torch.isfinite(sym).flatten(-2).all(-1)
    if bool(ok.all()):
        return sym, ok, sym
    return sym, ok, torch.where(ok[..., None, None], sym, torch.zeros_like(sym))


def _rejoin_nonfinite(projected: Tensor, ok: Tensor, sym: Tensor) -> Tensor:
    """The projection where the sample was finite, its unprojected sym where not."""
    return projected if bool(ok.all()) else torch.where(ok[..., None, None], projected, sym)


def drift_jacobian(node: Dynamics, x: Tensor, u: Tensor) -> Tensor:
    """A = ∂f/∂x, batched (B, d, d), via functional Jacobian per sample."""
    def f_single(xi: Tensor, ui: Tensor) -> Tensor:
        return node.drift(xi.unsqueeze(0), ui.unsqueeze(0)).squeeze(0)

    jac = torch.func.vmap(torch.func.jacrev(f_single, argnums=0))(x, u)
    return jac


# ── Hot-swap graph controller (σ: v₁ → v₂) ───────────────────────────────────

@dataclass
class SwapRecord:
    step: int
    from_id: str
    to_id: str
    drift_delta: float      # the worst trajectory's ‖f_old − f_new‖ / ‖f_old‖ on the probe batch
    accepted: bool
    reason: str = ""
    row_deltas: List[float] = field(default_factory=list)   # each probe trajectory's own delta
    worst_row: Optional[int] = None                         # the row drift_delta is from


class GraphController:
    """
    Holds the active execution-graph dynamics node and performs hot-swaps.

    σ: v₁ → v₂ is valid iff behaviour is preserved on every trajectory of the probe batch:

        δᵢ = ‖f_old(xᵢ,uᵢ) − f_new(xᵢ,uᵢ)‖ / ‖f_old(xᵢ,uᵢ)‖  <  tol   for every row i.

    The batch is B trajectories, as it is for the Σ₀ gate, so the swap is accepted only if it
    preserves each trajectory's own drift. One norm over the whole batch let a candidate that changes
    one trajectory's drift a lot pass on the others: a row whose drift flips sign hid behind a
    row with ten times its drift. With one trajectory δ₀ is the ratio the batch norm gave, computed
    the same way, so a batch-size-1 decision is unchanged. A row whose δᵢ is NaN counts as
    changed. The record keeps every δᵢ, and drift_delta is the worst of them (NaN if any is).

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
        # one row per trajectory; broadcast first, as the batch-wide difference did
        f_old, f_new = (f.reshape(-1, f.shape[-1]) for f in torch.broadcast_tensors(f_old, f_new))
        # Each row is the ratio the batch norm took for one trajectory, in the same operations. The
        # 1e-8 floor is kept in double where the dtype rounds it to 0 (float16), instead of dividing by 0.
        deltas = [(o - n).norm().item() / ((o.norm() + 1e-8).item() or 1e-8) for o, n in zip(f_old, f_new)]
        # An empty probe has nothing to compare: δ = 0, decided as the batch norm decided it.
        accepted = all(dl < self.tol for dl in deltas) if deltas else 0.0 < self.tol
        broken = [i for i, dl in enumerate(deltas) if math.isnan(dl)]
        worst = (broken[0] if broken else max(range(len(deltas)), key=deltas.__getitem__)) if deltas else None
        delta = deltas[worst] if worst is not None else 0.0
        rec = SwapRecord(
            step=step, from_id=self.active_id, to_id=new_id,
            drift_delta=delta, accepted=accepted,
            reason="" if accepted else (f"trajectory {worst} of {len(deltas)}: drift delta {delta:.3f} "
                                        f"is not below tol {self.tol}"),
            row_deltas=deltas, worst_row=worst,
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
    Replayable record of one Σ₀ operator decision for one trajectory in one forward_step.

    kind:
      "observe"              - trigger detected; state NOT mutated (observe_only or budget=0)
      "excite"               - anti_collapse_op fired and mutated x_next / sigma_next
      "project_to_attractor" - collapse_op fired and projected x_next to x_star
      "blocked"              - trigger fired but the row was not changed: its budget is spent, or its
                               covariance step overflowed (no spectrum to lift); records reason

    The norms and traces are this trajectory's own. `sample` is its row in the batch.
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
    sample: Optional[int] = None     # row of the trajectory in the batch

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
            "sample": self.sample,
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
        # Interventions so far on each trajectory, (B,); resets per rollout via reset_intervention_count().
        self._intervention_counts: Optional[Tensor] = None
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
        self._intervention_counts = None

    def _budget_open(self, bsz: int, device) -> Tensor:
        """Which trajectories the policy still lets the operators change, (B,).

        Each trajectory has its own budget of policy.max_interventions per rollout, so whether one may
        be changed never depends on the others. The counts belong to the batch they were spent on:
        changing the batch size after spending any of them raises rather than handing out fresh ones."""
        policy = self.intervention_policy
        if policy.observe_only or policy.max_interventions <= 0:
            return torch.zeros(bsz, dtype=torch.bool, device=device)
        counts = self._intervention_counts
        if counts is not None and counts.shape[0] != bsz and bool(counts.any()):
            raise ValueError(
                f"the batch changed from {counts.shape[0]} to {bsz} trajectories after some of their "
                "intervention budget was spent; call reset_intervention_count() for a new batch")
        if counts is None or counts.shape[0] != bsz:
            counts = self._intervention_counts = torch.zeros(bsz, dtype=torch.long, device=device)
        return counts < policy.max_interventions

    def _held(self, i: int) -> Tuple[str, str]:
        """(kind, reason) for a trajectory whose trigger fired and that the policy did not let change."""
        policy = self.intervention_policy
        if policy.observe_only:
            return "observe", "observe_only=True"
        counts = self._intervention_counts
        used = int(counts[i]) if counts is not None and i < counts.shape[0] else 0
        return "blocked", f"budget exhausted ({used}/{policy.max_interventions})"

    # H = L + λᵀ f + tr(Σ)
    def hamiltonian(self, x: Tensor, u: Tensor, lam: Tensor, sigma: Tensor) -> Tensor:
        f = self.graph.active.drift(x, u)
        tr = torch.diagonal(sigma, dim1=-2, dim2=-1).sum(-1)
        return self.stage_cost(x, u) + (lam * f).sum(-1) + tr

    def forward_step(self, x: Tensor, sigma: Tensor, dt: float,
                     noise: Tensor,
                     step: int = -1) -> Tuple[Tensor, Tensor, Dict[str, Tensor]]:
        """One Euler-Maruyama step of x and one Riccati step of Σ, then the Σ₀ operators.

        The Σ₀ operators decide per trajectory. Each row of the batch is gated on its own four
        signals and, when a surprise monitor drives the anti-collapse operator, on its own spook.
        Only the rows that fire change: the anti-collapse operator kicks and bumps exactly those
        rows, and the collapse operator overwrites exactly the triggered rows that were not just
        excited. Every other row keeps the x_next and sigma_next of the plain SDE step. Each
        trajectory has its own budget of policy.max_interventions per rollout, so whether a row may
        change never depends on the other rows. Each row that fires gets its own receipt, whose
        `sample` is its index. So as far as the operators go, a batch is B independent trajectories:
        the gate, the kick, the bump, the budget and the receipt of row i are row i's own. In numbers,
        a batched step agrees with the step on row i alone, given the same noise, only to rounding:
        Tensor.std rounds one row differently from the same row in a batch (the anisotropy and the C3
        floor use it), and the neural Dynamics' matrix products do too (about 1e-15 in float64, 1e-6 in
        float32). It is bit for bit where nothing rounds differently, as in
        test_a_batch_is_independent_trajectories, and a row within rounding of a threshold can decide
        differently in a batch than alone. Independence also assumes the drift, diffusion, policy and
        stage cost treat rows separately; nothing checks it.

        info["intervention_receipts"] lists every receipt of the step, and
        info["intervention_receipt"] is the first of them, for callers that read one. The
        "sigma0_proximity" and "anti_collapse_p" floats are the largest over the rows, so each is
        above 0 exactly when some row was in the gate or was excited; the "_per_sample" entries
        hold one value per row. An anti-collapse operator whose proximity() returns one number is
        batch-wide: every row gets that number, and excite() is called with one number per distinct
        effective proximity among the rows that fired, so a spook still lifts only its own row. Its
        outputs may broadcast; they are applied to the fired rows only.

        A trajectory whose state, covariance or drift Jacobian holds a NaN or inf is broken, and no
        operator acts on it. The Σ₀ gate never fires on it, since each of its four signals reads NaN,
        which is below no threshold, and neither a spook nor a batch-wide proximity can select it.
        Its values carry forward as the plain step computes them, with its Σ passed through
        unprojected (CovarianceField._project_psd). A row whose inputs are finite but whose
        covariance step overflows is not excited either, and its receipt says why. The batched SVDs
        and eigendecompositions never see a broken row, so it cannot make them raise for the other
        rows or feed its values into theirs. Nor does an attached SurpriseMonitor's batched Cholesky:
        the monitor does not score a row whose belief (last step's prediction) or observed state holds
        a NaN or inf, and a broken Σ or Jacobian reaches the belief through the next prediction. Such
        a row's NIS reads NaN, so it never spooks, its belief passes through the update unchanged, and
        it stays out of info["surprise_nis"] (NaN when no row was scored) and of the monitor's rolling
        mean. What this does not cover: a finite row whose S is not positive definite still makes
        that Cholesky raise for every row.

        `noise` is ξ, one standard normal per coordinate, and dW and the kick share it. The kick
        reads it in x's dtype, so float32 noise drives a float64 model (rollout draws float32 and
        casts it to x's dtype; see rollout).
        """
        node = self.graph.active
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
        A = drift_jacobian(node, x.detach(), u.detach())
        q_diag = (g.detach() ** 2)
        sigma_next = self.cov.step(sigma, A, q_diag, dt)

        info = {"u": u, "f": f, "g": g, "dilation": dilation.squeeze(-1),
                "collapse": None, "anti_collapse_p": 0.0, "sigma0_proximity": 0.0,
                "surprise_spook": False}

        # Every Σ₀ quantity below is one value per trajectory (row).
        bsz, dev = x.shape[0], x.device
        # A Σ given once for the batch, (1, d, d) or (d, d), is every row's: the receipts index it by row.
        sigma_rows = torch.broadcast_to(sigma, (bsz, d, d))
        # A row whose state, covariance or Jacobian is not finite is broken, and no operator acts on it,
        # whatever a spook or a batch-wide proximity says of it. (The shipped gate never fires on one.)
        finite_in = (torch.isfinite(x).all(dim=-1) & torch.isfinite(sigma_rows).flatten(-2).all(dim=-1)
                     & torch.isfinite(A).flatten(-2).all(dim=-1))
        lost = torch.zeros(bsz, dtype=torch.bool, device=dev)    # fired, but its covariance step overflowed
        spook = torch.zeros(bsz, dtype=torch.bool, device=dev)     # the row's NIS spook
        boost = torch.zeros(bsz, dtype=x.dtype, device=dev)        # a spook lifts the row's proximity to 1
        prox = torch.zeros(bsz, dtype=x.dtype, device=dev)         # the row's structural proximity
        excited = torch.zeros(bsz, dtype=torch.bool, device=dev)
        overwritten = torch.zeros(bsz, dtype=torch.bool, device=dev)
        receipts: List[Optional[InterventionReceipt]] = [None] * bsz

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
                spook = (torch.as_tensor(surprise_result["spook"], device=dev)
                         .to(torch.bool).reshape(-1).expand(bsz))
                info["surprise_spook"] = bool(spook.any())
                nis_mean = scored_mean(surprise_result["nis"])     # a row the monitor did not score has no say
                info["surprise_nis"] = math.nan if nis_mean is None else nis_mean
                if self.surprise_monitor.anti_collapse_trigger:
                    # A spook lifts THAT trajectory's anti-collapse proximity to 1.0 (detect → excite).
                    boost = spook.to(x.dtype)
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
        
        def receipt(i: int, kind: str, source: str, reason: str, spooked: bool) -> InterventionReceipt:
            """Row i's record, read after the mutations above it (x_next and sigma_next are late-bound)."""
            return InterventionReceipt(
                step=step, kind=kind, trigger_source=source, sigma0_proximity=float(prox[i]),
                surprise_spook=spooked,
                pre_x_norm=float(x[i].detach().norm()), post_x_norm=float(x_next[i].detach().norm()),
                pre_sigma_tr=float(torch.diagonal(sigma_rows[i].detach()).sum()),
                post_sigma_tr=float(torch.diagonal(sigma_next[i].detach()).sum()),
                policy_reason=reason, sample=i,
            )

        # Σ₀⁻¹ anti-collapse: inject excitation along null modes to escape an
        # imminent 42-state. On the rows where it fires it SUPPRESSES the Σ₀ freeze this
        # step (the whole point is to prevent collapse, not freeze into it).
        effective = prox
        if self.anti_collapse_op is not None:
            raw = self.anti_collapse_op.proximity(self, x, u, sigma, A)
            batch_wide = not (isinstance(raw, Tensor) and raw.dim() > 0)
            prox = torch.as_tensor(raw, dtype=x.dtype, device=dev).detach().reshape(-1).expand(bsz)
            effective = torch.maximum(prox, boost)
            info["sigma0_proximity"] = float(prox.max()) if bsz else 0.0

            hot = (effective > 0.0) & finite_in
            if bool(hot.any()):
                excited = hot & self._budget_open(bsz, dev)
                idx = excited.nonzero().flatten()
                if idx.numel():
                    # dW and the kick share ξ, so their signs interact. Lemma S1 needs
                    # D = diag(g·dilation·√dt) PSD on every kicked row, not merely g ≥ 0: at D = −κ/2 the
                    # escape probability falls to 0.40, and a caller-supplied initial Σ can make dilation
                    # negative before projection. A subclass can break this, and so can a gain shared by
                    # all rows, shape (d,). With strength 0 there is no state kick to protect.
                    if getattr(self.anti_collapse_op, "strength", 1.0) > 0.0:
                        gain = torch.broadcast_to(g * dilation, x.shape)[idx]
                        if not bool(torch.isfinite(gain).all()) or bool((gain < 0).any()):
                            raise ValueError(
                                "the anti-collapse kick needs a finite non-negative diffusion gain after dilation"
                            )
                    # Theorem C3's hypothesis: the floor correction after a scale-down costs at most
                    # ½√(d/(d−1))·ρ of anisotropy, which LIFT_MARGIN covers only while ρ ≤ RHO_MAX.
                    rho_max = getattr(self.anti_collapse_op, "RHO_MAX", None)
                    if rho_max is not None and d >= 2:
                        rho = d * self.cov.eps / self.cov.sigma_max
                        if rho > rho_max:
                            raise ValueError(
                                f"the covariance lift needs d*eps/sigma_max <= {rho_max:g} "
                                f"(Theorem C3); got {rho:.3g}. Raise sigma_max or lower eps."
                            )
                    # A row whose covariance step overflowed (finite inputs, Σ_next not) has no spectrum
                    # to lift, so it is not excited. This comes after the gain guard, which still checks
                    # every row the kick was about to touch.
                    overflowed = ~torch.isfinite(sigma_next[idx]).flatten(-2).all(dim=-1)
                    if bool(overflowed.any()):
                        lost[idx[overflowed]] = True
                        excited = excited & ~lost
                        idx = idx[~overflowed]
                if idx.numel():
                    # An operator with one proximity for the batch gets one number per call, so rows
                    # at different effective proximities (a spook lifts only its own row) get their own.
                    calls = ([(float(v), idx[effective[idx] == v]) for v in torch.unique(effective[idx])]
                             if batch_wide else [(effective[idx], idx)])
                    xi = noise.to(x.dtype)       # the kick's ξ in the state's dtype: exact for float32 → float64
                    for p_fired, rows in calls:
                        dx_extra, sig_extra = self.anti_collapse_op.excite(
                            x[rows], sigma_next[rows], A[rows], p_fired, xi[rows])
                        dx_extra = torch.broadcast_to(
                            torch.as_tensor(dx_extra, dtype=x_next.dtype, device=dev), x[rows].shape)
                        x_next = x_next.index_add(0, rows, dx_extra)
                        sigma_next = sigma_next.index_copy(
                            0, rows, self.cov.project_preserving_shape(sigma_next[rows] + sig_extra))
                    self._intervention_counts[idx] += 1
                    info["anti_collapse_p"] = float(effective[idx].max())
                for i in hot.nonzero().flatten().tolist():
                    source = ("both" if boost[i] > 0 and prox[i] > 0
                              else "surprise" if boost[i] >= prox[i] else "structural")
                    kind, reason = (("excite", "budget_ok: anti-collapse excite fired") if excited[i]
                                    else ("blocked", "not finite after the step: its covariance holds a NaN or inf")
                                    if lost[i] else self._held(i))
                    receipts[i] = receipt(i, kind, source, reason, bool(boost[i] > 0))
        info["sigma0_proximity_per_sample"] = prox
        info["anti_collapse_fired"] = excited
        info["anti_collapse_p_per_sample"] = torch.where(excited, effective, torch.zeros_like(effective))

        # Σ₀ gating: dx = f dt + dW − Σ₀(x,Σ,G,u). When a trajectory is underdetermined,
        # freeze it onto its minimal invariant attractor. The rows just excited are skipped.
        if self.collapse_op is not None and not bool(excited.all()):
            res = self.collapse_op.evaluate(self, x, u, sigma, A)
            if res.triggered:
                mask = getattr(res, "mask", None)    # a result without one speaks for every row
                hit = (torch.ones(bsz, dtype=torch.bool, device=dev) if mask is None
                       else torch.as_tensor(mask, device=dev).to(torch.bool).reshape(-1).expand(bsz))
                hit = hit & ~excited & finite_in
                if bool(hit.any()):
                    overwritten = hit & self._budget_open(bsz, dev)
                    if bool(overwritten.any()):
                        x_next = torch.where(overwritten.unsqueeze(-1), res.x_star.to(x_next.dtype), x_next)
                        sigma_next = torch.where(overwritten.view(-1, 1, 1), sigma, sigma_next)
                        self._intervention_counts[overwritten] += 1
                        info["collapse"] = res
                    for i in hit.nonzero().flatten().tolist():
                        kind, reason = (("project_to_attractor", "budget_ok: collapse projected to attractor")
                                        if overwritten[i] else self._held(i))
                        receipts[i] = receipt(i, kind, "collapse_trigger", reason, bool(spook[i]))
        info["collapse_mask"] = overwritten

        info["intervention_receipts"] = [r for r in receipts if r is not None]
        info["intervention_receipt"] = (info["intervention_receipts"][0]
                                        if info["intervention_receipts"] else None)
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
            accumulate_cost: bool = False
            ) -> Tuple[Tensor, Tensor, Trace]:
    """
    Deterministic, replayable rollout.

    Noise at step t is drawn from a generator seeded by (base_seed + t), so two
    rollouts with the same base_seed produce identical trajectories — this is
    what makes the trace replayable (invariant 2).

    The draw is float32 in every dtype, then cast to x's dtype. A float32 run is what it always
    was. A float64 run gets those same float32 values, exactly (float32 → float64 is exact), so
    one that never reaches the kick is unchanged bit for bit: the float64 arithmetic of dW
    already promoted them. The shipped kick multiplies ξ by a float64 projector and used to raise
    on the dtype mismatch; it now runs. (An operator of your own whose excite computes with ξ now
    gets it in float64 rather than float32.) Drawing in float64 instead would change every
    float64 trajectory. In float64, ξ keeps float32's resolution.

    If accumulate_cost=True, trace.running_cost holds the differentiable
    trajectory-integrated stage cost  Σ_t L(x_t, u_t) · dt  — the optimal-control
    objective ∫L dt used for training.
    """
    x, sigma = x0, sigma0
    trace = Trace(base_seed=base_seed, dt=dt)
    swap_schedule = swap_schedule or {}
    device = x0.device
    running = torch.zeros((), device=device)
    model.reset_intervention_count()

    for t in range(steps):
        gen = torch.Generator(device=device)
        gen.manual_seed(base_seed + t)
        noise = torch.randn(x.shape, generator=gen, device=device).to(x.dtype)   # float32 draw: see above

        if t in swap_schedule:
            with torch.no_grad():
                u_probe = model.pcsf(x, sigma)
            rec = model.graph.hot_swap(swap_schedule[t], x.detach(), u_probe, t)
            trace.swaps.append(rec)

        x_next, sigma_next, info = model.forward_step(x, sigma, dt, noise, step=t)

        if info.get("collapse") is not None:
            # one entry per step with an overwrite; `samples` are the rows it overwrote
            trace.collapses.append({"step": t, "result": info["collapse"],
                                    "samples": info["collapse_mask"].nonzero().flatten().tolist()})

        trace.interventions.extend(info.get("intervention_receipts", []))   # one per row that fired

        if accumulate_cost:
            running = running + model.stage_cost(x, info["u"]).mean() * dt

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
