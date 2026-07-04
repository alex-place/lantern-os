"""#1966 — paired-difference eval stats: known-answer coverage for the pure functions."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
from eval_paired_diff import load_run, paired_stats, sign_test_p  # noqa: E402


def _known_pair():
    """A passes t0..t4; B loses t4 and wins t5..t7 → 3 wins / 1 loss / 6 ties."""
    a = {f"t{i}": i < 5 for i in range(10)}
    b = dict(a)
    b["t4"] = False
    b["t5"] = b["t6"] = b["t7"] = True
    return a, b


def test_known_answer_paired_stats():
    a, b = _known_pair()
    s = paired_stats(a, b)
    assert s["n"] == 10
    assert (s["mean_a"], s["mean_b"]) == (0.5, 0.7)
    assert (s["wins_b"], s["losses_b"], s["ties"]) == (3, 1, 6)
    assert s["paired_mean_diff"] == pytest.approx(0.2)
    assert s["sem"] == pytest.approx(0.2)
    assert s["ci95"][0] == pytest.approx(-0.192, abs=1e-3)
    assert s["ci95"][1] == pytest.approx(0.592, abs=1e-3)
    assert s["sign_test_p"] == pytest.approx(0.625)
    assert s["significant_at_95"] is False


def test_sign_test_exact_values():
    assert sign_test_p(0, 0) == 1.0
    assert sign_test_p(5, 0) == pytest.approx(0.0625)
    assert sign_test_p(0, 5) == pytest.approx(0.0625)   # symmetric
    assert sign_test_p(3, 1) == pytest.approx(0.625)


def test_disjoint_runs_raise():
    with pytest.raises(ValueError):
        paired_stats({"x": True}, {"y": True})


def test_single_shared_problem_has_zero_sem():
    s = paired_stats({"t": False, "only_a": True}, {"t": True, "only_b": False})
    assert s["n"] == 1
    assert s["sem"] == 0.0


def test_load_run_dedupes_and_skips_garbage(tmp_path):
    p = tmp_path / "run.jsonl"
    p.write_text("\n".join([
        json.dumps({"task_id": "t1", "ok": False}),
        "not json",
        json.dumps({"task_id": "t1", "ok": True}),   # later duplicate wins
        json.dumps({"no_task": 1}),
        json.dumps({"task_id": "t2", "ok": False}),
        "",
    ]), encoding="utf-8")
    assert load_run(str(p)) == {"t1": True, "t2": False}
