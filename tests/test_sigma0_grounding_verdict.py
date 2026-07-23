"""Σ₀-grounding verdict — the two-factor honesty invariant.

An answer is grounded ONLY when the reasoning loop was stable (contraction gate) AND an external
verifier confirmed it. Stability alone NEVER yields grounded=True. These tests pin that invariant
exhaustively — a regression here would let the LLM claim "grounded" on an unverified answer, the
one dangerous failure the verdict exists to prevent. Zero-dep, no model.

  python -m pytest tests/test_sigma0_grounding_verdict.py -q
"""
import itertools
from sigma0.loop_lm import sigma0_grounding_verdict as V


def _out(stable):
    # a stub generate()-out dict carrying just the verdict field the function reads
    return {"stable": stable}


def test_grounded_true_requires_stable_AND_external():
    v = V(_out("contract"), external_grounded=True)
    assert v["grounded"] is True and v["klass"] == "externally_verified"


def test_stable_but_unverified_is_None_not_True():
    """The load-bearing honesty case: a stable loop with no external check is NOT grounded."""
    v = V(_out("contract"), external_grounded=None)
    assert v["grounded"] is None            # honestly undetermined — never a fabricated pass
    assert v["loop_certified"] is True      # the loop half IS certified
    assert v["klass"] in ("unverified", "stability_certified_only")


def test_stable_but_verifier_rejected_is_False():
    v = V(_out("contract"), external_grounded=False)
    assert v["grounded"] is False and v["klass"] == "verification_failed"


def test_unstable_loop_is_never_grounded():
    for stable in ("diverge", "spiral", None):
        for ext in (True, False, None):
            v = V(_out(stable), external_grounded=ext)
            assert v["grounded"] is False, (stable, ext)
            assert v["loop_certified"] is False


def test_non_verifiable_task_is_certified_only_not_grounded():
    v = V(_out("contract"), external_grounded=None, verifiable=False)
    assert v["grounded"] is None and v["klass"] == "stability_certified_only"


def test_exhaustive_invariant():
    """grounded is True  ⟺  (stable == 'contract'  AND  external_grounded is True) — for ALL inputs."""
    for stable, ext, verif in itertools.product(
            ("contract", "spiral", "diverge", None), (True, False, None), (True, False, None)):
        v = V(_out(stable), external_grounded=ext, verifiable=verif)
        expect_true = (stable == "contract" and ext is True)
        assert (v["grounded"] is True) == expect_true, (stable, ext, verif, v["grounded"])
        # and grounded is never fabricated: it is exactly one of {True, False, None}
        assert v["grounded"] in (True, False, None)


def test_reads_full_generate_out_via_assemble():
    """When passed a raw generate() out-dict (no 'stable' key), it derives stability via
    assemble_reason_verdict — here a divergent JSRR regime must yield not-grounded."""
    raw = {"stability_gates": {"jsrr": {"regime": "divergent", "stable": False}},
           "stability_accepted": False, "exit_reason": "max_depth"}
    v = V(raw, external_grounded=True)   # even with external=True, a divergent loop is not grounded
    assert v["grounded"] is False and v["loop_certified"] is False


def test_continuous_gate_cannot_override_discrete_divergence():
    """Regression (math-check 2026-07-23): a DISCRETE-divergent loop (JSRR regime='divergent',
    stable=False) that ALSO carries a continuous proven_contracting=True (max Re λ<0, e.g. a λ=−2
    Jacobian: ρ=2 diverges but the continuous flow contracts) must NOT be labelled 'contract'.
    Before the fix, the OR let proven_contracting forge a false 'grounded' at d≤512."""
    raw = {"stability_gates": {"jsrr": {"regime": "divergent", "stable": False},
                               "proven_contracting": True},
           "stability_accepted": False, "exit_reason": "max_depth"}
    v = V(raw, external_grounded=True)
    assert v["grounded"] is False, "continuous gate must not override discrete divergence"
    assert v["loop_certified"] is False


def test_margin_band_is_not_contract():
    """A JSRR reject inside the near-critical margin band (stable=False, regime='contraction' i.e.
    ρ<1 but ρ≥1−margin) is 'spiral' (near-boundary), never 'contract' — so it is not grounded."""
    raw = {"stability_gates": {"jsrr": {"regime": "contraction", "stable": False}}}
    v = V(raw, external_grounded=True)
    assert v["grounded"] is False and v["loop_certified"] is False


def test_jsrr_absent_falls_back_to_continuous():
    """Backward-compat: with NO JSRR (older cert), proven_contracting still certifies the loop —
    so the prior reason_verdict contract is preserved."""
    raw = {"stability_gates": {"proven_contracting": True}}   # no 'jsrr' key
    v = V(raw, external_grounded=True)
    assert v["loop_certified"] is True and v["grounded"] is True
