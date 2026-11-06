"""wq-007 — verification outcomes update ConvergenceRecord confidence (Verify stage)."""
from src.convergence.objects import ConvergenceRecord
from src.convergence.verify import (
    verify_with_test, verify_with_surprise, verify_with_monitor,
)


def _rec(conf=0.6):
    return ConvergenceRecord(
        id="cr-1", hypothesis="h", evidence_ids=["m1"], result="r",
        confidence=conf, reasoner="test",
    )


def test_passing_test_boosts_and_marks_verified():
    r = verify_with_test(_rec(0.6), passed=True)
    assert r.verified is True
    assert r.confidence > 0.6
    assert "passed" in r.verification_notes


def test_failing_test_collapses_confidence():
    r = verify_with_test(_rec(0.9), passed=False)
    assert r.verified is True
    assert r.confidence < 0.9
    assert r.confidence <= 0.2 * 0.9 + 1e-9


def test_high_nis_spook_collapses_confidence():
    r = verify_with_surprise(_rec(0.8), nis=500.0, dof=4)
    assert r.verified is True
    assert r.confidence < 0.8
    assert "spook" in r.verification_notes


def test_consistent_nis_nudges_up():
    r = verify_with_surprise(_rec(0.6), nis=4.0, dof=4)
    assert r.confidence > 0.6
    assert "consistent" in r.verification_notes


def test_confidence_stays_in_unit_interval():
    hi = verify_with_test(_rec(1.0), passed=True)
    lo = verify_with_test(_rec(0.0), passed=False)
    assert 0.0 <= hi.confidence <= 1.0
    assert 0.0 <= lo.confidence <= 1.0


def test_verify_with_monitor_reads_dict():
    # mirrors SurpriseMonitor.evaluate() output (plain floats here)
    r = verify_with_monitor(_rec(0.7), {"nis": 999.0, "dof": 6})
    assert r.verified is True
    assert r.confidence < 0.7  # a spook contradicts the claim


def test_a_nan_nis_is_no_evidence():
    """SurpriseMonitor reads NaN for a row it could not score. NaN > threshold is False, so the reading
    folded in as "consistent" and raised confidence. It now leaves the record as it was, but for a note."""
    for fold in (lambda r: verify_with_surprise(r, nis=float("nan"), dof=4),
                 lambda r: verify_with_monitor(r, {"nis": float("nan"), "dof": 4})):
        r = fold(_rec(0.6))
        assert r.confidence == 0.6 and r.verified is False and r.applied_evidence == []
        assert "not evidence" in r.verification_notes
    r = _rec(0.6)
    verify_with_surprise(r, nis=float("nan"), dof=4)
    assert verify_with_surprise(r, nis=4.0, dof=4).confidence > 0.6   # a real reading still counts


# ── #764 G9 — deterministic-reverification ratchet is closed ───────────────────

def test_replaying_same_passing_test_is_idempotent():
    """Re-folding the identical passing test must NOT raise confidence again."""
    r = _rec(0.3)
    once = verify_with_test(r, passed=True).confidence
    twice = verify_with_test(r, passed=True).confidence
    assert twice == once  # second application is a no-op
    assert "duplicate evidence" in r.verification_notes


def test_replay_cannot_ratchet_confidence_to_one():
    """The classic attack: hammer the same test to drive confidence → 1.0."""
    r = _rec(0.3)
    first = verify_with_test(r, passed=True).confidence
    for _ in range(50):
        verify_with_test(r, passed=True)
    assert r.confidence == first
    assert r.confidence < 0.7  # nowhere near a laundered 1.0


def test_distinct_evidence_keys_each_count():
    """Genuinely independent corroborations still accumulate."""
    r = _rec(0.3)
    verify_with_test(r, passed=True, evidence_key="run-A")
    after_a = r.confidence
    verify_with_test(r, passed=True, evidence_key="run-B")
    assert r.confidence > after_a
    assert set(r.applied_evidence) == {"run-A", "run-B"}


def test_replaying_same_nis_reading_is_idempotent():
    r = _rec(0.5)
    once = verify_with_surprise(r, nis=4.0, dof=4).confidence
    twice = verify_with_surprise(r, nis=4.0, dof=4).confidence
    assert twice == once
    assert "duplicate evidence" in r.verification_notes


def test_applied_evidence_recorded_and_serialized():
    r = _rec(0.4)
    verify_with_test(r, passed=True)
    assert len(r.applied_evidence) == 1
    assert r.applied_evidence[0] in r.to_jsonl()


def test_distinct_records_do_not_share_dedupe_keys():
    """Default key is salted by record id — same test on two records both apply."""
    r1, r2 = _rec(0.3), _rec(0.3)
    r2.id = "cr-2"
    c1 = verify_with_test(r1, passed=True).confidence
    c2 = verify_with_test(r2, passed=True).confidence
    assert c1 > 0.3 and c2 > 0.3  # neither was suppressed by the other
