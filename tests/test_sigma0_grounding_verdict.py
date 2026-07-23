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


def test_stable_but_unverified_directs_an_experiment_not_a_refusal():
    """The active face: a stable-but-unverified answer is NEVER grounded=True, but it does NOT
    rest at 'I can't' — it PENDS (grounded=None) with a directive to experiment."""
    v = V(_out("contract"), external_grounded=None)   # means available, not exhausted
    assert v["grounded"] is None            # never a fabricated pass
    assert v["loop_certified"] is True      # the loop half IS certified
    assert v["klass"] == "experiment_required" and v["next_action"] == "experiment"


def test_unverifiable_after_exhaustion_is_effectively_false():
    """The last leg exhausted: stable but no means left to verify → grounded=False (effectively
    false until true), NOT a permanent None/refusal."""
    v = V(_out("contract"), external_grounded=None, experiments_exhausted=True)
    assert v["grounded"] is False and v["klass"] == "unverifiable_exhausted"
    assert v["next_action"] == "halt"


def test_no_means_task_is_effectively_false():
    """A task that admits no experiment at all (verifiable=False) settles false immediately —
    there is nothing to experiment on, so it is effectively false until an oracle appears."""
    v = V(_out("contract"), external_grounded=None, verifiable=False)
    assert v["grounded"] is False and v["klass"] == "unverifiable_exhausted"


def test_stable_but_verifier_rejected_is_False():
    v = V(_out("contract"), external_grounded=False)
    assert v["grounded"] is False and v["klass"] == "verification_failed"


def test_unstable_loop_is_never_grounded():
    for stable in ("diverge", "spiral", None):
        for ext in (True, False, None):
            v = V(_out(stable), external_grounded=ext)
            assert v["grounded"] is False, (stable, ext)
            assert v["loop_certified"] is False


def test_exhaustive_invariant():
    """grounded is True  ⟺  (stable == 'contract'  AND  external_grounded is True) — for ALL inputs.
    The active-face change never weakens this: it only moves undetermined cases toward not-grounded."""
    for stable, ext, verif, exh in itertools.product(
            ("contract", "spiral", "diverge", None), (True, False, None), (True, False, None), (True, False)):
        v = V(_out(stable), external_grounded=ext, verifiable=verif, experiments_exhausted=exh)
        expect_true = (stable == "contract" and ext is True)
        assert (v["grounded"] is True) == expect_true, (stable, ext, verif, exh, v["grounded"])
        assert v["grounded"] in (True, False, None)
        # never a resting refusal: an undetermined (None) verdict ALWAYS carries an experiment directive
        if v["grounded"] is None:
            assert v["next_action"] == "experiment"


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
