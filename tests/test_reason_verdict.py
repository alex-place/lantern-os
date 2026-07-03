"""
Unit tests for ADR-0012 step 1 — the ReasonVerdict assembler
(``sigma0.loop_lm.assemble_reason_verdict``).

This slice is pure/torch-free by design (it only reshapes the dict ``generate()``
already returns), so unlike tests/test_loop_exit.py these run WITHOUT torch or the
Ouro model — which is exactly why step 1 is verifiable on a CPU-only box while the
end-to-end telemetry (needs the model) is not.

Run:  python -m pytest tests/test_reason_verdict.py -q
  or: python tests/test_reason_verdict.py   (self-running, no pytest needed)
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from sigma0.loop_lm import assemble_reason_verdict as V  # noqa: E402

# The ADR-0012 ReasonVerdict enums — the assembler must never emit anything outside these.
STABLE_VALUES = {"contract", "spiral", "diverge", None}
REASON_VALUES = {"threshold_met", "fixed_point", "accel_fixed_point", "max_depth",
                 "collapse", "divergence", "ungrounded"}


def _base(**over):
    out = {
        "mean_depth": 2.5,
        "exit_reason": "adaptive_qexit",
        "canary_signal": "none",
        "canary_max_proximity": 0.1,
        "stability_accepted": None,
        "stability_gates": None,
    }
    out.update(over)
    return out


def _gates(contracting, fate=None):
    return {"proven_contracting": contracting, "dichotomy": ({"fate": fate} if fate else None)}


def test_shape_and_enums():
    v = V(_base())
    assert set(v.keys()) == {"converged", "depth", "proximity", "grounded", "stable", "reason"}
    assert v["stable"] in STABLE_VALUES
    assert v["reason"] in REASON_VALUES


def test_contract_accepted_qexit():
    v = V(_base(stability_gates=_gates(True, "COLLAPSE"), stability_accepted=True))
    # proven_contracting wins over the dichotomy fate for `stable`
    assert v["stable"] == "contract"
    assert v["reason"] == "threshold_met"
    assert v["converged"] is True
    assert v["depth"] == 2.5
    assert v["proximity"] == 0.1


def test_diverge_fate():
    v = V(_base(stability_gates=_gates(False, "DIVERGE")))
    assert v["stable"] == "diverge"
    assert v["reason"] == "divergence"


def test_spiral_collapse_fate():
    v = V(_base(stability_gates=_gates(False, "COLLAPSE")))
    assert v["stable"] == "spiral"
    assert v["reason"] == "collapse"


def test_marginal_is_spiral():
    v = V(_base(stability_gates=_gates(False, "MARGINAL")))
    assert v["stable"] == "spiral"
    assert v["reason"] == "collapse"


def test_canary_signal_wins_reason():
    # a decode-canary collapse signal takes priority over a contracting certificate
    v = V(_base(stability_gates=_gates(True), stability_accepted=True, canary_signal="echo"))
    assert v["reason"] == "collapse"
    assert v["stable"] == "contract"  # stable still reflects the certificate


def test_convergence_exit_mode_maps_fixed_point():
    v = V(_base(exit_reason="convergence_exit", stability_gates=_gates(True), stability_accepted=True))
    assert v["reason"] == "fixed_point"
    assert v["stable"] == "contract"


def test_no_certificate_is_honest_unknown():
    # too few tokens: no stability_gates, no accept decision → None, NOT a fabricated False/guess
    v = V(_base(stability_gates=None, stability_accepted=None))
    assert v["stable"] is None
    assert v["converged"] is None


def test_grounded_is_none_at_this_layer():
    # groundedness is a serving-time (JS) judgment; the token loop must not fabricate 1.0
    assert V(_base())["grounded"] is None


def test_missing_fields_do_not_crash():
    v = V({})  # empty out (defensive)
    assert v["depth"] is None and v["proximity"] is None
    assert v["stable"] is None and v["reason"] == "threshold_met"
    assert v["converged"] is None and v["grounded"] is None


if __name__ == "__main__":
    fns = [f for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {fn.__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)
