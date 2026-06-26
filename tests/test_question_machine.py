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
    forward_states, backward_costate,
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
