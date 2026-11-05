"""Tests for the Question Machine — bidirectional consolidation of the CIO loop.

See src/cio_sde/question.py and docs/research/question-machine.md.

The five claims:
  1. backward_costate computes the TRUE end-back gradient (adjoint == finite-difference).
  2. forward-backward consolidation drives the seam ‖∂H/∂u‖ → 0 (finds the safe passage).
  3. a perturbation localizes the top question to the perturbed step.
  4. coherent ≠ correct: at the consolidated optimum questions ≈ 0, but an external
     terminal anchor that contradicts reopens the question (grounding revives it).
  5. NAP overrides CAP: a channel CAP allows but NAP denies is inadmissible; ask() routes
     to the next admissible question.
"""
import pytest

torch = pytest.importorskip("torch")

from src.cio_sde import (
    CIO_SDE, LinearDynamics, QuestionMachine,
    forward_states, backward_costate, dynamics_defect, reconcile,
)


def _linear_model(A, B=None, dim=2, ctrl=2, double=False):
    node = LinearDynamics(A, B=B if B is not None else torch.eye(dim))
    m = CIO_SDE(dim=dim, ctrl_dim=ctrl, hidden=4)
    if double:
        m = m.double()
        node = node.double()
    m.graph.active = node
    return m


# ── 1. the end-back pass is a correct gradient (adjoint == finite difference) ──

def test_backward_costate_matches_finite_difference():
    """The costate sweep computes ∂J/∂u_t exactly: adjoint gradient == central difference
    of J = Σ_t L(x_t,u_t)·dt + ‖x_T − goal‖² over the forward rollout."""
    A = torch.tensor([[-0.5, 0.3], [-0.2, -0.6]])
    m = _linear_model(A, B=torch.eye(2), double=True)
    dt = 0.1
    T = 5
    x0 = torch.tensor([[1.0, -0.5]], dtype=torch.float64)
    goal = torch.tensor([[0.2, 0.1]], dtype=torch.float64)
    us = [torch.tensor([[0.3 * (t % 2) - 0.1, 0.05 * t]], dtype=torch.float64) for t in range(T)]

    def J(u_list):
        xs = forward_states(m, x0, u_list, dt)
        run = sum(m.stage_cost(xs[t], u_list[t]).sum() * dt for t in range(T))
        return run + ((xs[-1] - goal) ** 2).sum()

    xs = forward_states(m, x0, us, dt)
    _, grads = backward_costate(m, xs, us, dt, terminal_lambda=2 * (xs[-1] - goal))

    eps = 1e-6
    for t in range(T):
        for j in range(2):
            up = [u.clone() for u in us]; up[t] = up[t].clone(); up[t][0, j] += eps
            um = [u.clone() for u in us]; um[t] = um[t].clone(); um[t][0, j] -= eps
            fd = (J(up) - J(um)) / (2 * eps)
            assert grads[t][0, j].item() == pytest.approx(fd.item(), rel=1e-4, abs=1e-6)


# ── 2. consolidation finds the safe passage (seam → 0) ───────────────────────

def _converge(seed=0):
    torch.manual_seed(seed)
    A = torch.tensor([[-0.5, 0.2], [-0.1, -0.4]])
    m = _linear_model(A, B=torch.eye(2))
    dt, T = 0.1, 8
    x0 = torch.tensor([[1.0, -0.8]])
    goal = torch.zeros(1, 2)
    qm = QuestionMachine()
    us0 = [torch.zeros(1, 2) for _ in range(T)]
    res = qm.consolidate(m, x0, us0, dt, terminal_grad=lambda xT: 2 * (xT - goal),
                         iterations=600, lr=0.05)
    return m, qm, x0, goal, dt, res


def test_consolidation_drives_seam_toward_zero():
    _, _, _, _, _, res = _converge()
    assert res.max_score_history[0] > res.max_score_history[-1]     # the seam descended
    assert res.max_score < 0.1 * res.max_score_history[0]           # converged on the safe passage


# ── 3. a break reopens the seam (incl. at the break site) ────────────────────

def test_perturbation_reopens_seam():
    """Consolidation closes the seams (all scores ≈ 0). A disturbance at step k reopens
    the question — both globally and at k specifically.

    NOTE the honest physics: the *global* top question front-loads to the earliest
    high-leverage step, not necessarily k — early controls have more authority over the
    terminal. So we assert the seam at k opens, not that k is the argmax (which it isn't)."""
    m, qm, x0, goal, dt, res = _converge(seed=1)
    k = 3
    us_pert = [u.clone() for u in res.us]
    us_pert[k] = us_pert[k] + torch.tensor([[0.6, -0.6]])           # break the path at step k
    res2 = qm.consolidate(m, x0, us_pert, dt, terminal_grad=lambda xT: 2 * (xT - goal),
                          iterations=0)
    assert res2.scores[k] > 20 * res.scores[k]                     # the seam at k jumps sharply (~85×)
    assert res2.scores[k] > res.max_score                         # …exceeding the whole consolidated profile
    rank = sorted(range(len(res2.scores)), key=lambda i: res2.scores[i], reverse=True)
    assert k in rank[:2]                                          # k is a top question (step 0 leads on leverage)


# ── 4. coherent ≠ correct: external grounding reopens the question ───────────

def test_grounding_revives_question():
    m, qm, x0, goal_A, dt, res = _converge(seed=2)
    coherent = res.max_score
    assert coherent < 0.05                                          # internally: ~no questions left
    goal_B = torch.tensor([[2.0, -2.0]])                           # external reality: the goal was elsewhere
    res_b = qm.consolidate(m, x0, res.us, dt, terminal_grad=lambda xT: 2 * (xT - goal_B),
                           iterations=0)
    assert res_b.max_score > 10 * max(coherent, 1e-6)              # grounding revived the question


# ── 5. NAP overrides CAP (denials win) ───────────────────────────────────────

def test_nap_overrides_cap():
    from src.convergence_io import (
        CapabilityGate, CapabilityClaim, AuthorityGate, NegativeAuthorityProfile,
    )
    m, qm0, x0, goal, dt, res = _converge(seed=3)
    # a trajectory with a live seam on both dims so there's a real "next best"
    us_pert = [u + torch.tensor([[0.4, 0.3]]) for u in res.us]
    res = qm0.consolidate(m, x0, us_pert, dt, terminal_grad=lambda xT: 2 * (xT - goal),
                          iterations=0)

    channels = {0: "ask_human", 1: "web_search"}
    cap = CapabilityGate(honesty_floor=0.0)
    cap.register_claim(CapabilityClaim(agent_id="qm", provider_id="local",
                                       capabilities={"ask_human", "web_search"},
                                       boundary="local"))
    nap = AuthorityGate()
    qm = QuestionMachine(capability_gate=cap, authority_gate=nap, channels=channels, agent_id="qm")

    top = qm.ask(res, top_k=1)[0]                                  # empty NAP → top admissible
    denied_channel = top.channel
    assert cap.check("qm", {denied_channel}).allowed              # CAP alone WOULD allow it

    nap.add_profile(NegativeAuthorityProfile(profile_id="deny-top",
                                             denied_actions={denied_channel}, reason="test floor"))
    gated = qm.ask(res, top_k=1)[0]
    assert gated.channel != denied_channel                        # NAP overrode CAP — routed around
    assert gated.admissible


# ── 6. CAP/NAP bind the plan, not just the questions ──
class _DenyChannel:
    """Minimal NAP stand-in: denies exactly one channel."""

    def __init__(self, channel):
        self.channel = channel

    def check(self, action_type, tier=None):
        return type("R", (), {"denied": action_type == self.channel, "reason": "test"})()


def _plan(qm, iterations=100, u0=None, goal=(1.0, 1.0), m=None):
    m = m or _linear_model(torch.zeros(2, 2))
    x0 = torch.zeros(1, 2)
    target = torch.tensor([list(goal)])
    us = [(u0 if u0 is not None else torch.zeros(1, 2)).clone() for _ in range(10)]
    return m, x0, target, qm.consolidate(m, x0, us, 0.1, iterations=iterations, lr=3.0,
                                         terminal_grad=lambda xT: 2 * (xT - target))


def test_denied_control_is_never_planned():
    qm = QuestionMachine(authority_gate=_DenyChannel("forbidden"), channels={0: "ok", 1: "forbidden"})
    _, _, _, res = _plan(qm)
    assert sum(float(u[0, 1].abs()) for u in res.us) == 0.0     # the denied dim never moves
    assert sum(float(u[0, 0].abs()) for u in res.us) > 0.1      # the allowed one does
    assert float(res.xs[-1][0, 1]) == 0.0                       # x_T describes the plan it may run


def test_denied_control_is_forced_to_zero_even_if_supplied():
    qm = QuestionMachine(authority_gate=_DenyChannel("forbidden"), channels={0: "ok", 1: "forbidden"})
    _, _, _, res = _plan(qm, iterations=0, u0=torch.tensor([[0.2, 0.7]]))
    assert all(float(u[0, 1]) == 0.0 for u in res.us)


def test_a_denial_is_not_disagreement():
    """The seam converges on what is allowed. The pull toward the denied action is real, and is
    reported as pressure, not as a question to go and resolve."""
    qm = QuestionMachine(authority_gate=_DenyChannel("forbidden"), channels={0: "ok", 1: "forbidden"})
    _, _, _, res = _plan(qm)
    assert res.max_score < 1e-3
    assert max(res.blocked_pressure) > 0.05
    assert all(q.dim == 0 for q in qm.ask(res, top_k=3))


def test_unrestricted_machine_is_unchanged_by_the_mask():
    _, _, _, res = _plan(QuestionMachine())
    assert res.blocked_pressure == [0.0] * 10
    assert sum(float(u[0, 1].abs()) for u in res.us) > 0.1


# ── 7. uncertainty actually steers the question ──
def test_ask_follows_the_uncertainty_weighted_score():
    m = _linear_model(torch.zeros(2, 2))
    qm = QuestionMachine()
    sigmas = [torch.eye(2).unsqueeze(0) * (1e6 if t == 3 else 1e-6) for t in range(5)]
    us = [torch.zeros(1, 2) for _ in range(5)]
    goal = torch.tensor([[1.0, 1.0]])
    res = qm.consolidate(m, torch.zeros(1, 2), us, 0.1, sigmas=sigmas,
                         terminal_grad=lambda xT: 2 * (xT - goal))
    top = qm.ask(res, top_k=1)[0]
    assert res.scores.index(max(res.scores)) == 3
    assert top.step == 3
    assert top.uncertainty == pytest.approx(2e6)
    assert top.to_record()["evidence"]["uncertainty"] == pytest.approx(2e6)
    # the seam itself stays the raw disagreement; uncertainty is only the priority
    assert top.score == pytest.approx(float(res.grads[3].abs().mean(dim=0).max()))


# ── 8. convergence means contact with reality ──
def test_the_seam_cannot_see_a_wrong_model_but_the_defect_can():
    m, x0, goal, res = _plan(QuestionMachine())
    assert res.max_score < 1e-3                                 # internally: nothing left to ask
    # reality: the control acts with the opposite sign
    real = [x0]
    for u in res.us:
        real.append(real[-1] - u * 0.1)
    assert float((real[-1] - goal).norm()) > 1.0                # and it is badly wrong
    defects = dynamics_defect(m, real, res.us, 0.1)
    assert max(defects) > 0.01
    assert reconcile(res, defects).action == "revise_model"

    honest = forward_states(m, x0, res.us, 0.1)                 # reality matches the model
    assert max(dynamics_defect(m, honest, res.us, 0.1)) < 1e-6
    assert reconcile(res, dynamics_defect(m, honest, res.us, 0.1)).action == "act"


def test_the_verdict_does_not_depend_on_the_step_size():
    """g_t carries a factor of dt, so at dt=1e-3 a plan 4 away from its goal read as stationary."""
    goal = torch.tensor([[4.0, 0.0]])
    for dt in (0.1, 0.01, 0.001):
        m = _linear_model(torch.zeros(2, 2))
        res = QuestionMachine().consolidate(m, torch.zeros(1, 2), [torch.zeros(1, 2) for _ in range(8)],
                                            dt, terminal_grad=lambda xT: 2 * (xT - goal))
        verdict = reconcile(res, [0.0])
        assert verdict.action == "replan", dt
        assert verdict.seam == pytest.approx(8.0)                # ‖∂H/∂u‖ = 2·gap, whatever the dt


def test_a_wrong_model_is_caught_at_small_steps():
    """The defect shrinks with dt as well: a drift wrong by 5·x read as no defect at dt=1e-3."""
    A = -0.2 * torch.eye(4)
    us = [torch.zeros(1, 4) for _ in range(20)]
    for dt in (0.1, 0.001, 0.0001):
        m = _linear_model(A, B=torch.eye(4), dim=4, ctrl=4)
        real = [torch.ones(1, 4)]
        for u in us:
            real.append(real[-1] + (real[-1] @ (A + 5.0 * torch.eye(4)).T) * dt)
        res = QuestionMachine().consolidate(m, real[0], us, dt)
        assert reconcile(res, dynamics_defect(m, real, us, dt)).action == "revise_model", dt


def test_one_bad_sample_is_a_model_failure():
    """Averaging over the batch read a 0.7-per-unit-time miss on one sample in eight as fine."""
    m = _linear_model(torch.zeros(2, 2))
    xs = [torch.zeros(8, 2), torch.zeros(8, 2)]
    xs[1][0, 0] = 0.07
    us = [torch.zeros(8, 2)]
    assert dynamics_defect(m, xs, us, 0.1) == [pytest.approx(0.07)]
    assert reconcile(QuestionMachine().consolidate(m, xs[0], us, 0.1),
                     dynamics_defect(m, xs, us, 0.1)).action == "revise_model"


def test_thin_evidence_is_not_a_reason_to_replan():
    """The question score is weighted by 1+tr Σ, to rank questions. Used as the seam, it turned a
    stationary plan with high uncertainty into "replan" when it needs evidence."""
    m = _linear_model(torch.zeros(2, 2))
    goal = torch.tensor([[1.0, 0.0]])
    sigmas = [2500.0 * torch.eye(2).unsqueeze(0) for _ in range(8)]
    res = QuestionMachine().consolidate(m, torch.zeros(1, 2), [torch.zeros(1, 2) for _ in range(8)], 0.1,
                                        terminal_grad=lambda xT: 2 * (xT - goal),
                                        iterations=100, lr=3.0, sigmas=sigmas)
    assert res.max_score > res.max_score_history[-1]             # the weight is really there
    assert reconcile(res, [0.0]).action == "gather_evidence"


def test_a_plan_never_exceeds_the_engines_clamp():
    """The engine clamps u at pcsf.u_max. A plan past it describes something that cannot happen."""
    m = _linear_model(torch.zeros(2, 2))
    assert m.pcsf.u_max == 5.0
    goal = torch.tensor([[100.0, 0.0]])
    res = QuestionMachine().consolidate(m, torch.zeros(1, 2), [torch.tensor([[50.0, 0.0]]) for _ in range(8)],
                                        0.1, terminal_grad=lambda xT: 2 * (xT - goal),
                                        iterations=20, lr=0.2)
    assert max(float(u.abs().max()) for u in res.us) == pytest.approx(5.0)
    assert float(res.xs[-1][0, 0]) == pytest.approx(4.0)         # the most that 8 × 0.1 × 5 can reach
    assert res.max_score_history[-1] < 1e-3                      # nothing left the plan is free to do
    verdict = reconcile(res, [0.0])
    assert verdict.action == "blocked" and verdict.blocked > 1.0


def test_a_control_at_the_clamp_can_still_come_back():
    """A dim is blocked only while the descent pushes it outward. Pointing inward, it is free."""
    m = _linear_model(torch.zeros(2, 2))
    goal = torch.tensor([[0.0, 0.0]])
    res = QuestionMachine().consolidate(m, torch.zeros(1, 2), [torch.full((1, 2), 5.0) for _ in range(8)],
                                        0.1, terminal_grad=lambda xT: 2 * (xT - goal),
                                        iterations=100, lr=3.0)
    assert max(float(u.abs().max()) for u in res.us) < 0.05
    assert max(res.blocked_pressure) == 0.0


def test_a_fully_denied_plan_is_not_a_reason_to_act():
    """Every control denied: the plan cannot move, the seam reads 0, and this said "act"."""
    qm = QuestionMachine(authority_gate=_DenyChannel("probe"))
    m, x0, goal, res = _plan(qm, iterations=50)
    assert res.max_score == 0.0 and float(res.xs[-1].abs().max()) == 0.0
    verdict = reconcile(res, [0.0])
    assert verdict.action == "blocked"
    assert verdict.seam == 0.0 and verdict.blocked > 1.0


def test_a_partial_denial_that_costs_nothing_can_still_act():
    """Denied, but nothing pulls on that dim: the constraint is not in the way."""
    qm = QuestionMachine(authority_gate=_DenyChannel("forbidden"), channels={0: "ok", 1: "forbidden"})
    _, _, _, res = _plan(qm, goal=(1.0, 0.0))
    assert reconcile(res, [0.0]).action == "act"


def test_a_nan_signal_never_reads_as_fine():
    _, _, _, settled = _plan(QuestionMachine())
    assert reconcile(settled, [0.0, float("nan")]).action == "revise_model"
    assert reconcile(settled, [float("nan"), 0.0]).action == "revise_model"


@pytest.mark.parametrize("states", [1, 2, 4])
def test_a_trajectory_that_does_not_match_its_controls_is_refused(states):
    """Two controls need three states. Anything else means the evidence is not what it claims."""
    m = _linear_model(torch.zeros(2, 2))
    with pytest.raises(ValueError, match="observed states"):
        dynamics_defect(m, [torch.zeros(1, 2)] * states, [torch.zeros(1, 2)] * 2, 0.1)


def test_reconcile_routes_each_case():
    _, _, _, settled = _plan(QuestionMachine())
    _, _, _, unsettled = _plan(QuestionMachine(), iterations=0)
    assert unsettled.max_score > 0.01
    ok = [0.0]
    assert reconcile(settled).action == "gather_evidence"       # dynamics never observed
    assert reconcile(settled, [1.0]).action == "revise_model"
    assert reconcile(unsettled, [1.0]).action == "revise_model"  # the model outranks the seam
    assert reconcile(unsettled, ok).action == "replan"
    assert reconcile(settled, ok, unresolved=2).action == "gather_evidence"
    assert reconcile(settled, ok).action == "act"
    settled.uncertainty = [50.0]
    assert reconcile(settled, ok).action == "gather_evidence"   # agreement on thin evidence
    assert reconcile(settled, ok, uncertainty_tol=100.0).action == "act"
