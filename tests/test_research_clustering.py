"""Regression for grounder over-rejection (#908).

The grounder returned 0/N supported claims because verbatim per-source snippets
rarely share >45% of their content tokens, so nothing clustered and every claim came
back single-source. The fix lowers the clustering threshold (0.45 → 0.30) and extracts
the merge logic into a pure `_cluster_claims` so cross-source corroboration actually
merges.
"""
import inspect

from convergence.research import _cluster_claims, ResearchLoop


def _claim(text, mid):
    return {"text": text, "memory_id": mid}


def test_cross_source_paraphrases_merge_at_030():
    # Two sources stating the same fact in different words, sharing several content
    # tokens (python/programming/language) — overlap is in the 0.30–0.45 band that the
    # old threshold wrongly rejected.
    claims = [
        _claim("Python is a popular programming language used for data science", "m1"),
        _claim("The Python programming language is widely used across software projects", "m2"),
    ]
    clusters = _cluster_claims(claims, 0.30)
    assert len(clusters) == 1, f"expected 1 merged cluster, got {len(clusters)}"
    assert clusters[0]["memory_ids"] == {"m1", "m2"}


def test_threshold_governs_merging():
    # A pair sharing exactly one content token of a 4-token smaller set: overlap 0.25.
    # Merges at 0.20 (too-lax), stays separate at the 0.30 default — locking that the
    # threshold is the lever and 0.30 doesn't over-merge weakly-related claims.
    claims = [
        _claim("quantum entanglement links distant particles", "m1"),       # {quantum, entanglement, links, distant, particles}
        _claim("classical particles obey deterministic newtonian mechanics", "m2"),  # shares: particles
    ]
    assert len(_cluster_claims(claims, 0.30)) == 2   # 0.25 overlap < 0.30 → separate
    assert len(_cluster_claims(claims, 0.20)) == 1   # < 0.20 threshold would merge


def test_unrelated_claims_stay_separate():
    claims = [
        _claim("Photosynthesis converts sunlight into chemical energy in plants", "m1"),
        _claim("The stock market closed higher on strong earnings reports", "m2"),
    ]
    clusters = _cluster_claims(claims, 0.30)
    assert len(clusters) == 2  # no false corroboration


def test_default_threshold_is_lowered():
    # Lock the new default so it can't silently revert to the over-rejecting value.
    default = inspect.signature(ResearchLoop.__init__).parameters["similarity_threshold"].default
    assert default == 0.30
