"""
The Question Machine — bidirectional consolidation of the convergence loop.

Deep Thought computed the Answer (42); the machine it then built — the Earth — was a
*question-finder*. This module is the question-finder for the CIO loop: it runs the loop
**both ways** and consolidates them.

    beginning → forward   the predict pass: state x rolls forward under the drift f
                          (Observe → Reason → Act). "Where the Question is heading."
    end → backward        the adjoint/costate pass: λ_t = ∂J/∂x_t flows BACK from a
                          terminal condition (Pontryagin / backprop-through-time /
                          the Kalman smoother). "The Answer, seen from each moment."
    consolidate           the Hamiltonian stationarity ∂H/∂u = 0 is where the two
                          passes meet — the two-point boundary value problem, the
                          certificate's "safe passage" (SIGMA0-COLLAPSE-CERTIFICATE §5).

The **question** at step t is the seam disagreement ‖∂H/∂u_t‖ = ‖g_t‖: how far the
forward choice is from what the backward objective demands. Large ‖g_t‖ = "this is the
moment I most need to resolve." The machine surfaces the highest-leverage question it is
both ABLE (CAP — CapabilityGate) and ALLOWED (NAP — AuthorityGate, denials override) to
ask — and emits it as a convergence record [hypothesis, evidence, confidence, source].

HONESTY (the higher-order collapse, SIGMA0-C3): when forward and backward AGREE the
question score → 0 — but two mirrors agreeing can be *jointly wrong*. Consolidation makes
the trajectory COHERENT, not CORRECT. A near-zero question score means "internally I have
nothing left to ask," which is exactly the dead 42-state if the loop is ungrounded. The
escape is an EXTERNAL terminal condition (a real goal / observation): grounding reopens
the question. `consolidate(...)` is internal; `ask(...)`'s output is a hypothesis to be
externally verified, never an answer.

An external TERMINAL condition grounds the goal, not the model: the whole backward pass runs
through the system's own f, so the seam reaches 0 on a wrong model just as readily. That is what
`dynamics_defect` checks, against observed transitions, and `reconcile` turns the signals into
the next step: revise the model, re-plan, report that the way forward is blocked, gather evidence,
or act.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import torch

from .engine import CIO_SDE, Dynamics, drift_jacobian

Tensor = torch.Tensor


# ── forward pass (beginning → forward) ───────────────────────────────────────

def forward_states(model: CIO_SDE, x0: Tensor, us: Sequence[Tensor],
                   dt: float) -> List[Tensor]:
    """Deterministic, control-driven rollout x_{t+1} = x_t + f(x_t,u_t)·dt.

    The noise-free dynamics the adjoint differentiates — the "what will happen if I apply
    this control sequence" prediction. Returns [x_0, …, x_T] (T = len(us))."""
    node = model.graph.active
    xs = [x0]
    x = x0
    for u in us:
        x = x + node.drift(x, u) * dt
        xs.append(x)
    return xs


def control_jacobian(node: Dynamics, x: Tensor, u: Tensor) -> Tensor:
    """B = ∂f/∂u, batched (B, d, m) — the control's leverage on the dynamics.

    The companion to engine.drift_jacobian (which gives A = ∂f/∂x)."""
    def f_single(xi: Tensor, ui: Tensor) -> Tensor:
        return node.drift(xi.unsqueeze(0), ui.unsqueeze(0)).squeeze(0)

    return torch.func.vmap(torch.func.jacrev(f_single, argnums=1))(x, u)


# ── backward pass (end → backward) ───────────────────────────────────────────

def backward_costate(model: CIO_SDE, xs: Sequence[Tensor], us: Sequence[Tensor],
                     dt: float,
                     terminal_lambda: Optional[Tensor] = None
                     ) -> Tuple[List[Tensor], List[Tensor]]:
    """The adjoint sweep — Pontryagin's costate run backward from the terminal condition.

        λ_T = terminal_lambda            (= ∇_x Φ(x_T); the "end", e.g. 2(x_T − goal))
        λ_t = ∇_x L_t·dt + (I + A_tᵀ·dt) λ_{t+1}
        g_t = ∇_u L_t·dt + dt·B_tᵀ λ_{t+1}        (g_t = ∂J/∂u_t = ∂H/∂u_t, the seam)

    `g_t` is EXACTLY the gradient of the total cost J = Σ_t L(x_t,u_t)·dt + Φ(x_T) w.r.t.
    u_t (machine-checked against finite differences). Returns (λ[0..T], g[0..T−1])."""
    node = model.graph.active
    T = len(us)
    B, d = xs[0].shape
    lams: List[Optional[Tensor]] = [None] * (T + 1)
    grads: List[Optional[Tensor]] = [None] * T
    lams[T] = (terminal_lambda if terminal_lambda is not None
               else torch.zeros(B, d, dtype=xs[0].dtype, device=xs[0].device))

    for t in reversed(range(T)):
        x_t = xs[t].detach().clone().requires_grad_(True)
        u_t = us[t].detach().clone().requires_grad_(True)
        L = model.stage_cost(x_t, u_t).sum()          # per-sample independent → grads stack
        gx, gu = torch.autograd.grad(L, [x_t, u_t])
        A = drift_jacobian(node, xs[t].detach(), us[t].detach())     # (B, d, d) = ∂f/∂x
        Bm = control_jacobian(node, xs[t].detach(), us[t].detach())  # (B, d, m) = ∂f/∂u
        lam_next = lams[t + 1]
        # (I + Aᵀ dt) λ_{t+1} :  Aᵀλ has components Σ_j A_{ji} λ_j
        at_lam = torch.einsum("bji,bj->bi", A, lam_next)
        lams[t] = gx * dt + lam_next + dt * at_lam
        # g_t = ∇_u L·dt + dt·Bᵀ λ_{t+1} :  (Bᵀλ)_j = Σ_i B_{ij} λ_i
        bt_lam = torch.einsum("bij,bi->bj", Bm, lam_next)
        grads[t] = gu * dt + dt * bt_lam

    return [l for l in lams], [g for g in grads]  # type: ignore[list-item]


def dynamics_defect(model: CIO_SDE, observed_xs: Sequence[Tensor], us: Sequence[Tensor],
                    dt: float) -> List[float]:
    """‖x_obs[t+1] − (x_obs[t] + f(x_obs[t],u_t)·dt)‖ per step, worst sample in the batch.

    How wrong the model was about what actually happened. The one signal here that contacts
    reality: the seam cannot see it, because both of its passes use the same f. Worst sample, not
    mean: a model that misses one sample in eight has still failed against reality.

    `us` must be the controls actually applied between those states. Scoring them against any other
    plan reports the difference between the plans as a model failure."""
    if len(observed_xs) != len(us) + 1:
        raise ValueError(f"{len(us)} controls need {len(us) + 1} observed states, got {len(observed_xs)}")
    node = model.graph.active
    defects: List[float] = []
    with torch.no_grad():
        for t, u in enumerate(us):
            predicted = observed_xs[t] + node.drift(observed_xs[t], u) * dt
            defects.append(float((observed_xs[t + 1] - predicted).norm(dim=-1).max().item()))
    return defects


# ── the question (a convergence record) ──────────────────────────────────────

@dataclass
class Question:
    """A surfaced question — shaped as a convergence record [hypothesis, evidence,
    confidence, source]. The hypothesis is *what to resolve*, not an answer."""
    step: int
    dim: int
    channel: str                 # the action_type / capability the question routes through
    score: float                 # ‖∂H/∂u‖ component — forward↔backward disagreement
    admissible: bool             # passed CAP (able) AND NAP (allowed)
    gate_reason: str = ""        # why inadmissible, if so
    uncertainty: float = 0.0     # tr(Σ_t) at this step, when covariance is supplied

    @property
    def hypothesis(self) -> str:
        return (f"resolve dim {self.dim} at step {self.step} via '{self.channel}' "
                f"(forward↔backward disagreement {self.score:.4g})")

    def to_record(self) -> Dict[str, object]:
        return {
            "hypothesis": self.hypothesis,
            "evidence": {"seam_disagreement": self.score, "uncertainty": self.uncertainty},
            "confidence": {"informativeness": self.score},
            "source": "forward-backward consolidation (cio_sde.question)",
            "channel": self.channel, "step": self.step, "dim": self.dim,
            "admissible": self.admissible, "gate_reason": self.gate_reason,
        }


@dataclass
class ConsolidationResult:
    """The consolidated trajectory + the seam between forward and backward."""
    us: List[Tensor]
    xs: List[Tensor]
    lams: List[Tensor]
    grads: List[Tensor]                 # g_t = ∂H/∂u_t per step
    scores: List[float]                 # ‖g_t‖ on ADMISSIBLE dims, per step — question scores
    iterations: int = 0
    max_score_history: List[float] = field(default_factory=list)  # max_t ‖g_t‖ on free dims, worst
                                        # sample, each iteration. Raw: no uncertainty weight.
    blocked_pressure: List[float] = field(default_factory=list)  # ‖g_t‖ on dims the plan may not move,
                                        # worst sample: CAP/NAP-blocked, or pressed against u_max.
                                        # What a denied action would be worth. Never a question.
    uncertainty: List[float] = field(default_factory=list)       # tr(Σ_t) per step, when supplied
    dt: float = 1.0                     # the step g_t was computed at: g_t = ∂H/∂u_t · dt

    @property
    def max_score(self) -> float:
        return max(self.scores) if self.scores else 0.0


@dataclass
class Reconciliation:
    """What to do next, and why. The reconcile step of the convergence loop."""
    action: str                  # revise_model | replan | blocked | gather_evidence | act
    reason: str
    seam: float                  # per unit time, like defect and blocked
    defect: Optional[float] = None
    uncertainty: Optional[float] = None
    blocked: Optional[float] = None


def _worst(values: Sequence[float]) -> float:
    """The largest value, or NaN if any is NaN: max() alone answers by argument order."""
    vals = list(values)                 # may be a generator
    return float("nan") if any(v != v for v in vals) else max(vals, default=0.0)


def reconcile(result: ConsolidationResult, defects: Optional[Sequence[float]] = None,
              unresolved: int = 0, seam_tol: float = 1e-2, defect_tol: float = 1e-2,
              uncertainty_tol: float = 1.0, covers_plan: bool = True) -> Reconciliation:
    """Turn the signals into one next step. Checked in this order because each later signal is
    only as good as the earlier ones: the seam is computed through the model, so a failed model
    makes it meaningless, and a clean plan on thin evidence is still thin.

        no observed transitions   gather_evidence   the model has never been checked
        defect > defect_tol       revise_model      the model failed against reality
        seam > seam_tol           replan            a better admissible action exists
        blocked > seam_tol        blocked           stationary only because the way on is denied
        not covers_plan           gather_evidence   the observations did not run this plan
        unresolved > 0            gather_evidence   named unknowns remain (e.g. blind dims)
        uncertainty > tol         gather_evidence   model and plan agree, on thin evidence
        otherwise                 act

    The seam, the blocked pressure and the defect are read per unit time, so the answer does not
    depend on dt: the raw g_t carries a factor of dt, and at dt=1e-3 a plan 4 away from its goal
    read as stationary. The seam is the unweighted one. `scores` multiply by 1+tr Σ to rank
    questions, and that would turn thin evidence into a false "replan".

    A NAP denial or the u_max clamp is a constraint, not a disagreement, so it stays out of the
    seam. It is still not "act": the plan is the best one allowed, and whoever holds the authority
    decides whether that is good enough.

    "act" means that none of these checks objects, which is less than it sounds. Nothing here
    checks that the plan reaches the goal: a goal dimension that no allowed control moves (zero
    control authority there) reads "act" with the gap unclosed. The defect is absolute, so a model
    tested only at small amplitude passes.

    The tolerances are the caller's: there is no calibrated default, and they should tighten
    for actions that are hard to reverse. defect_tol has to sit above measurement noise: a correct
    model with noise σ misses by about σ·√(d/dt) per unit time, and that reads as revise_model."""
    raw_seam = result.max_score_history[-1] if result.max_score_history else result.max_score
    seam = raw_seam / result.dt
    defect = _worst(defects) / result.dt if defects else None
    blocked = _worst(result.blocked_pressure) / result.dt
    spread = _worst(result.uncertainty) if result.uncertainty else None

    def out(action: str, reason: str) -> Reconciliation:
        return Reconciliation(action, reason, seam, defect, spread, blocked)

    if defect is None:
        return out("gather_evidence", "dynamics never checked against an observed transition")
    if not defect <= defect_tol:
        return out("revise_model", f"model missed an observed transition by {defect:.4g} per unit time")
    if not seam <= seam_tol:
        return out("replan", f"plan is not stationary: seam {seam:.4g}")
    if not blocked <= seam_tol:
        return out("blocked", f"plan is stationary only under a constraint: pressure {blocked:.4g}")
    if not covers_plan:
        return out("gather_evidence", "the observations were not taken under this plan")
    if unresolved > 0:
        return out("gather_evidence", f"{unresolved} unresolved unknowns")
    if spread is not None and not spread <= uncertainty_tol:
        return out("gather_evidence", f"model and plan agree, but tr(Σ) reaches {spread:.4g}")
    return out("act", "no check here objects: the model matched what it was tested on, the plan "
                      "is stationary, and nothing is unresolved")


# ── the machine ──────────────────────────────────────────────────────────────

class QuestionMachine:
    """Consolidates the forward (predict) and backward (adjoint) passes and surfaces the
    highest-leverage question it is both ABLE (CAP) and ALLOWED (NAP) to ask.

    CAP / NAP wiring (optional — both default to "permit", so the machine is usable bare):
      • capability_gate — a CCF `CapabilityGate`; a question's channel must be a claimed
        capability of `agent_id`. The positive authority (what it can do).
      • authority_gate  — a NAP `AuthorityGate`; if it denies the channel's action_type the
        question is inadmissible REGARDLESS of capability. The negative authority (override).
      • channels — maps a control dim → the action_type/capability string it routes through.
        Unmapped dims use `default_channel`.
    """

    def __init__(self,
                 capability_gate: Optional[object] = None,
                 authority_gate: Optional[object] = None,
                 channels: Optional[Dict[int, str]] = None,
                 agent_id: str = "question-machine",
                 default_channel: str = "probe") -> None:
        self.capability_gate = capability_gate
        self.authority_gate = authority_gate
        self.channels = channels or {}
        self.agent_id = agent_id
        self.default_channel = default_channel

    def _channel(self, dim: int) -> str:
        return self.channels.get(dim, self.default_channel)

    def _admissible_mask(self, like: Tensor, tier: Optional[str]) -> Tensor:
        """1 on control dims CAP and NAP both allow, 0 elsewhere. Same shape as one control."""
        mask = torch.ones_like(like)
        for j in range(like.shape[-1]):
            if not self._gate(self._channel(j), tier)[0]:
                mask[..., j] = 0.0
        return mask

    # ── consolidation: the two-point boundary value problem ──────────────────
    def consolidate(self, model: CIO_SDE, x0: Tensor, us: Sequence[Tensor], dt: float,
                    terminal_grad: Optional[Callable[[Tensor], Tensor]] = None,
                    iterations: int = 0, lr: float = 0.1,
                    sigmas: Optional[Sequence[Tensor]] = None,
                    tier: Optional[str] = None) -> ConsolidationResult:
        """Run forward, then backward, then (optionally) iterate the seam toward stationarity.

        `terminal_grad(x_T) -> λ_T` is the EXTERNAL anchor — the end condition the backward
        pass propagates (e.g. `lambda xT: 2*(xT - goal)`). None ⇒ λ_T = 0 (no external pull;
        the ungrounded case, where the consolidated trajectory has nothing to ask).

        `iterations > 0` performs forward-backward gradient descent on `us`
        (us ← us − lr·g): each step re-predicts forward and re-propagates backward, driving
        ‖∂H/∂u‖ → 0. That descent IS the search for the safe passage; at its fixed point the
        forward and backward passes agree (question score ≈ 0).

        CAP and NAP bind the plan as well as the questions: blocked control dims are held at
        zero and never descended on, so x_T and the seam describe a plan the system may actually
        carry out. So does the engine's hard clamp `pcsf.u_max` (Invariant 1): no plan exceeds it,
        and a dim pressed against it is blocked for as long as the descent pushes it outward. The
        gradient on a blocked dim stays nonzero at the constrained optimum, which is not
        disagreement, so `scores` exclude it and `blocked_pressure` reports it."""
        mask = self._admissible_mask(us[0], tier) if us else torch.ones(1)
        u_max = getattr(getattr(model, "pcsf", None), "u_max", None)
        us = [self._clamp(u.detach().clone() * mask, u_max) for u in us]
        history: List[float] = []
        xs: List[Tensor] = []
        lams: List[Tensor] = []
        grads: List[Tensor] = []

        for _ in range(max(iterations, 0) + 1):
            xs = forward_states(model, x0, us, dt)
            term = terminal_grad(xs[-1]) if terminal_grad is not None else None
            lams, grads = backward_costate(model, xs, us, dt, terminal_lambda=term)
            free = [self._free_mask(u, g, mask, u_max) for u, g in zip(us, grads)]
            allowed = [g * f for g, f in zip(grads, free)]
            history.append(_worst(float(g.norm(dim=-1).max().item()) for g in allowed))
            if iterations <= 0:
                break
            iterations_left = len(history) <= iterations
            if iterations_left:
                us = [self._clamp(u - lr * g, u_max) for u, g in zip(us, allowed)]

        scores = self._scores(allowed, sigmas)
        return ConsolidationResult(us=us, xs=xs, lams=lams, grads=grads, scores=scores,
                                   iterations=max(len(history) - 1, 0),
                                   max_score_history=history,
                                   blocked_pressure=[float((g * (1.0 - f)).norm(dim=-1).max().item())
                                                     for g, f in zip(grads, free)],
                                   uncertainty=self._uncertainty(sigmas), dt=dt)

    @staticmethod
    def _clamp(u: Tensor, u_max: Optional[float]) -> Tensor:
        return u if u_max is None else torch.clamp(u, -u_max, u_max)

    @staticmethod
    def _free_mask(u: Tensor, g: Tensor, mask: Tensor, u_max: Optional[float]) -> Tensor:
        """1 on dims the descent may still move: admissible, and not pushed out through u_max."""
        if u_max is None:
            return mask
        outward = ((u >= u_max) & (g < 0)) | ((u <= -u_max) & (g > 0))
        return mask * (~outward).to(mask.dtype)

    @staticmethod
    def _uncertainty(sigmas: Optional[Sequence[Tensor]]) -> List[float]:
        if sigmas is None:
            return []
        return [float(torch.diagonal(s, dim1=-2, dim2=-1).sum(-1).mean().item()) for s in sigmas]

    def _scores(self, grads: Sequence[Tensor],
                sigmas: Optional[Sequence[Tensor]]) -> List[float]:
        trace = self._uncertainty(sigmas)
        scores: List[float] = []
        for t, g in enumerate(grads):
            base = float(g.norm(dim=-1).mean().item())   # ‖∂H/∂u_t‖, mean over batch
            if t < len(trace):
                base = base * (1.0 + trace[t])            # weight by uncertainty (explore where unsure)
            scores.append(base)
        return scores

    # ── ask: surface the top admissible question ─────────────────────────────
    def ask(self, result: ConsolidationResult, top_k: int = 1,
            tier: Optional[str] = None) -> List[Question]:
        """Rank questions by seam disagreement weighted by uncertainty (the same weight as
        `scores`: explore where unsure), gate each through CAP then NAP (NAP overrides), and
        return the top_k ADMISSIBLE ones. Inadmissible candidates are skipped but their reason
        is recorded on the returned objects when surfaced."""
        # candidate (step, dim, magnitude) sorted by |g|·(1 + tr Σ_t) descending
        trace = result.uncertainty
        candidates: List[Tuple[int, int, float]] = []
        for t, g in enumerate(result.grads):
            mag = g.abs().mean(dim=0)                     # per-dim magnitude, mean over batch
            for j in range(mag.shape[-1]):
                candidates.append((t, j, float(mag[j].item())))
        tr_at = lambda t: trace[t] if t < len(trace) else 0.0
        candidates.sort(key=lambda c: c[2] * (1.0 + tr_at(c[0])), reverse=True)

        admitted: List[Question] = []
        for step, dim, mag in candidates:
            channel = self._channel(dim)
            ok, reason = self._gate(channel, tier)
            q = Question(step=step, dim=dim, channel=channel, score=mag,
                         admissible=ok, gate_reason=reason, uncertainty=tr_at(step))
            if ok:
                admitted.append(q)
            if len(admitted) >= top_k:
                break
        return admitted

    def _gate(self, channel: str, tier: Optional[str]) -> Tuple[bool, str]:
        """CAP (able) AND NAP (allowed). NAP denial overrides CAP — denials win."""
        # NAP first: a denial is final regardless of capability.
        if self.authority_gate is not None:
            res = self.authority_gate.check(action_type=channel, tier=tier)
            if getattr(res, "denied", False):
                return False, f"NAP denied '{channel}': {getattr(res, 'reason', '')}"
        # CAP: must be a claimed, verified capability.
        if self.capability_gate is not None:
            gate = self.capability_gate.check(self.agent_id, {channel}, tier=tier)
            if not getattr(gate, "allowed", False):
                return False, f"CAP blocked '{channel}': {getattr(gate, 'reason', '')}"
        return True, ""
