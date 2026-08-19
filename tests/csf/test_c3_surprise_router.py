"""Tests for C3 — surprise-field depth router (#2837).

The router's job: send only the members that need the deep panel's extra transforms (smooth
numeric arrays → shufdelta) down to `exhaustive`, and route everything the `max` tier already
handles (text/JSONL/source) shallow — at ZERO ratio loss. These pin the surprise signal and the
route/verdict logic through the real omni panel.
"""
import struct
import sys
import math
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "experiments"))
sys.path.insert(0, str(REPO / "src"))

from csf_converge_c3_surprise_router import (  # noqa: E402
    transform_reduction, analyze, evaluate, SHALLOW, DEEP,
)


def _f64_smooth(n=2000):
    return b"".join(struct.pack("<d", math.sin(i / 50.0) * 1000 + i * 0.01) for i in range(n))


def _text():
    return (b"the quick brown fox jumps over the lazy dog. " * 400)


def test_surprise_signal_fires_on_numeric_arrays_not_on_text():
    # a smooth fixed-width array has a large transform-entropy reduction (shuffle+delta exposes
    # its structure); prose has ~none.
    assert transform_reduction(_f64_smooth()) > 0.3
    assert transform_reduction(_text()) < 0.05


def test_numeric_member_descends_to_exhaustive_with_zero_loss():
    r = analyze("f64", _f64_smooth(), threshold=0.30)
    assert r["routed_to"] == DEEP
    assert r["ratio_loss_pct"] == 0.0


def test_text_member_routes_shallow_and_max_already_matches_exhaustive():
    r = analyze("text", _text(), threshold=0.30)
    assert r["routed_to"] == SHALLOW
    # `max` carries the codec depth (lzma/brotli/col) so it ties exhaustive on prose: no loss.
    assert r["ratio_loss_pct"] <= 0.5


def test_router_passes_the_gate_and_beats_always_shallow_on_a_mixed_corpus():
    rows = [
        analyze("f64", _f64_smooth(), 0.30),
        analyze("i32", b"".join(struct.pack("<i", 100000 + i * 3) for i in range(4000)), 0.30),
        analyze("text", _text(), 0.30),
    ]
    summ = evaluate(rows)
    # matched exhaustive ratio at fewer runs...
    assert summ["worst_ratio_loss_pct"] <= 0.5
    assert summ["codec_run_reduction_x"] > 1.0
    # ...AND the shallow tier alone would NOT have sufficed (it bleeds ratio on the numeric arrays),
    # so the router is not redundant with just defaulting to `max`.
    assert summ["gate"]["balanced_already_suffices"] is False
    assert summ["gate"]["VERDICT"] == "PASS"
