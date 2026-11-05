"""Tests for the grounded Question Loop — the Question Machine closed through channels.

See src/cio_sde/question_loop.py. These make the certificate's thesis executable:
  1. grounded (Oracle) → the loop DISCOVERS the true goal; the plan reaches it.
  2. ungrounded (Mirror) → internally coherent, but converges onto the WRONG goal (42-state).
  3. human-in-the-loop → a person, as a channel, grounds the machine to truth.
  4. NAP denial → the denied dimension is never asked: a permanent blind spot (safe + blind).
"""
import pytest

torch = pytest.importorskip("torch")

from src.cio_sde import (
    CIO_SDE, LinearDynamics, QuestionMachine, QuestionDrivenLoop,
    OracleChannel, MirrorChannel, HumanChannel, CorroboratedChannel, CallbackChannel,
    forward_states,
)


def _model(seed=0, dim=3):
    torch.manual_seed(seed)
    A = torch.tensor([[-0.4, 0.3, 0.0], [-0.2, -0.5, 0.2], [0.1, -0.1, -0.6]])
    node = LinearDynamics(A, B=torch.eye(dim))
    m = CIO_SDE(dim=dim, ctrl_dim=dim, hidden=4)
    m.graph.active = node
    return m


TRUE_GOAL = torch.tensor([[1.5, -1.0, 0.8]])


# ── 1. grounded reality → the loop discovers the true goal ───────────────────

def test_grounded_loop_discovers_true_goal():
    m = _model(seed=1)
    qm = QuestionMachine(channels={0: "oracle", 1: "oracle", 2: "oracle"})
    loop = QuestionDrivenLoop(m, qm, {"oracle": OracleChannel(TRUE_GOAL)},
                              x0=torch.tensor([[1.0, -0.8, 0.5]]), dt=0.1,
                              goal_belief=torch.zeros(1, 3), horizon=8)
    out = loop.run(max_steps=6, consolidate_iters=40, final_iters=400)

    assert torch.allclose(out.belief, TRUE_GOAL, atol=1e-5)        # belief → true goal (exact oracle)
    assert out.grounded == [0, 1, 2]                              # every dim grounded
    # the plan actually reaches the discovered goal, far closer than the ignorant start (0):
    assert (out.x_T - TRUE_GOAL).norm() < TRUE_GOAL.norm() * 0.5


# ── 2. ungrounded mirror → coherent but wrong (the 42-state) ─────────────────

def test_mirror_loop_is_coherent_but_wrong():
    m = _model(seed=2)
    qm = QuestionMachine(channels={0: "mirror", 1: "mirror", 2: "mirror"})
    loop = QuestionDrivenLoop(m, qm, {"mirror": MirrorChannel()},
                              x0=torch.tensor([[1.0, -0.8, 0.5]]), dt=0.1,
                              goal_belief=torch.zeros(1, 3), horizon=8)
    out = loop.run(max_steps=6, consolidate_iters=40, final_iters=400)

    assert torch.allclose(out.belief, torch.zeros(1, 3), atol=1e-6)   # never corrected
    assert out.final_seam < 0.1                                       # internally COHERENT
    assert (out.x_T - TRUE_GOAL).norm() > 1.0                        # …yet WRONG (far from truth)
    # the plan settled near its (wrong) belief 0, not near the true goal:
    assert out.x_T.norm() < (out.x_T - TRUE_GOAL).norm()


# ── 3. human-in-the-loop: a person is just a grounding channel ───────────────

def test_human_in_the_loop_grounds_the_machine():
    asked = []

    def human(dim, belief):
        asked.append(dim)                       # the person answers the machine's question
        return float(TRUE_GOAL[0, dim])

    m = _model(seed=3)
    qm = QuestionMachine(channels={0: "ask_human", 1: "ask_human", 2: "ask_human"})
    loop = QuestionDrivenLoop(m, qm, {"ask_human": HumanChannel(human)},
                              x0=torch.tensor([[1.0, -0.8, 0.5]]), dt=0.1,
                              goal_belief=torch.zeros(1, 3), horizon=8)
    out = loop.run(max_steps=6, consolidate_iters=40, final_iters=400)

    assert torch.allclose(out.belief, TRUE_GOAL, atol=1e-5)        # the human grounded it to truth
    assert sorted(set(asked)) == [0, 1, 2]                        # asked about every dimension once
    assert len(out.history) == 3


# ── 4. NAP denial → a real, permanent blind spot ─────────────────────────────

def test_nap_denial_creates_blind_spot():
    from src.convergence_io import (
        CapabilityGate, CapabilityClaim, AuthorityGate, NegativeAuthorityProfile,
    )
    channels_by_dim = {0: "ask_human", 1: "web_search", 2: "market_probe"}
    channel_objs = {name: OracleChannel(TRUE_GOAL, name=name)
                    for name in {"ask_human", "web_search", "market_probe"}}

    cap = CapabilityGate(honesty_floor=0.0)
    cap.register_claim(CapabilityClaim(agent_id="qm", provider_id="local",
                                       capabilities={"ask_human", "web_search", "market_probe"},
                                       boundary="local"))
    nap = AuthorityGate()
    nap.add_profile(NegativeAuthorityProfile(profile_id="deny-web",
                                             denied_actions={"web_search"},
                                             reason="hard authority floor"))

    m = _model(seed=4)
    qm = QuestionMachine(capability_gate=cap, authority_gate=nap,
                         channels=channels_by_dim, agent_id="qm")
    loop = QuestionDrivenLoop(m, qm, channel_objs,
                              x0=torch.tensor([[1.0, -0.8, 0.5]]), dt=0.1,
                              goal_belief=torch.zeros(1, 3), horizon=8)
    out = loop.run(max_steps=6, consolidate_iters=40, final_iters=300)

    # dim 1's channel (web_search) is NAP-denied → never asked → a permanent blind spot
    assert 1 in out.blind
    assert out.belief[0, 1].item() == pytest.approx(0.0, abs=1e-6)   # stayed at the ignorant prior
    # the channels it WAS allowed to use grounded dims 0 and 2 to truth:
    assert out.belief[0, 0].item() == pytest.approx(TRUE_GOAL[0, 0].item(), abs=1e-5)
    assert out.belief[0, 2].item() == pytest.approx(TRUE_GOAL[0, 2].item(), abs=1e-5)


# ── 5. corroboration: ≥2 independent channels fused (External-Reality Rule) ───

def test_corroboration_earns_confidence():
    """Two independent channels that AGREE → 'corroborated', confidence → 1.0."""
    ch = CorroboratedChannel("verify", [OracleChannel(TRUE_GOAL), OracleChannel(TRUE_GOAL)])
    obs = ch.resolve(0, torch.zeros(1, 3))
    assert obs.agreement == "corroborated"
    assert obs.n_sources == 2
    assert obs.confidence == pytest.approx(1.0)
    assert obs.value == pytest.approx(TRUE_GOAL[0, 0].item())


def test_divergence_lowers_confidence_not_silently_averaged():
    """Two channels that DISAGREE → 'divergent', confidence < 1 — the signal a loop should
    act on (re-ground / escalate), not trust the averaged value."""
    other = TRUE_GOAL.clone()
    other[0, 0] += 0.16                                    # spread 0.08 > tol 0.05 → divergent
    ch = CorroboratedChannel("verify", [OracleChannel(TRUE_GOAL), OracleChannel(other)], tol=0.05)
    obs = ch.resolve(0, torch.zeros(1, 3))
    assert obs.agreement == "divergent"
    assert 0.0 < obs.confidence < 1.0                     # neither trusted nor discarded — flagged
    assert obs.value == pytest.approx((TRUE_GOAL[0, 0].item() + other[0, 0].item()) / 2)


def test_corroborated_channel_grounds_the_loop():
    """A CorroboratedChannel plugs into the loop transparently: it discovers truth AND every
    record is marked corroborated (2 sources) — grounding is now earned, not single-point."""
    m = _model(seed=5)
    qm = QuestionMachine(channels={0: "verify", 1: "verify", 2: "verify"})
    verify = CorroboratedChannel("verify", [OracleChannel(TRUE_GOAL), OracleChannel(TRUE_GOAL)])
    loop = QuestionDrivenLoop(m, qm, {"verify": verify},
                              x0=torch.tensor([[1.0, -0.8, 0.5]]), dt=0.1,
                              goal_belief=torch.zeros(1, 3), horizon=8)
    out = loop.run(max_steps=6, consolidate_iters=40, final_iters=300)

    assert torch.allclose(out.belief, TRUE_GOAL, atol=1e-5)        # discovered the true goal
    assert out.history and all(r.agreement == "corroborated" and r.n_sources == 2
                               and r.confidence == pytest.approx(1.0) for r in out.history)


# ── 6. asked is not grounded: reconcile must not act on an answer that carries no evidence ───

FAST = dict(consolidate_iters=5, final_iters=100, lr=3.0)
X0 = torch.tensor([[1.0, -0.8, 0.5]])


def _loop(channels, routes=("c0", "c1", "c2")):
    m = _model(seed=6)
    qm = QuestionMachine(channels=dict(enumerate(routes)))
    return m, QuestionDrivenLoop(m, qm, channels, x0=X0, dt=0.1, goal_belief=torch.zeros(1, 3), horizon=8)


def _final_verdict(channels, routes=("c0", "c1", "c2"), executed=True, noise=0.0, **run):
    """Plan, run that plan in a world that matches the model, then reconcile on what was observed.
    Every internal signal is clean, so only the evidence can still object."""
    m, loop = _loop(channels, routes)
    first = loop.run(max_steps=6, **FAST, **run)
    if not executed:
        return first
    plan = [u.clone() for u in loop.us]
    states = forward_states(m, X0, plan, 0.1)
    if noise:
        g = torch.Generator().manual_seed(1)
        states = [states[0]] + [s + noise * 0.1 ** 0.5 * torch.randn(s.shape, generator=g) for s in states[1:]]
    return loop.run(max_steps=0, observed=(states, plan), **FAST, **run)


def test_an_oracle_grounded_loop_with_a_checked_model_can_act():
    channels = {name: OracleChannel(TRUE_GOAL, name) for name in ("c0", "c1", "c2")}
    assert _final_verdict(channels, executed=False).next_step.action == "gather_evidence"   # never observed
    out = _final_verdict(channels)
    assert out.grounded == [0, 1, 2] and out.weak == [] and out.blind == []
    assert out.next_step.action == "act"


@pytest.mark.parametrize("trial", ["no control", "started elsewhere"])
def test_a_trial_that_did_not_run_this_plan_cannot_justify_acting(trial):
    """The world matches the model, so the defect is 0, and the loop used to act on it. But a trial at
    rest says nothing about the controls the plan relies on, nor does one far from where it starts."""
    channels = {name: OracleChannel(TRUE_GOAL, name) for name in ("c0", "c1", "c2")}
    m, loop = _loop(channels)
    loop.run(max_steps=6, **FAST)
    plan = [u.clone() for u in loop.us]
    applied, start = ([torch.zeros(1, 3) for _ in plan], X0) if trial == "no control" else (plan, 1e-5 * X0)
    out = loop.run(max_steps=0, observed=(forward_states(m, start, applied, 0.1), applied), **FAST)
    assert out.next_step.defect == pytest.approx(0.0, abs=1e-5)
    assert out.next_step.action == "gather_evidence" and "this plan" in out.next_step.reason


def test_tolerances_reach_reconcile():
    """A correct model with process noise misses each step by the noise, which the default defect_tol
    reads as a failure, and run() had no way to say otherwise."""
    channels = {name: OracleChannel(TRUE_GOAL, name) for name in ("c0", "c1", "c2")}
    assert _final_verdict(channels, noise=3e-3).next_step.action == "revise_model"
    relaxed = _final_verdict(channels, noise=3e-3, tolerances={"defect_tol": 1.0})
    assert relaxed.next_step.action == "act"


def test_sources_that_disagree_are_weak_even_at_middling_confidence():
    """1.0 against 1.2 reads "divergent" with confidence 0.5, which cleared min_confidence."""
    def pair(name):
        return CorroboratedChannel(name, [CallbackChannel("a", lambda j, b: 1.0),
                                          CallbackChannel("b", lambda j, b: 1.2)])
    out = _final_verdict({name: pair(name) for name in ("c0", "c1", "c2")})
    assert all(r.agreement == "divergent" and r.confidence == 0.5 for r in out.history)
    assert out.weak == [0, 1, 2] and out.next_step.action == "gather_evidence"


def test_reconcile_does_not_check_that_the_goal_is_reachable():
    """The documented limit, pinned. A goal dimension that no control moves leaves a gap of 49.7, and
    every check here is clean, so it reads act. The caller has x_T and the belief to see the gap."""
    A = torch.diag(torch.tensor([-0.4, -0.5, -0.6]))
    m = CIO_SDE(dim=3, ctrl_dim=3, hidden=4)
    m.graph.active = LinearDynamics(A, B=torch.diag(torch.tensor([1.0, 1.0, 0.0])))
    goal = torch.tensor([[1.5, -1.0, 50.0]])
    channels = {name: OracleChannel(goal, name) for name in ("c0", "c1", "c2")}
    loop = QuestionDrivenLoop(m, QuestionMachine(channels={0: "c0", 1: "c1", 2: "c2"}), channels, x0=X0,
                              dt=0.1, goal_belief=torch.zeros(1, 3), horizon=8)
    loop.run(max_steps=6, **FAST)
    plan = [u.clone() for u in loop.us]
    out = loop.run(max_steps=0, observed=(forward_states(m, X0, plan, 0.1), plan), **FAST)
    assert float((out.x_T - goal).norm()) > 40.0
    assert out.next_step.action == "act"


def test_a_correct_model_is_not_blamed_for_the_plan_moving():
    """The defect used to be scored against the final plan, which the last pass had just changed
    from whatever produced the observations. That difference read as a model failure."""
    channels = {name: OracleChannel(TRUE_GOAL, name) for name in ("c0", "c1", "c2")}
    m, loop = _loop(channels)
    applied = [torch.full((1, 3), 0.1) for _ in range(8)]
    out = loop.run(max_steps=6, observed=(forward_states(m, X0, applied, 0.1), applied), **FAST)
    assert out.next_step.defect == pytest.approx(0.0, abs=1e-5)


def test_a_wrong_model_is_still_caught_on_a_trial_run():
    m = _model(seed=6)
    x0 = torch.tensor([[1.0, -0.8, 0.5]])
    channels = {name: OracleChannel(TRUE_GOAL, name) for name in ("c0", "c1", "c2")}
    loop = QuestionDrivenLoop(m, QuestionMachine(channels=dict(enumerate(channels))), channels, x0=x0,
                              dt=0.1, goal_belief=torch.zeros(1, 3), horizon=8)
    applied = [torch.full((1, 3), 0.1) for _ in range(8)]
    world = [x0]
    for u in applied:
        world.append(world[-1] + (world[-1] @ m.graph.active.A.T - u) * 0.1)   # the control's sign is flipped
    out = loop.run(max_steps=6, consolidate_iters=5, final_iters=20, lr=3.0, observed=(world, applied))
    assert out.next_step.action == "revise_model"


def test_a_mirror_answer_is_not_evidence():
    """Its belief stays at 0, the truth is elsewhere, and the plan is coherent and checks out against
    the model. Every internal signal is clean, which is why this used to say "act"."""
    channels = {name: MirrorChannel(name) for name in ("c0", "c1", "c2")}
    out = _final_verdict(channels)
    assert torch.allclose(out.belief, torch.zeros(1, 3))
    assert out.grounded == [] and out.weak == [0, 1, 2]
    assert out.next_step.action == "gather_evidence"


def test_sources_that_disagree_are_not_evidence():
    def disagreeing(name):
        return CorroboratedChannel(name, [CallbackChannel("a", lambda j, b: 100.0),
                                          CallbackChannel("b", lambda j, b: -100.0)])
    channels = {name: disagreeing(name) for name in ("c0", "c1", "c2")}
    out = _final_verdict(channels)
    assert all(r.agreement == "divergent" and r.confidence == 0.0 for r in out.history)
    assert out.weak == [0, 1, 2]
    assert out.next_step.action == "gather_evidence"


def test_a_dim_with_no_channel_is_blind_and_does_not_end_the_round():
    """A missing channel marked its dim grounded and stopped the loop, which also starved the rest."""
    channels = {"c0": OracleChannel(TRUE_GOAL, "c0"), "c2": OracleChannel(TRUE_GOAL, "c2")}
    out = _final_verdict(channels)
    assert out.blind == [1] and out.grounded == [0, 2]
    assert out.belief[0, 0].item() == pytest.approx(TRUE_GOAL[0, 0].item(), abs=1e-5)
    assert out.belief[0, 2].item() == pytest.approx(TRUE_GOAL[0, 2].item(), abs=1e-5)
    assert out.next_step.action == "gather_evidence"


def test_two_mirrors_do_not_corroborate_each_other():
    ch = CorroboratedChannel("verify", [MirrorChannel("a"), MirrorChannel("b")])
    obs = ch.resolve(0, torch.zeros(1, 3))
    assert obs.agreement == "self-reference" and obs.confidence == 0.0 and obs.n_sources == 0


def test_a_mirror_beside_a_real_source_is_one_source():
    ch = CorroboratedChannel("verify", [MirrorChannel("a"), OracleChannel(TRUE_GOAL)])
    obs = ch.resolve(0, torch.zeros(1, 3))
    assert obs.agreement == "single-source" and obs.n_sources == 1
    assert obs.value == pytest.approx(TRUE_GOAL[0, 0].item())


def test_min_confidence_can_require_corroboration():
    channels = {name: CorroboratedChannel(name, [OracleChannel(TRUE_GOAL)]) for name in ("c0", "c1", "c2")}
    relaxed = _final_verdict(channels)
    assert relaxed.grounded == [0, 1, 2]
    strict = _final_verdict(channels, min_confidence=0.9)
    assert strict.weak == [0, 1, 2] and strict.next_step.action == "gather_evidence"
