"""Tests for C1 — T0 predictive transform routing (#2837).

The claim: a cheap feature-based predictor picks the transform CSF-Omni's panel would have chosen
by brute force, so pruning the panel to the predicted transform(s) matches the ratio at a fraction
of the codec-runs. These pin the two things that make that true — the predictor names the right
transform per data shape, and the pruned panel loses ~nothing vs the full oracle.
"""
import struct
import sys
import math
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "experiments"))
sys.path.insert(0, str(REPO / "src"))

from csf_converge_t0_routing import predict_transforms, analyze_data  # noqa: E402

VALID_TIDS = {0, 1, 2, 3, 4, 5, 6, 7, 8}


def _f64_smooth(n=4000):
    return b"".join(struct.pack("<d", math.sin(i / 50.0) * 1000 + i * 0.01) for i in range(n))


def _i32_counter(n=8000):
    return b"".join(struct.pack("<i", 100000 + i * 3 + (i % 7)) for i in range(n))


def _jsonl(n=400):
    return b"".join(b'{"a":%d,"b":"x%d","c":%d}\n' % (i, i % 13, i * 2) for i in range(n))


def test_predict_is_deterministic_and_well_formed():
    data = _i32_counter()
    a = predict_transforms(data)
    b = predict_transforms(data)
    assert a == b, "same bytes must give the same shortlist"
    assert set(a) <= VALID_TIDS
    assert 0 in a, "identity is always the safety-net floor in the shortlist"


def test_smooth_numeric_arrays_route_to_a_shufdelta_transform():
    # the case T0 routing exists for: byte-shuffle+delta groups same-significance bytes of a
    # fixed-width smooth array and exposes the increments — transforms 6/7/8.
    for data in (_f64_smooth(), _i32_counter()):
        pred = predict_transforms(data)
        assert any(t in (6, 7, 8) for t in pred), f"expected a shufdelta in shortlist, got {pred}"


def test_jsonl_always_carries_col_in_the_shortlist():
    # col (2) reorders JSONL fields for the codec without lowering byte-entropy, so it's included
    # by a structural rule, not an entropy probe.
    pred = predict_transforms(_jsonl())
    assert 2 in pred, f"JSONL shortlist must carry col, got {pred}"


def test_high_entropy_text_keeps_identity_and_does_not_force_a_transform():
    text = (b"the quick brown fox jumps over the lazy dog. " * 200)
    pred = predict_transforms(text)
    assert 0 in pred


def test_routing_matches_the_full_panel_ratio_on_numeric_and_jsonl():
    # the gate, per file: routed (pruned panel) loses <= 0.5% vs the full-panel oracle AND prunes
    # real codec-runs. Verified end-to-end through the real omni panel.
    for name, data in [("f64", _f64_smooth()), ("i32", _i32_counter()), ("jsonl", _jsonl())]:
        r = analyze_data(name, data, effort="exhaustive")
        assert r is not None
        assert r["ratio_loss_pct"] <= 0.5, f"{name}: routed lost {r['ratio_loss_pct']}% vs oracle"
        assert r["hit"] is True, f"{name}: predicted shortlist missed the true winner t{r['oracle']['tid']}"
        assert r["candidate_reduction_x"] >= 2.0, f"{name}: only {r['candidate_reduction_x']}x fewer runs"
