"""
Unit tests for the Phase 3 HumanEval reranker (issue #1292).

These are GPU-free: they feed the reranker mock candidate *strings* (correct,
buggy, partially-correct) and assert it selects the right one using only the
prompt's in-prompt `>>>` examples + self-consistency. No model, no network.

Run: python -m pytest tests/test_humaneval_rerank.py -q
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))

import humaneval_rerank as rr  # noqa: E402


# Canonical HumanEval/0 prompt — exercises the real docstring/example format.
HAS_CLOSE_PROMPT = '''from typing import List


def has_close_elements(numbers: List[float], threshold: float) -> bool:
    """ Check if in given list of numbers, are any two numbers closer to each other than
    given threshold.
    >>> has_close_elements([1.0, 2.0, 3.0], 0.5)
    False
    >>> has_close_elements([1.0, 2.8, 3.0, 4.0, 5.0, 2.0], 0.3)
    True
    """
'''

HAS_CLOSE_CORRECT = HAS_CLOSE_PROMPT + '''    for i in range(len(numbers)):
        for j in range(i + 1, len(numbers)):
            if abs(numbers[i] - numbers[j]) < threshold:
                return True
    return False
'''

# Always returns False → fails the second example (expects True).
HAS_CLOSE_BUGGY = HAS_CLOSE_PROMPT + '''    return False
'''


def test_extract_examples_canonical_doctest():
    ex = rr.extract_examples(HAS_CLOSE_PROMPT, "has_close_elements")
    assert ex == [
        ("has_close_elements([1.0, 2.0, 3.0], 0.5)", "False"),
        ("has_close_elements([1.0, 2.8, 3.0, 4.0, 5.0, 2.0], 0.3)", "True"),
    ]


def test_extract_examples_inline_assertion_shape():
    prompt = (
        'def add(a, b):\n'
        '    """Sum.\n'
        '    >>> add(2, 3) == 5\n'
        '    True\n'
        '    """\n'
    )
    ex = rr.extract_examples(prompt, "add")
    assert ("add(2, 3)", "5") in ex


def test_extract_examples_skips_print_and_nonliteral():
    prompt = (
        'def f(s):\n'
        '    """Demo.\n'
        '    >>> print(f("x"))\n'
        '    x!\n'
        '    >>> f("y")\n'
        '    some prose, not a literal\n'
        '    """\n'
    )
    # print(...) is not a direct entry_point call; the prose expected is not a literal.
    assert rr.extract_examples(prompt, "f") == []


def test_evaluate_candidate_counts_example_passes():
    examples = rr.extract_examples(HAS_CLOSE_PROMPT, "has_close_elements")
    good = rr.evaluate_candidate(HAS_CLOSE_CORRECT, examples, "has_close_elements")
    bad = rr.evaluate_candidate(HAS_CLOSE_BUGGY, examples, "has_close_elements")
    assert good["passes"] == 2 and good["ok"] is True
    assert bad["passes"] == 1  # passes the False example, fails the True one


def test_evaluate_candidate_no_parse():
    examples = rr.extract_examples(HAS_CLOSE_PROMPT, "has_close_elements")
    res = rr.evaluate_candidate(None, examples, "has_close_elements")
    assert res["passes"] == 0 and res["ok"] is False


def test_rerank_prefers_more_example_passes():
    examples_prompt = HAS_CLOSE_PROMPT
    best, info = rr.rerank([HAS_CLOSE_BUGGY, HAS_CLOSE_CORRECT], examples_prompt, "has_close_elements")
    assert best == HAS_CLOSE_CORRECT
    assert info["method"] == "examples" and info["best_example_passes"] == 2


def test_rerank_drops_unparseable_then_picks_correct():
    best, info = rr.rerank([None, HAS_CLOSE_BUGGY, HAS_CLOSE_CORRECT], HAS_CLOSE_PROMPT, "has_close_elements")
    assert best == HAS_CLOSE_CORRECT
    assert info["n_candidates"] == 2  # the None was dropped


# Partial-pass tie → self-consistency picks the majority output cluster.
ADD_PROMPT = (
    'def add_one(x):\n'
    '    """Add one.\n'
    '    >>> add_one(1)\n'
    '    2\n'
    '    >>> add_one(5)\n'
    '    6\n'
    '    """\n'
)
ADD_PARTIAL_99 = ADD_PROMPT + '    return x + 1 if x == 1 else 99\n'   # ex1 ✓, ex2 → 99 ✗
ADD_PARTIAL_77 = ADD_PROMPT + '    return x + 1 if x == 1 else 77\n'   # ex1 ✓, ex2 → 77 ✗
ADD_CORRECT = ADD_PROMPT + '    return x + 1\n'                        # both ✓


def test_rerank_tiebreak_by_self_consistency():
    # Two candidates agree (→ 99) on the failing example, one dissents (→ 77).
    # No full-passer present, so all tie at 1/2; the majority cluster {99, 99} wins.
    best, info = rr.rerank([ADD_PARTIAL_99, ADD_PARTIAL_77, ADD_PARTIAL_99],
                           ADD_PROMPT, "add_one")
    assert best == ADD_PARTIAL_99
    assert info["best_example_passes"] == 1


def test_rerank_full_passer_beats_partials():
    best, _ = rr.rerank([ADD_PARTIAL_99, ADD_PARTIAL_77, ADD_CORRECT], ADD_PROMPT, "add_one")
    assert best == ADD_CORRECT


def test_rerank_no_examples_falls_back_to_source_consistency():
    prompt = 'def g(x):\n    """No examples here, just prose."""\n'
    a = prompt + '    return x * 2\n'
    b = prompt + '    return x + x\n'
    # two identical-source 'a' candidates vs one 'b' → majority source cluster is 'a'
    best, info = rr.rerank([a, b, a], prompt, "g")
    assert best == a
    assert info["method"] == "self-consistency" and info["n_examples"] == 0


def test_rerank_all_none_returns_none():
    best, info = rr.rerank([None, None], HAS_CLOSE_PROMPT, "has_close_elements")
    assert best is None and info["method"] == "none"


def test_integration_make_candidate_feeds_reranker():
    """The eval harness's make_candidate output must be reranker-compatible.
    Importing eval_humaneval_ouro is GPU-free — torch/datasets load lazily in main()."""
    import eval_humaneval_ouro as ev

    ep = "has_close_elements"
    correct_body = (
        "    for i in range(len(numbers)):\n"
        "        for j in range(i + 1, len(numbers)):\n"
        "            if abs(numbers[i] - numbers[j]) < threshold:\n"
        "                return True\n"
        "    return False\n"
    )
    buggy_body = "    return False\n"
    c_correct = ev.make_candidate(correct_body, ep, HAS_CLOSE_PROMPT)
    c_buggy = ev.make_candidate(buggy_body, ep, HAS_CLOSE_PROMPT)
    assert c_correct is not None and c_buggy is not None
    best, info = rr.rerank([c_buggy, c_correct], HAS_CLOSE_PROMPT, ep)
    assert best == c_correct and info["best_example_passes"] == 2
