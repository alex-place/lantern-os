"""
Unit tests for the Oracle active loop (ACT-TO-KNOW) — the fifth move's first brick.

These pin the harness's classification logic (pin / confirmed / ceiling_break) and the
grounded-record shape. The measurement's rigorous core — that a corpus-absent fact is a
ceiling-break independent of any baseline — is asserted directly.
"""
from __future__ import annotations

import experiments.oracle_active_loop as loop
from experiments.oracle_active_loop import Question, classify, run_active_loop, summarize


def test_pin_is_named_never_bluffed():
    q = Question(id="p", text="unknowable now", act=lambda: None, actionable=False)
    assert classify(q, None) == "pin"
    rec = run_active_loop([q])[0]
    assert rec["class"] == "pin"
    assert rec["resolved"] is None          # a pin is never given a fabricated answer
    assert rec["unknown"] == "unknowable now"


def test_confirmed_when_inference_was_right():
    q = Question(id="c", text="2+2?", act=lambda: 4, passive=4, passive_conf=0.9,
                 inference_reachable=True)
    assert classify(q, 4) == "confirmed"


def test_baseline_corrected_is_ceiling_break():
    q = Question(id="b", text="guess", act=lambda: 7, passive=3, passive_conf=0.5,
                 inference_reachable=True)
    assert classify(q, 7) == "ceiling_break"   # reality overruled the belief


def test_corpus_absent_is_ceiling_break_regardless_of_baseline():
    # The rigorous core: a live-state / computation fact is a ceiling-break by
    # construction — even if the passive belief happens to match, no fixed corpus
    # could have contained it, so ACTING is what produced the knowledge.
    q = Question(id="a", text="current sha", act=lambda: "abc123", passive="abc123",
                 passive_conf=1.0, inference_reachable=False)
    assert classify(q, "abc123") == "ceiling_break"


def test_record_shape_and_certainty():
    q = Question(id="r", text="hash", act=lambda: "deadbeef", inference_reachable=False)
    rec = run_active_loop([q], stamp="2026-07-21T00:00:00Z")[0]
    assert rec["resolved"] == "deadbeef"
    assert rec["resolved_conf"] == 1.0        # reality answered — certain
    assert rec["source"] == "execution"
    assert rec["surface"] == "local-code"
    assert rec["stamp"] == "2026-07-21T00:00:00Z"


def test_summary_splits_rigorous_from_baseline():
    recs = run_active_loop([
        Question(id="1", text="", act=lambda: "x", inference_reachable=False),          # rigorous
        Question(id="2", text="", act=lambda: 9, passive=1, inference_reachable=True),   # baseline
        Question(id="3", text="", act=lambda: 5, passive=5, inference_reachable=True),   # confirmed
        Question(id="4", text="", act=lambda: None, actionable=False),                   # pin
    ])
    s = summarize(recs)
    assert s["questions"] == 4
    assert s["confirmed"] == 1
    assert s["pins"] == 1
    assert s["ceiling_breaks_total"] == 2
    assert s["ceiling_breaks_corpus_absent_rigorous"] == 1
    assert s["ceiling_breaks_baseline_corrected"] == 1


def test_seed_runs_and_manufactures_corpus_absent_facts():
    # The real seed set must actually resolve live facts and name its pin.
    recs = run_active_loop(loop.seed_questions())
    s = summarize(recs)
    assert s["pins"] >= 1                                   # the future-run pin, named
    assert s["ceiling_breaks_corpus_absent_rigorous"] >= 3  # live-state / computation facts
    # every non-pin record carries a concrete resolved fact
    for r in recs:
        if r["class"] != "pin":
            assert r["resolved"] is not None
