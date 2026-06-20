"""
Offline unit tests for the execution-grounded coding benchmark (#776).

These exercise the SCORING harness — extract_code, run_checks (real subprocess
execution of canned code), the verbosity metric, and the leaderboard row builder
— with no model load, so the harness is verifiable without a GPU. The model
backends (http / loop) are intentionally not tested here; they are thin I/O.
"""
import os
import sys

import pytest

# scripts/ is not on pytest's pythonpath (apps, src) — add it for this module.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))

import eval_coding_ouro as E  # noqa: E402


def test_extract_code_strips_fences_and_prose():
    text = "Sure!\n```python\ndef add(a, b):\n    return a + b\n```\nHope that helps."
    code = E.extract_code(text, "add")
    assert "def add(a, b):" in code
    assert "Sure!" not in code and "Hope that helps." not in code


def test_extract_code_from_raw_text_stops_at_prose():
    text = "def sq(x):\n    return x * x\nThat function squares its input."
    code = E.extract_code(text, "sq")
    assert code.strip().endswith("return x * x")
    assert "squares its input" not in code


def test_extract_code_skips_noncompiling_candidate():
    # first fenced block is broken (missing colon); the second fenced block is
    # valid — extract_code iterates candidates and returns the one that compiles.
    text = ("```python\ndef f(x)\n    return x\n```\n"
            "```python\ndef f(x):\n    return x + 1\n```\n")
    code = E.extract_code(text, "f")
    r = E.run_checks(code, "f", [("f(1)", 2)])
    assert r["parsed"] and r["passed"] == 1


def test_run_checks_all_pass():
    r = E.run_checks("def add(a, b):\n    return a + b\n", "add",
                     [("add(2, 3)", 5), ("add(-1, 1)", 0)])
    assert r["parsed"] is True
    assert r["passed"] == 2 and r["total"] == 2
    assert r["fails"] == []


def test_run_checks_reports_failures():
    r = E.run_checks("def add(a, b):\n    return a - b\n", "add",
                     [("add(2, 3)", 5), ("add(5, 0)", 5)])
    assert r["parsed"] is True
    assert r["passed"] == 1 and r["total"] == 2          # add(5,0)==5 passes by luck
    assert any(f.get("expr") == "add(2, 3)" for f in r["fails"])


def test_run_checks_noncompiling_is_not_parsed():
    r = E.run_checks("def add(a, b)\n    return a + b", "add", [("add(1, 1)", 2)])
    assert r["parsed"] is False
    assert r["passed"] == 0
    assert "compile" in (r["error"] or "")


def test_run_checks_runtime_exception_counts_as_fail():
    r = E.run_checks("def boom(x):\n    return 1 / 0\n", "boom", [("boom(1)", 1)])
    assert r["parsed"] is True and r["passed"] == 0
    assert "error" in r["fails"][0]


def test_run_checks_timeout_does_not_hang():
    r = E.run_checks("def loop(x):\n    while True:\n        pass\n", "loop",
                     [("loop(1)", 1)], timeout=2)
    assert r["passed"] == 0
    assert r["error"] == "timeout"


def test_run_checks_handles_model_stdout_noise():
    # generated code that prints must not confuse the __RESULT__ parser
    code = "def f(x):\n    print('chatter')\n    return x * 2\n"
    r = E.run_checks(code, "f", [("f(3)", 6)])
    assert r["parsed"] and r["passed"] == 1


def test_verbosity_math():
    v = E.verbosity(["aaaa", "bb bb"], n_correct=1)
    assert v["total_reply_bytes"] == 9          # 4 + 5
    assert v["total_reply_words"] == 3          # 1 + 2
    assert v["bytes_per_correct"] == 9.0
    assert v["words_per_correct"] == 3.0


def test_verbosity_guards_zero_correct():
    v = E.verbosity(["anything"], n_correct=0)
    assert v["bytes_per_correct"] is None
    assert v["words_per_correct"] is None


def test_verbosity_counts_utf8_bytes_not_chars():
    v = E.verbosity(["é"], n_correct=1)          # 1 char, 2 UTF-8 bytes
    assert v["total_reply_bytes"] == 2


def test_summarize_row_shape():
    detail = [{"passed": 2, "total": 2}, {"passed": 0, "total": 1}, {"passed": 1, "total": 1}]
    replies = ["abc", "de", "fghij"]
    row = E.summarize(detail, replies, total_dt=6.0, label="t", ts="123",
                      golden="coding-golden.jsonl", engine="http", mode=None,
                      depths=[], contractions=[])
    assert row["benchmark"] == "coding-exec"
    assert row["n"] == 3
    assert row["passed"] == 2                    # tasks fully passing
    assert row["pass@1"] == round(2 / 3, 3)
    assert row["accuracy"] == row["pass@1"]      # cross-benchmark alias
    assert row["assertions_passed"] == 3 and row["assertions_total"] == 4
    assert row["assertion_pass_rate"] == 0.75
    assert row["mode"] is None                   # http engine -> no loop mode
    assert "bytes_per_correct" in row and "total_reply_words" in row


def test_summarize_includes_loop_depth_when_present():
    detail = [{"passed": 1, "total": 1}]
    row = E.summarize(detail, ["x"], total_dt=1.0, label="t", ts="1", golden="g",
                      engine="loop", mode="converge", depths=[2.0, 4.0],
                      contractions=[0.01, 0.03])
    assert row["mode"] == "converge"
    assert row["mean_depth"] == 3.0
    assert row["mean_contraction"] == 0.02


def test_golden_files_present_and_well_formed():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    import json
    for name in ("coding-golden.jsonl", "mbpp-basic.jsonl"):
        path = os.path.join(root, "data", "eval", name)
        assert os.path.exists(path), f"missing golden file {name}"
        rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
        assert rows, f"{name} is empty"
        for r in rows:
            assert {"id", "name", "fn", "prompt", "checks"} <= set(r), f"{name} row missing keys: {r}"
            assert r["checks"], f"{name} task {r['id']} has no checks"
            for c in r["checks"]:
                assert len(c) == 2, f"{name} task {r['id']} check not [expr, expected]: {c}"


def test_mbpp_reference_solutions_pass_their_own_checks():
    """Each MBPP task's checks must be satisfiable — verify with a known-good
    reference solution so a typo'd expected value can't silently ship."""
    refs = {
        "sum_list": "def sum_list(nums):\n    return sum(nums)\n",
        "max_of_three": "def max_of_three(a, b, c):\n    return max(a, b, c)\n",
        "factorial": "def factorial(n):\n    r = 1\n    for i in range(2, n + 1):\n        r *= i\n    return r\n",
        "count_vowels": "def count_vowels(s):\n    return sum(c.lower() in 'aeiou' for c in s)\n",
        "is_palindrome": "def is_palindrome(s):\n    return s == s[::-1]\n",
        "gcd": "def gcd(a, b):\n    import math\n    return math.gcd(a, b)\n",
        "fib": "def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n",
        "second_largest": "def second_largest(nums):\n    return sorted(set(nums))[-2]\n",
        "remove_duplicates": "def remove_duplicates(lst):\n    seen = []\n    for x in lst:\n        if x not in seen:\n            seen.append(x)\n    return seen\n",
        "count_words": "def count_words(s):\n    return len(s.split())\n",
        "flatten": "def flatten(lst):\n    return [x for sub in lst for x in sub]\n",
        "is_anagram": "def is_anagram(a, b):\n    return sorted(a) == sorted(b)\n",
        "sum_digits": "def sum_digits(n):\n    return sum(int(d) for d in str(n))\n",
        "char_frequency": "def char_frequency(s):\n    d = {}\n    for c in s:\n        d[c] = d.get(c, 0) + 1\n    return d\n",
        "reverse_words": "def reverse_words(s):\n    return ' '.join(reversed(s.split()))\n",
        "clamp": "def clamp(x, lo, hi):\n    return max(lo, min(x, hi))\n",
        "count_occurrences": "def count_occurrences(lst, x):\n    return lst.count(x)\n",
        "list_intersection": "def list_intersection(a, b):\n    return sorted(set(a) & set(b))\n",
    }
    import json
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(root, "data", "eval", "mbpp-basic.jsonl")
    rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
    assert set(refs) == {r["fn"] for r in rows}, "reference solutions out of sync with mbpp-basic.jsonl"
    for r in rows:
        chk = E.run_checks(refs[r["fn"]], r["fn"], [tuple(c) for c in r["checks"]])
        assert chk["parsed"], f"{r['fn']} reference did not compile"
        assert chk["passed"] == chk["total"], f"{r['fn']} reference failed its own checks: {chk['fails']}"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
