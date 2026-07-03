"""
ADR-0015 front-half tests — the Qwen-teacher crystallization pipeline
(propose -> verify -> scrub -> decontaminate -> pack), all runnable with NO GPU and NO
Qwen endpoint. The live Qwen call is monkeypatched; the green-subprocess verify gate and the
13-gram decontamination run for real against injected fixtures.

Run: python -m pytest tests/test_qwen_teacher_crystallize.py -q
"""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import qwen_teacher_crystallize as q  # noqa: E402


# ── parser: the live proposer's replies must parse into the verify-gate schema ──────────────
def test_parse_json_reply():
    reply = json.dumps({"fn": "sq", "code": "def sq(x):\n    return x * x",
                        "asserts": ["assert sq(3) == 9", "assert sq(0) == 0"]})
    cand = q._parse_candidate(reply, "square a number")
    assert cand is not None
    assert cand["fn"] == "sq"
    assert "def sq" in cand["code"]
    assert cand["asserts"] == ["assert sq(3) == 9", "assert sq(0) == 0"]
    assert cand["instruction"] == "square a number"


def test_parse_json_with_prose_around_it():
    reply = "Sure! Here is the function:\n" + json.dumps(
        {"fn": "dbl", "code": "def dbl(x):\n    return 2 * x", "asserts": ["assert dbl(4) == 8"]}
    ) + "\nHope that helps."
    cand = q._parse_candidate(reply, "double")
    assert cand and cand["fn"] == "dbl" and cand["asserts"] == ["assert dbl(4) == 8"]


def test_parse_fenced_code_block_lifts_asserts():
    reply = "```python\ndef cube(x):\n    return x ** 3\nassert cube(2) == 8\n```"
    cand = q._parse_candidate(reply, "cube")
    assert cand is not None
    assert cand["fn"] == "cube"
    # top-level asserts are lifted OUT of the function body (gate runs them separately)
    assert "assert" not in cand["code"]
    assert cand["asserts"] == ["assert cube(2) == 8"]


def test_parse_rejects_no_function_or_no_asserts():
    assert q._parse_candidate("just some prose, no code", "x") is None
    assert q._parse_candidate("def f(x):\n    return x", "no asserts") is None  # no asserts


# ── proposer: monkeypatch the HTTP call; no endpoint required ────────────────────────────────
def test_propose_with_qwen_monkeypatched(monkeypatch):
    calls = {"n": 0}

    def fake_chat(instruction, endpoint, model, timeout, temperature):
        calls["n"] += 1
        return json.dumps({"fn": "inc", "code": "def inc(x):\n    return x + 1",
                           "asserts": ["assert inc(1) == 2"]})

    monkeypatch.setattr(q, "_qwen_chat", fake_chat)
    cands = q.propose_with_qwen("increment", n=3)
    assert len(cands) == 3 and calls["n"] == 3
    assert all(c["fn"] == "inc" and c["asserts"] == ["assert inc(1) == 2"] for c in cands)


def test_propose_survives_endpoint_error(monkeypatch):
    import urllib.error

    def boom(*a, **k):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr(q, "_qwen_chat", boom)
    # A dead endpoint yields zero candidates, never an exception mid-corpus.
    assert q.propose_with_qwen("anything", n=2) == []


# ── verify gate: proposer output feeds the REAL green-subprocess gate ────────────────────────
def test_verify_keeps_correct_drops_wrong():
    good = {"fn": "add", "instruction": "add", "code": "def add(a, b):\n    return a + b",
            "asserts": ["assert add(2, 3) == 5"]}
    wrong = {"fn": "sub_bad", "instruction": "add", "code": "def sub_bad(a, b):\n    return a - b",
             "asserts": ["assert sub_bad(2, 3) == 5"]}
    verified, dropped = q.verify_candidates([good, wrong])
    assert len(verified) == 1 and verified[0]["output"].startswith("def add")
    assert verified[0]["input"] == ""  # code-gen row schema
    assert len(dropped) == 1


# ── decontamination: benchmark-overlapping rows are dropped ──────────────────────────────────
def test_decontaminate_drops_injected_overlap():
    pytest.importorskip("decontaminate_training")
    from decontaminate_training import normalize, ngrams, row_text, NGRAM
    rows = [{"instruction": "compute the length of the longest common subsequence of two strings",
             "input": "", "output": "def lcs(a, b):\n    return 0"}]
    bad = ngrams(normalize(row_text(rows[0])), NGRAM)  # inject THIS row's grams as "benchmark"
    kept, dropped = q.decontaminate_rows(list(rows), bad_grams=bad, min_overlap=1)
    assert kept == [] and len(dropped) == 1


def test_decontaminate_keeps_clean_rows():
    pytest.importorskip("decontaminate_training")
    rows = [{"instruction": "short", "input": "", "output": "def f():\n    return 1"}]
    kept, dropped = q.decontaminate_rows(list(rows), bad_grams=set(), min_overlap=1)
    assert kept == rows and dropped == []


# ── end-to-end front half via the stub proposer (no endpoint) ────────────────────────────────
def test_crystallize_end_to_end_dry_run():
    prompts = [{"instruction": "write add(a, b)"}]
    rec = q.crystallize(prompts, q._stub_proposer, n_per_prompt=2, out_path="/nope", csf_out=None,
                        dry_run=True, decontaminate=True, bad_grams=set())  # empty index → keep all
    assert rec["result"] == "verified-corpus"
    assert rec["evidence"]["kept"] == 1          # 1 good kept
    assert rec["evidence"]["verify_dropped"] == 1  # 1 wrong dropped by the gate
    assert rec["evidence"]["decontaminated"] is True


def test_self_test_passes():
    assert q._self_test() == 0
