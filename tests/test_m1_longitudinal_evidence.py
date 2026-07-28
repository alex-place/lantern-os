"""Regression tests for the M1 No-Free-Confidence longitudinal verifier (#2786).

The longitudinal scan (experiments/owned_math_m1_longitudinal.py) walks the convergence
ledger and flags any confidence rise along a hypothesis series that is NOT accompanied by
external-evidence influx (the M1 supermartingale). Its evidence signature used to `or`-chain
support fields and score any non-empty `evidence` string as support — so a record carrying
`evidence="no match found"` (which *means* zero support) looked identical to one carrying
real codebase grounding, and a legitimate ungrounded→grounded confidence rise on the SAME
claim was reported as a free-confidence violation. These tests pin the corrected behavior so
the false-positive class cannot silently return.
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "experiments"))

from owned_math_m1_longitudinal import (  # noqa: E402
    _evidence_signature,
    _evidence_added,
    _is_real_support,
    _support_count,
)


# The exact ledger records that produced the false positive (#2786): the same claim, 11 days
# apart, ungrounded ("no match found", sources []) at conf 0.6 then grounded ("codebase: …",
# sources [1]) at conf 0.85. That is evidence being ADDED — M1-legal.
UNGROUNDED = {
    "claim": "The term 'founder's wish door' is not widely recognized or documented.",
    "evidence": "no match found",
    "confidence": 0.6,
    "source": "none",
    "sources": [],
}
GROUNDED = {
    "claim": "The term 'founder's wish door' is not widely recognized or documented.",
    "evidence": "codebase: PROVIDERS.md, SCRIPTS.md",
    "confidence": 0.85,
    "source": "codebase-grep",
    "sources": ["codebase: PROVIDERS.md, SCRIPTS.md"],
}


def test_ungrounded_to_grounded_is_evidence_influx_not_a_violation():
    # The real bug: this transition must be seen as evidence added, so the confidence rise is
    # allowed. Before the fix, both signatures collapsed to identical tuples and it was flagged.
    assert _evidence_added(UNGROUNDED, GROUNDED) is True


def test_null_evidence_sentinels_score_zero_support():
    for sentinel in ("no match found", "none", "", "N/A", "no evidence", "not found"):
        assert _is_real_support(sentinel) == 0, sentinel
    assert _is_real_support("codebase: PROVIDERS.md") == 1
    assert _is_real_support("dream-chat/unisona.ai/local") == 1


def test_support_count_filters_sentinels_and_counts_real_entries():
    assert _support_count([]) == 0
    assert _support_count(["no match found"]) == 0            # a sentinel in a list is still none
    assert _support_count(["codebase: PROVIDERS.md, SCRIPTS.md"]) == 1
    assert _support_count(["a.py", "b.py", "none"]) == 2      # sentinel dropped, real ones counted
    assert _support_count("no match found") == 0
    assert _support_count(None) == 0


def test_ungrounded_record_has_an_all_zero_support_signature():
    # Nothing in the 0.6 record is real support — every dimension must read 0, so ANY grounding
    # the next record adds registers as influx.
    assert _evidence_signature(UNGROUNDED) == (0, 0, 0, 0, 0, 0, 0, 0)


def test_genuine_free_confidence_still_flagged_when_evidence_is_unchanged():
    # The guard must not over-correct: identical support on both sides is NOT influx, so a
    # confidence rise there is still a real M1 violation and must remain detectable.
    prev = {"claim": "x", "confidence": 0.5, "sources": ["a.py"], "source": "grep"}
    nxt = {"claim": "x", "confidence": 0.9, "sources": ["a.py"], "source": "grep"}
    assert _evidence_added(prev, nxt) is False


def test_swapping_evidence_content_without_adding_is_not_influx():
    # Same count, different content (one source replaced by another) is not MORE evidence.
    prev = {"sources": ["a.py"], "source": "grep"}
    nxt = {"sources": ["b.py"], "source": "grep"}
    assert _evidence_added(prev, nxt) is False
