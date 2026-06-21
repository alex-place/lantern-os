"""Locks the rollover promotion-gate threshold logic (#895).

The pure `evaluate_gate` must:
  - Gate B: pass iff accuracy strictly beats the 0.34 cold baseline.
  - Gate F: pass iff bytes_per_correct does not regress vs the baseline row;
    skip (None) when no baseline / missing values.
  - emit a well-formed [claim, evidence, confidence, source] grounding envelope.
"""
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

rollover_gate = pytest.importorskip("rollover_gate")
evaluate_gate = rollover_gate.evaluate_gate


def row(accuracy=0.5, bytes_per_correct=100.0, ts="1", label="keystone-assist"):
    return {"ts": ts, "label": label, "accuracy": accuracy,
            "bytes_per_correct": bytes_per_correct, "rollover_stage": "assist"}


def test_gate_b_boundary_034_is_not_a_pass():
    # Exactly at the cold floor must NOT advance (strictly greater required).
    v = evaluate_gate(row(accuracy=0.34), baseline_row=None, stage="assist")
    assert v["gate_b"]["passed"] is False
    assert v["passed"] is False


def test_gate_b_just_above_floor_passes():
    v = evaluate_gate(row(accuracy=0.341), baseline_row=None, stage="assist")
    assert v["gate_b"]["passed"] is True
    # No baseline → Gate F skipped → overall pass on Gate B alone.
    assert v["gate_f"] is None
    assert v["passed"] is True


def test_gate_b_below_floor_fails():
    v = evaluate_gate(row(accuracy=0.20), baseline_row=None, stage="assist")
    assert v["passed"] is False


def test_gate_f_cost_regression_blocks_even_when_accuracy_passes():
    # accuracy clears Gate B, but cost per correct got worse than baseline.
    run = row(accuracy=0.60, bytes_per_correct=200.0)
    base = row(accuracy=0.50, bytes_per_correct=100.0, ts="0", label="baseline")
    v = evaluate_gate(run, baseline_row=base, stage="assist")
    assert v["gate_b"]["passed"] is True
    assert v["gate_f"]["passed"] is False
    assert v["passed"] is False


def test_gate_f_cost_equal_or_lower_passes():
    run = row(accuracy=0.60, bytes_per_correct=90.0)
    base = row(accuracy=0.50, bytes_per_correct=100.0, ts="0", label="baseline")
    v = evaluate_gate(run, baseline_row=base, stage="assist")
    assert v["gate_f"]["passed"] is True
    assert v["passed"] is True


def test_envelope_is_well_formed_and_stage_tagged():
    v = evaluate_gate(row(accuracy=0.60), baseline_row=None, stage="default")
    env = v["envelope"]
    assert set(env) == {"claim", "evidence", "confidence", "source"}
    assert "default" in env["claim"]
    assert isinstance(env["evidence"], list) and env["evidence"]
    assert 0.0 <= env["confidence"] <= 1.0
    assert env["source"].startswith("data/eval/leaderboard.jsonl")


def test_failing_gate_zeroes_confidence():
    v = evaluate_gate(row(accuracy=0.10), baseline_row=None, stage="assist")
    assert v["envelope"]["confidence"] == 0.0
