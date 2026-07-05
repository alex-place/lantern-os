"""Tests for the tolerant honesty-ledger reader (#2110)."""
import importlib.util
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SPEC = importlib.util.spec_from_file_location(
    "honesty_ledger", os.path.join(ROOT, "scripts", "honesty_ledger.py")
)
hl = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(hl)


def test_halueval_local_ok_field():
    assert hl.item_correct({"q": "?", "gold": "x", "ok": True}) is True
    assert hl.item_correct({"q": "?", "gold": "x", "ok": False}) is False
    assert hl.detected_field({"ok": True}) == "ok"


def test_epistemic_both_fields_is_whole_item_pass():
    assert hl.item_correct({"class_ok": True, "verified_ok": True}) is True
    # class right but verification wrong is NOT a whole-item pass.
    assert hl.item_correct({"class_ok": True, "verified_ok": False}) is False
    assert hl.detected_field({"class_ok": True, "verified_ok": True}) == "class_ok+verified_ok"


def test_plain_correct_and_passed_fields():
    assert hl.item_correct({"correct": True}) is True
    assert hl.item_correct({"passed": False}) is False


def test_unlabelable_row_is_none_not_false():
    # critical: "can't tell" must be distinguishable from "wrong" so an unscored file
    # doesn't masquerade as 0% accuracy.
    assert hl.item_correct({"q": "?", "gold": "x"}) is None


def test_read_accuracy_counts_and_surfaces_unscored(tmp_path):
    p = tmp_path / "f.jsonl"
    p.write_text(
        "\n".join(
            json.dumps(r)
            for r in [
                {"ok": True},
                {"ok": False},
                {"ok": True},
                {"no_correctness_field": 1},  # unscored
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    r = hl.read_accuracy(str(p))
    assert r["n"] == 3 and r["correct"] == 2
    assert r["accuracy"] == round(2 / 3, 4)
    assert r["unscored"] == 1
    assert r["field"] == "ok"


def test_reads_real_ledgers_if_present():
    # Regression guard against the exact files the skill failed to read this session.
    for rel in (
        "data/eval/halueval-local/honesty-balanced-1783226833.jsonl",
        "data/eval/epistemic/honesty-balanced-1783255006.jsonl",
    ):
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            continue
        r = hl.read_accuracy(path)
        assert r["n"] > 0, f"{rel} produced zero scorable rows"
        assert r["accuracy"] is not None
        assert 0.0 <= r["accuracy"] <= 1.0
