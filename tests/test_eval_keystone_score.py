"""Lock the eval_keystone keyword-coverage rubric (Gate A scorer).

`score()` is the grading function for the Sigma-zero golden set
(`data/eval/sigma0-prompts.jsonl`). These tests pin its semantics so a serving
change is never silently graded by a different rubric:

  - comma  = AND   (every key must be covered)
  - pipe   = OR    (a key is covered if any alternative appears)
  - matching is case-insensitive substring
  - legacy `expected` strings (no pipe) behave exactly as before
"""
import importlib.util
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "eval_keystone", os.path.join(ROOT, "scripts", "eval_keystone.py"))
eval_keystone = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(eval_keystone)
score = eval_keystone.score


def test_single_key_substring_case_insensitive():
    assert score("Paris", "The capital is paris.") is True
    assert score("paris", "It is PARIS") is True
    assert score("paris", "London") is False


def test_comma_is_conjunctive_all_keys_required():
    expected = "observe, remember, reason, act, verify, converge"
    full = "observe then remember then reason then act then verify then converge"
    assert score(expected, full) is True
    # missing one key -> fail
    assert score(expected, "observe remember reason act verify") is False


def test_pipe_is_disjunctive_within_a_key():
    assert score("quota_hit|quota hit", "state was QUOTA_HIT") is True
    assert score("quota_hit|quota hit", "the quota hit a wall") is True
    assert score("quota_hit|quota hit", "circuit open") is False


def test_pipe_and_comma_combined():
    expected = "weight modification|retraining, persistent"
    assert score(expected, "persistent learning, not retraining") is True
    assert score(expected, "persistent learning, not weight modification") is True
    # has an alternative for key1 but missing key2 ("persistent")
    assert score(expected, "not retraining") is False


def test_legacy_no_pipe_unchanged():
    # a plain key with no pipe must match identically to a literal substring test
    assert score("central processing unit", "CPU = Central Processing Unit") is True
    assert score("4", "the answer is 4") is True
    assert score("4", "the answer is four") is False


def test_empty_expected_is_vacuously_true():
    # no keys -> all() over empty -> True (matches prior behaviour)
    assert score("", "anything") is True
    assert score("  ,  ", "anything") is True


def test_golden_set_parses_and_is_well_formed():
    """The shipped golden set must be valid JSONL, >=50 prompts, unique ids,
    every row scorable (expected non-empty), and self-scoring (a reply equal to
    `expected` with pipes/commas stripped passes its own rubric)."""
    import json
    path = os.path.join(ROOT, "data", "eval", "sigma0-prompts.jsonl")
    rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
    assert len(rows) >= 50, f"golden set has only {len(rows)} prompts (<50)"
    ids = [r["id"] for r in rows]
    assert len(set(ids)) == len(ids), "duplicate ids in golden set"
    for r in rows:
        assert r.get("prompt", "").strip(), f"row {r.get('id')} has empty prompt"
        assert r.get("expected", "").strip(), f"row {r.get('id')} has empty expected"
        # a reply containing the FIRST alternative of every key must self-pass
        synthetic = " ".join(
            k.split("|")[0].strip() for k in r["expected"].split(",") if k.strip())
        assert score(r["expected"], synthetic), f"row {r['id']} not self-scoring"
