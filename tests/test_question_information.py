"""The Question Machine's information-gain selector (src/cio_sde/question.py).

The selector is G2 from lantern-os-research (experiments/oracle_bayesian_voi.py, hardened in research
PR #17), ported. The first group of tests comes with it: exactness against a 60-digit computation, the
regressions the hardening fixed, and the selector's stopping rules. The last group is new: CAP and NAP
gate which experiments it may run, and a denied experiment is reported, never run.

Run:  python -m pytest tests/test_question_information.py -q
"""
import random
from decimal import Context, Decimal
from fractions import Fraction
from math import log2

import pytest

pytest.importorskip("torch")

from cio_sde.question import (  # noqa: E402
    MIN_GAIN_BITS, Experiment, QuestionMachine, entropy_bits, expected_information_gain_bits,
    outcome_probability, posterior_after, score_experiments, select_next_experiment,
)

PRIOR = {"linear": 0.5, "quadratic": 0.5}


def _e(eid, rows, cost=1.0, channel="probe"):
    return Experiment(eid, cost, rows, channel=channel)


# ── ported from G2 ───────────────────────────────────────────────────────────────────────────

def test_entropy_is_in_bits():
    assert entropy_bits({"a": 0.5, "b": 0.5}) == pytest.approx(1.0)
    assert entropy_bits({"a": 1.0, "b": 0.0}) == 0.0


def test_a_perfect_discriminator_gives_one_bit_and_a_useless_one_none():
    perfect = _e("perfect", {"linear": {"low": 1.0, "high": 0.0}, "quadratic": {"low": 0.0, "high": 1.0}})
    useless = _e("useless", {"linear": {"yes": 0.7, "no": 0.3}, "quadratic": {"yes": 0.7, "no": 0.3}})
    assert expected_information_gain_bits(PRIOR, perfect) == pytest.approx(1.0)
    assert expected_information_gain_bits(PRIOR, useless) == 0.0


def test_a_noisy_discriminator_has_its_exact_gain():
    noisy = _e("noisy", {"linear": {"yes": 0.9, "no": 0.1}, "quadratic": {"yes": 0.1, "no": 0.9}})
    assert expected_information_gain_bits(PRIOR, noisy) == pytest.approx(1.0 - entropy_bits({"y": 0.9, "n": 0.1}))
    assert posterior_after(PRIOR, noisy, "no") == pytest.approx({"linear": 0.1, "quadratic": 0.9})


def test_an_impossible_observation_is_rejected():
    e = _e("deterministic", {"linear": {"a": 1.0}, "quadratic": {"b": 1.0}})
    with pytest.raises(ValueError, match="zero probability"):
        posterior_after(PRIOR, e, "c")


@pytest.mark.parametrize("bad", [{}, {"a": 0.4, "b": 0.4}, {"a": -0.1, "b": 1.1}])
def test_invalid_priors_are_rejected(bad):
    with pytest.raises(ValueError):
        expected_information_gain_bits(bad, _e("e", {h: {"x": 1.0} for h in bad}))


def test_malformed_experiments_are_rejected():
    with pytest.raises(ValueError, match="exactly"):
        expected_information_gain_bits(PRIOR, _e("bad", {"linear": {"yes": 1.0}}))
    same = _e("same", {"linear": {"a": 1.0}, "quadratic": {"b": 1.0}})
    with pytest.raises(ValueError, match="duplicate"):
        score_experiments(PRIOR, [same, same])
    with pytest.raises(ValueError, match="cost"):
        expected_information_gain_bits(PRIOR, _e("free", same.likelihoods, cost=0.0))


_CTX = Context(prec=60)


def _oracle_gain(prior, experiment):
    """I(H; O) to 60 digits: exact rationals for every probability, decimal logarithms."""
    def exact(table):
        q = {k: Fraction(v) for k, v in table.items()}
        total = sum(q.values())
        return {k: v / total for k, v in q.items()}

    def dec(q):
        return _CTX.divide(Decimal(q.numerator), Decimal(q.denominator))

    p = exact(prior)
    rows = {h: exact(experiment.likelihoods[h]) for h in p}
    m = {o: sum((p[h] * rows[h].get(o, Fraction(0)) for h in p), Fraction(0)) for row in rows.values() for o in row}
    total = Decimal(0)
    for h in p:
        for o, like in rows[h].items():
            if p[h] * like > 0:
                total = _CTX.add(total, _CTX.multiply(dec(p[h] * like), _CTX.ln(dec(like / m[o]))))
    return float(_CTX.divide(total, _CTX.ln(Decimal(2))))


def _table(rng, labels, zero_rate):
    w = [0.0 if rng.random() < zero_rate else rng.random() for _ in labels]
    if not any(w):
        w[rng.randrange(len(w))] = 1.0
    return {label: x / sum(w) for label, x in zip(labels, w)}


def _model(rng, zero_rate=0.25):
    hyps = [f"h{i}" for i in range(rng.randint(2, 7))]
    outs = [f"o{j}" for j in range(rng.randint(2, 5))]
    return _table(rng, hyps, zero_rate), _e("e", {h: _table(rng, outs, zero_rate) for h in hyps})


def test_gain_matches_a_60_digit_computation():
    rng = random.Random(20261105)
    worst = max(abs(expected_information_gain_bits(p, e) - _oracle_gain(p, e))
                for p, e in (_model(rng) for _ in range(300)))
    assert worst < 1e-12


def test_gain_is_bounded_and_bayes_is_a_martingale():
    rng = random.Random(7)
    for _ in range(200):
        prior, e = _model(rng)
        gain = expected_information_gain_bits(prior, e)
        outs = sorted({o for row in e.likelihoods.values() for o in row})
        possible = [o for o in outs if outcome_probability(prior, e, o) > 0.0]
        assert 0.0 <= gain <= min(entropy_bits(prior), log2(len(possible))) + 1e-12
        expected = {h: 0.0 for h in prior}
        for o in possible:
            for h, q in posterior_after(prior, e, o).items():
                expected[h] += outcome_probability(prior, e, o) * q
        assert expected == pytest.approx(prior, abs=1e-12)


def test_identical_likelihoods_carry_exactly_no_information():
    """G2's first version gave such experiments about 1e-15 bits from rounding, and selected 5,588 of
    20,000 of them."""
    rng = random.Random(0)
    for _ in range(1000):
        prior, e = _model(rng, zero_rate=0.0)
        same = _e("same", {h: dict(e.likelihoods["h0"]) for h in prior})
        assert expected_information_gain_bits(prior, same) == 0.0
        sel = select_next_experiment(prior, [same], budget=1.0)
        assert sel.selected is None and sel.stop_reason == "uninformative"


@pytest.mark.parametrize("scale", [1 - 5e-10, 1 + 5e-10])
def test_tables_inside_the_sum_tolerance_are_normalised(scale):
    prior = {"a": scale / 2, "b": scale / 2}
    same = _e("same", {"a": {"yes": 0.7, "no": 0.3}, "b": {"yes": 0.7, "no": 0.3}})
    assert expected_information_gain_bits(prior, same) == 0.0
    assert select_next_experiment(prior, [same], 1.0).selected is None


def test_a_rounding_sized_gain_is_not_information():
    k = 1 - 1e-12
    e = _e("scaled", {"a": {"yes": 0.7, "no": 0.3}, "b": {"yes": 0.7 * k, "no": 0.3 * k}})
    assert 0.0 < expected_information_gain_bits({"a": 0.5, "b": 0.5}, e) <= MIN_GAIN_BITS
    assert select_next_experiment({"a": 0.5, "b": 0.5}, [e], 1.0).stop_reason == "uninformative"


def test_the_selector_ranks_by_information_per_cost_within_the_budget():
    weak = _e("cheap-weak", {"linear": {"y": 0.6, "n": 0.4}, "quadratic": {"y": 0.4, "n": 0.6}})
    strong = _e("dear-strong", {"linear": {"y": 0.99, "n": 0.01}, "quadratic": {"y": 0.01, "n": 0.99}}, cost=2.0)
    assert select_next_experiment(PRIOR, [weak, strong], budget=2.0).selected.experiment is strong
    sel = select_next_experiment(PRIOR, [strong], budget=1.0)
    assert sel.selected is None and sel.stop_reason == "budget" and sel.remaining_budget == 1.0
    assert select_next_experiment({"linear": 1.0, "quadratic": 0.0}, [strong], 2.0).stop_reason == "resolved"


# ── new: CAP and NAP gate what it may ask ────────────────────────────────────────────────────

class _Deny:
    """A NAP stand-in that denies one channel."""

    def __init__(self, channel):
        self.channel = channel

    def check(self, action_type, tier=None):
        return type("R", (), {"denied": action_type == self.channel, "reason": "off limits"})()


def _pair():
    decisive = _e("decisive", {"linear": {"y": 1.0, "n": 0.0}, "quadratic": {"y": 0.0, "n": 1.0}},
                  channel="actuate")
    weak = _e("weak", {"linear": {"y": 0.6, "n": 0.4}, "quadratic": {"y": 0.4, "n": 0.6}}, channel="observe")
    return decisive, weak


def test_ask_by_information_picks_the_most_informative_admissible_experiment():
    decisive, weak = _pair()
    sel = QuestionMachine().ask_by_information(PRIOR, [weak, decisive], budget=1.0)
    assert sel.selected.experiment is decisive and sel.blocked == ()
    assert sel.selected.information_gain_bits == pytest.approx(1.0)


def test_a_denied_experiment_is_never_run_but_its_worth_is_reported():
    decisive, weak = _pair()
    sel = QuestionMachine(authority_gate=_Deny("actuate")).ask_by_information(PRIOR, [weak, decisive], budget=1.0)
    assert sel.selected.experiment is weak
    (eid, gain, reason), = sel.blocked
    assert eid == "decisive" and gain == pytest.approx(1.0) and "NAP denied 'actuate'" in reason


def test_when_only_denied_experiments_inform_the_stop_reason_is_denied():
    decisive, _ = _pair()
    useless = _e("useless", {"linear": {"y": 0.5, "n": 0.5}, "quadratic": {"y": 0.5, "n": 0.5}}, channel="observe")
    qm = QuestionMachine(authority_gate=_Deny("actuate"))
    assert qm.ask_by_information(PRIOR, [useless, decisive], budget=1.0).stop_reason == "denied"
    assert qm.ask_by_information(PRIOR, [decisive], budget=1.0).stop_reason == "denied"
    assert qm.ask_by_information(PRIOR, [useless], budget=1.0).stop_reason == "uninformative"
