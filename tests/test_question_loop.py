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
    OracleChannel, MirrorChannel, HumanChannel, CorroboratedChannel,
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
