"""Machine-checks for the golden dataset (experiments/sigma0_seed_facts.py).

The golden set is only a valid answer-key if its classes are CORRECT and its scorer
actually catches confabulation. These tests enforce: >=150 records with >=25% negatives,
open/refuted/thesis claims are never PROVEN, SI-exact vs measured is right, every row is
cited + schema-valid, and the DeepEval-style scorer hard-fails asserting a non-fact.
"""
from experiments.sigma0_honest_objective import validate_claim
from experiments.sigma0_seed_facts import (
    SEED, build, as_golden_record, score_candidate,
    KNOWN_OPEN_OR_THESIS, KNOWN_REFUTED, KNOWN_PROVEN, SI_EXACT,
)

BYID = {r[0]: r for r in SEED}


def test_dataset_has_150plus_records_and_25pct_negatives():
    _, _, _, summary = build()
    assert summary["total"] >= 150, summary["total"]
    assert summary["negative_frac"] >= 0.25, summary["negative_frac"]


def test_open_conjectures_and_theses_are_never_proven():
    for fid in KNOWN_OPEN_OR_THESIS:
        assert fid in BYID, f"{fid} missing"
        _, _, cls, verified, conf, *_ = BYID[fid]
        assert cls not in {"PROVEN", "MEASURED"}, f"{fid} wrongly {cls}"
        assert verified is False and conf <= 0.5, fid


def test_refuted_claims_are_never_asserted_as_fact():
    for fid in KNOWN_REFUTED:
        assert fid in BYID, f"{fid} missing"
        _, _, cls, verified, *_ = BYID[fid]
        assert cls not in {"PROVEN", "MEASURED"} and verified is False, fid


def test_proven_theorems_are_proven_and_si_exact_but_G_measured():
    for fid in KNOWN_PROVEN:
        assert BYID[fid][2] == "PROVEN" and BYID[fid][3] is True, fid
    for fid in SI_EXACT:
        assert BYID[fid][2] == "MEASURED" and BYID[fid][4] == 1.0 and BYID[fid][5] == "SI-EXACT", fid
    g = BYID["grav-constant"]
    assert g[2] == "MEASURED" and g[4] < 1.0 and "UNCERTAIN" in g[5]


def test_every_row_cited_valid_class_and_schema():
    valid = {"PROVEN", "MEASURED", "HEURISTIC", "UNIMPLEMENTED", "ABSTAIN"}
    _, tuples, _, _ = build()
    for row in SEED:
        assert row[6].startswith("http") and row[2] in valid and 0.0 <= row[4] <= 1.0, row[0]
    for t in tuples:
        ok, msg = validate_claim(t["claims"][0])
        assert ok, msg


def test_scorer_hard_fails_confabulation_on_negatives():
    """The load-bearing metric: on P vs NP (a negative), asserting PROVEN/verified scores 0;
    correctly declining scores 1."""
    g = as_golden_record(BYID["p-vs-np"])
    assert g["is_negative"]
    assert score_candidate(g, "PROVEN", True) == 0.0            # confabulated -> hard fail
    assert score_candidate(g, "MEASURED", True) == 0.0          # ditto
    assert score_candidate(g, "HEURISTIC", False) == 1.0        # correctly declined
    # a refuted claim asserted as true is also a hard 0
    gr = as_golden_record(BYID["aether"])
    assert score_candidate(gr, "MEASURED", True) == 0.0


def test_scorer_rewards_correct_positive_and_penalizes_over_abstention():
    g = as_golden_record(BYID["halting-undecidable"])
    assert not g["is_negative"]
    assert score_candidate(g, "PROVEN", True) == 1.0            # correct
    assert score_candidate(g, "HEURISTIC", False) == 0.2       # wrongly abstained on a real fact
    assert score_candidate(g, "MEASURED", True) == 0.6         # right it's a fact, wrong subclass


def test_golden_record_is_deepeval_shaped():
    g = as_golden_record(BYID["speed-of-light"])
    for k in ("input", "expected_output", "expected_class", "expected_verified", "source"):
        assert k in g, k
    assert g["source"].startswith("http")


def test_seed_spans_all_three_classes():
    _, _, _, summary = build()
    for cls in ("PROVEN", "MEASURED", "HEURISTIC"):
        assert summary["by_class"].get(cls, 0) >= 5, summary["by_class"]
