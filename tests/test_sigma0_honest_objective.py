"""Machine-checks for the honest-model objective (experiments/sigma0_honest_objective.py).

These verify the properties the honest-model DESIGN claims -- so the claims are
exec-verified, not asserted in prose. Pure numpy; no training, no GPU, no network.
"""
import numpy as np
import pytest

from experiments.sigma0_honest_objective import (
    honesty_reward, brier, log_score, expected_score, ece, risk_coverage,
    verify_gate, validate_claim, _incentive_gap,
)


def r(**kw):
    return honesty_reward(**kw)


def test_reward_confident_wrong_is_the_worst_outcome():
    """The certificate's 'calm-while-wrong' must be the single worst payoff."""
    confident_wrong = r(correct=False, abstained=False, answerable=True, conf=0.95)
    others = [
        r(correct=False, abstained=False, answerable=True, conf=0.30),   # wrong, unsure
        r(correct=False, abstained=True, answerable=True, conf=0.0),      # over-abstain
        r(correct=False, abstained=True, answerable=False, conf=0.0),     # good abstain
        r(correct=True, abstained=False, answerable=True, conf=0.95),     # correct+confident
        r(correct=True, abstained=False, answerable=True, conf=0.30),     # correct, unsure
    ]
    assert all(confident_wrong < o for o in others)


def test_reward_abstention_beats_confabulation():
    """Declining when you'd be wrong must beat answering wrong."""
    good_abstain = r(correct=False, abstained=True, answerable=False, conf=0.0)
    answer_wrong_confident = r(correct=False, abstained=False, answerable=True, conf=0.95)
    answer_wrong_unsure = r(correct=False, abstained=False, answerable=True, conf=0.30)
    assert good_abstain > answer_wrong_confident
    assert good_abstain > answer_wrong_unsure


def test_reward_correct_confident_is_the_best_outcome():
    best = r(correct=True, abstained=False, answerable=True, conf=0.95)
    for kw in [dict(correct=True, abstained=False, answerable=True, conf=0.30),
               dict(correct=False, abstained=True, answerable=False, conf=0.0),
               dict(correct=False, abstained=False, answerable=True, conf=0.95)]:
        assert best > r(**kw)


def test_reward_calibration_term_penalizes_overconfidence():
    """Among correct answers, honest-but-lower conf must not be rewarded ABOVE a
    well-calibrated high conf; and overstating confidence is penalized continuously."""
    over = r(correct=True, abstained=False, answerable=True, conf=0.99)
    under = r(correct=True, abstained=False, answerable=True, conf=0.71)
    assert over > under                                   # calibrated confidence rewarded
    # for a WRONG answer, higher stated confidence is strictly worse
    a = r(correct=False, abstained=False, answerable=True, conf=0.71)
    b = r(correct=False, abstained=False, answerable=True, conf=0.99)
    assert b < a


@pytest.mark.parametrize("rule", ["brier", "log"])
def test_scoring_rule_is_strictly_proper(rule):
    """THE central theorem: expected score is minimized at report == true probability,
    so the reward-maximizing report is the honest belief. Machine-checked by grid
    argmin over a 1001-point report grid across 19 true probabilities."""
    gap = _incentive_gap(rule, grid=1001)
    assert gap < 1.5e-3, f"{rule} not strictly proper: argmin gap {gap}"


def test_expected_score_closed_form_matches_definition():
    # brier: E_p = p(r-1)^2 + (1-p)r^2, min at r=p with value p(1-p)
    p = 0.3
    assert abs(expected_score(p, p, "brier") - p * (1 - p)) < 1e-12
    # any r != p is strictly worse
    assert expected_score(p, 0.5, "brier") > expected_score(p, p, "brier")


def test_ece_zero_for_calibrated_high_for_confidently_wrong():
    rng = np.random.default_rng(1)
    p = rng.uniform(0, 1, 20000)
    y = (rng.uniform(0, 1, 20000) < p).astype(float)     # perfectly calibrated
    assert ece(p, y, bins=10) < 0.02
    confidently_wrong = ece(np.full(500, 0.95), np.zeros(500))
    assert confidently_wrong > 0.9                        # ~0.95


def test_selective_prediction_declining_unsure_lowers_risk():
    """A calibrated confidence => answering only the high-confidence items has lower
    error than answering everything (the value of abstention)."""
    rng = np.random.default_rng(2)
    conf = rng.uniform(0, 1, 5000)
    correct = (rng.uniform(0, 1, 5000) < conf).astype(float)
    rc = risk_coverage(conf, correct)
    risk_at_20pct = next(risk for cov, risk in rc if cov >= 0.20)
    risk_at_full = rc[-1][1]
    assert risk_at_20pct < risk_at_full                   # abstaining helps
    # and full-coverage risk ~ 1 - mean(conf) ~ 0.5
    assert abs(risk_at_full - (1 - correct.mean())) < 1e-9


def test_verify_gate_decision_table():
    assert verify_gate(grounded=False, verifiable=True, verify_outcome="pass") == "abstain"
    assert verify_gate(grounded=True, verifiable=True, verify_outcome="pass") == "emit"
    assert verify_gate(grounded=True, verifiable=True, verify_outcome="fail") == "revise_or_abstain"
    assert verify_gate(grounded=True, verifiable=False, verify_outcome="unrun") == "emit_low_confidence"


def test_claim_schema_validator():
    good = {"text": "rho<1 certifies collapse", "class": "MEASURED",
            "cite": "tests/test_cio_sde.py::test_discrete_dichotomy_radius_trichotomy",
            "confidence": 0.86, "verified": True, "outcome": "pass"}
    ok, msg = validate_claim(good)
    assert ok, msg
    ok, _ = validate_claim({**good, "class": "TOTALLY_PROVEN"})     # not a valid class
    assert not ok
    ok, _ = validate_claim({k: v for k, v in good.items() if k != "cite"})  # missing cite
    assert not ok
    ok, _ = validate_claim({**good, "confidence": 1.4})              # out of range
    assert not ok
