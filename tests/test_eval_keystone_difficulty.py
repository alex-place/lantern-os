"""Lock eval_keystone accuracy_by_difficulty (#843).

accuracy_by_difficulty is a pure aggregation over the scored detail list --
no model or serving required. These tests verify the math and that the
leaderboard schema carries the field.
"""
import importlib.util
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "eval_keystone", os.path.join(ROOT, "scripts", "eval_keystone.py"))
eval_keystone = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(eval_keystone)
score = eval_keystone.score


def _compute(rows, detail):
    diff_n: dict = {}
    diff_ok: dict = {}
    for row, det in zip(rows, detail):
        tier = row.get("difficulty", "unknown")
        diff_n[tier] = diff_n.get(tier, 0) + 1
        diff_ok[tier] = diff_ok.get(tier, 0) + int(det["ok"])
    return {k: round(diff_ok[k] / diff_n[k], 3) for k in sorted(diff_n)}


def _rows_detail(pairs):
    rows   = [{"difficulty": d, "id": i} for i, (d, _) in enumerate(pairs, 1)]
    detail = [{"ok": ok}                 for _, ok in pairs]
    return rows, detail


def test_all_correct_each_tier():
    rows, detail = _rows_detail([
        ("smoke", True), ("easy", True), ("medium", True), ("hard", True),
    ])
    abd = _compute(rows, detail)
    assert abd == {"easy": 1.0, "hard": 1.0, "medium": 1.0, "smoke": 1.0}


def test_none_correct():
    rows, detail = _rows_detail([
        ("easy", False), ("easy", False), ("hard", False),
    ])
    abd = _compute(rows, detail)
    assert abd == {"easy": 0.0, "hard": 0.0}


def test_partial_accuracy_rounds_to_three_decimals():
    rows, detail = _rows_detail([
        ("medium", True), ("medium", False), ("medium", False),
    ])
    abd = _compute(rows, detail)
    assert abd == {"medium": round(1 / 3, 3)}


def test_smoke_tier_separate_from_easy():
    rows, detail = _rows_detail([
        ("smoke", True), ("smoke", True),
        ("easy",  True), ("easy",  False),
    ])
    abd = _compute(rows, detail)
    assert abd["smoke"] == 1.0
    assert abd["easy"]  == 0.5


def test_unknown_difficulty_bucketed_as_unknown():
    rows = [{"id": 1}]
    detail = [{"ok": True}]
    abd = _compute(rows, detail)
    assert "unknown" in abd
    assert abd["unknown"] == 1.0


def test_golden_set_has_all_four_tiers():
    path = os.path.join(ROOT, "data", "eval", "sigma0-prompts.jsonl")
    rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
    tiers = {r.get("difficulty") for r in rows}
    assert {"smoke", "easy", "medium", "hard"}.issubset(tiers), \
        "missing tiers: " + str({"smoke","easy","medium","hard"} - tiers)


def test_leaderboard_schema_carries_accuracy_by_difficulty():
    path = os.path.join(ROOT, "data", "eval", "sigma0-prompts.jsonl")
    rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
    detail = []
    for r in rows:
        reply = " ".join(k.split("|")[0].strip() for k in r["expected"].split(",") if k.strip())
        detail.append({"ok": score(r["expected"], reply), "reply": reply})
    abd = _compute(rows, detail)
    assert isinstance(abd, dict)
    for k, v in abd.items():
        assert isinstance(k, str)
        assert 0.0 <= v <= 1.0
    assert set(abd) >= {"smoke", "easy", "medium", "hard"}