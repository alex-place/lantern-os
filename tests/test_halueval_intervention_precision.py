"""
Torch-free, API-free unit tests for experiments/halueval_intervention_precision.py (#1941 metric 4).

The live precision number needs OPENAI_API_KEY (gpt-4o-mini logprobs) — out of scope here. These
validate the gate port + precision math on SYNTHETIC bits, so the harness is trustworthy before the
API run. The gate is a mirror of surprise-intervene.js; these tests pin that behaviour.

Run: python tests/test_halueval_intervention_precision.py    (also pytest-compatible)
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "experiments"))
import halueval_intervention_precision as H  # noqa: E402


# ── threshold port (mirrors surprise-intervene.js calibratedThresholdBits + env override) ─────
def test_threshold_unknown_model_is_default_5():
    assert H.calibrated_threshold_bits(None) == 5.0
    assert H.calibrated_threshold_bits("some-unseen-model") == 5.0


def test_threshold_calibrated_and_family_base():
    assert abs(H.calibrated_threshold_bits("qwen2.5-coder:1.5b") - 1.092) < 1e-9
    assert abs(H.calibrated_threshold_bits("mistral") - 0.336) < 1e-9
    # family base resolves (mistral:latest → mistral), matching calibrationFor()'s split(':')[0]
    assert H.calibrated_threshold_bits("mistral:latest") == H.calibrated_threshold_bits("mistral")


def test_threshold_env_override_wins():
    assert H.calibrated_threshold_bits("qwen2.5-coder:1.5b", env_bits=2.0) == 2.0
    assert H.calibrated_threshold_bits(None, env_bits=0) == 5.0        # non-positive → ignored


# ── the trigger gate (findTriggerSpans "fires?") ──────────────────────────────────────────────
def test_gate_fires_only_above_threshold():
    assert H.would_intervene([1.5] * 16, threshold=5.0) is False       # the #1940 small-model case
    assert H.would_intervene([6.0] * 16, threshold=5.0) is True
    # calibrated: the SAME 1.5-bit stream DOES fire under qwen's ~1.09 threshold (#1940 fix)
    assert H.would_intervene([1.5] * 16, threshold=H.calibrated_threshold_bits("qwen2.5-coder:1.5b")) is True


def test_gate_needs_a_full_window():
    assert H.would_intervene([9.0] * 15, threshold=5.0) is False       # < window ⇒ no span
    assert H.would_intervene([9.0] * 16, threshold=5.0) is True


def test_gate_finds_a_high_span_inside_a_calm_reply():
    bits = [0.2] * 40 + [7.0] * 16 + [0.2] * 40                        # one bursty span
    assert H.would_intervene(bits, threshold=5.0) is True


def test_gate_ignores_nonfinite_bits():
    assert H.would_intervene([float("nan")] * 20, threshold=5.0) is False


# ── precision math ────────────────────────────────────────────────────────────────────────────
def _rec(mean, halluc):
    return {"bits": [mean] * 16, "hallucinated": halluc}


def test_precision_tp_fp_math():
    recs = [_rec(6.0, True)] * 3 + [_rec(6.0, False)] * 1 + [_rec(0.3, True)] * 2
    out = H.precision_report(recs, threshold=5.0)
    assert out["interventions"] == 4          # the four high-bit replies fire
    assert out["true_positives"] == 3 and out["false_positives"] == 1
    assert out["intervention_precision"] == 0.75
    assert out["accept_gate_precision>=0.60"] is True
    assert out["hallucinations"] == 5 and out["gate_recall"] == round(3 / 5, 4)


def test_precision_below_gate_fails_accept():
    recs = [_rec(6.0, True)] * 1 + [_rec(6.0, False)] * 3              # 1 TP / 3 FP → 0.25
    out = H.precision_report(recs, threshold=5.0)
    assert out["intervention_precision"] == 0.25
    assert out["accept_gate_precision>=0.60"] is False


def test_precision_none_when_gate_never_fires():
    out = H.precision_report([_rec(0.2, True), _rec(0.3, False)], threshold=5.0)
    assert out["interventions"] == 0
    assert out["intervention_precision"] is None
    assert out["accept_gate_precision>=0.60"] is False


def test_logprobs_to_bits():
    import math
    # p=0.5 → -log2(0.5)=1 bit; p=1 → 0 bits
    bits = H.logprobs_to_bits([math.log(0.5), math.log(1.0), None])
    assert abs(bits[0] - 1.0) < 1e-9 and abs(bits[1] - 0.0) < 1e-9
    assert len(bits) == 2                                              # None dropped


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"  ok  - {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL- {fn.__name__}\n       {e}")
    print(f"\n{'all passed' if not failed else str(failed) + ' FAILED'} ({len(fns)} tests)")
    sys.exit(1 if failed else 0)
