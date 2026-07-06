"""Machine-checks for the S1 honesty-dataset builder (experiments/sigma0_s1_data_builder.py).

The invariants that make S1 "honesty in the data": the class is derived from actual
verification (never inflated), unverified rows are capped and never promoted, and every
emitted record is schema-valid. Runs on the real repo corpus.
"""
from experiments.sigma0_honest_objective import validate_claim
from experiments.sigma0_s1_data_builder import derive_class, record_to_tuple, build


def test_class_is_derived_from_verification_not_asserted():
    assert derive_class(verified=True, has_evidence=True, has_machine_check=True, has_result=True) == "PROVEN"
    assert derive_class(verified=True, has_evidence=True, has_machine_check=False, has_result=True) == "MEASURED"
    assert derive_class(verified=True, has_evidence=False, has_machine_check=False, has_result=True) == "MEASURED"
    assert derive_class(verified=False, has_evidence=True, has_machine_check=True, has_result=True) == "HEURISTIC"
    assert derive_class(verified=False, has_evidence=False, has_machine_check=False, has_result=True) == "HEURISTIC"
    assert derive_class(verified=True, has_evidence=True, has_machine_check=True, has_result=False) == "ABSTAIN"


def test_unverified_record_becomes_heuristic_not_positive():
    rec = {"id": "x1", "hypothesis": "maybe X causes Y", "result": "X probably causes Y",
           "evidence": [], "confidence": 0.9, "verified": False}
    t = record_to_tuple(rec)
    assert t is not None
    assert t["claims"][0]["class"] == "HEURISTIC"          # not MEASURED
    assert t["claims"][0]["confidence"] <= 0.5             # no-info prior cap
    assert t["label"]["positive"] is False                 # excluded from positive targets
    assert t["provenance"]["independent"] is False


def test_verified_record_with_evidence_is_measured_positive():
    rec = {"id": "x2", "hypothesis": "fix off-by-one", "result": "fixed; test passes",
           "evidence": ["tests/test_foo.py::test_bar"], "confidence": 0.95, "verified": True}
    t = record_to_tuple(rec)
    assert t["claims"][0]["class"] in {"MEASURED", "PROVEN"}
    assert t["label"]["positive"] is True
    assert t["provenance"]["independent"] is True


def test_dict_typed_result_survives_schema_drift():
    """Newer writers (three-doors scene records) emit 'result' as a structured dict --
    the builder must flatten it deterministically instead of crashing (#2054-era drift)."""
    rec = {"id": "cr-drift", "hypothesis": "Scene image depicts the canon.",
           "result": {"kind": "three-doors-scene-image", "scene": "ancient-doors",
                      "beat": "a spell opens the door", "image": "D:/tmp/scene.png"},
           "evidence_ids": ["three-doors:cast-canon"], "confidence": 0.88,
           "verified": True, "grounding_signals": []}
    t = record_to_tuple(rec)
    assert t is not None
    assert "scene: ancient-doors" in t["response"]
    assert t["claims"][0]["class"] in {"MEASURED", "PROVEN"}
    # flatten is deterministic: same dict, same text
    assert record_to_tuple(rec)["response"] == t["response"]


def test_none_and_list_results_survive_schema_drift():
    assert record_to_tuple({"id": "n3", "hypothesis": "x", "result": None,
                            "evidence": [], "verified": False}) is None
    t = record_to_tuple({"id": "l1", "hypothesis": "check outputs",
                         "result": ["step one done", {"detail": "test passed"}],
                         "evidence": ["run-log"], "verified": True})
    assert t is not None
    assert "step one done" in t["response"] and "detail: test passed" in t["response"]


def test_noise_rows_are_dropped():
    assert record_to_tuple({"id": "n", "hypothesis": "chat", "result": "I am still here.",
                            "evidence": [], "verified": False}) is None
    assert record_to_tuple({"id": "n2", "hypothesis": "", "result": "",
                            "evidence": [], "verified": False}) is None


def test_built_dataset_is_schema_valid_and_uninflated():
    """The whole real corpus: every claim schema-valid; ZERO class inflation."""
    rows, summary = build()
    assert summary["total"] > 0
    inflated = 0
    for r in rows:
        claim = r["claims"][0]
        ok, msg = validate_claim(claim)
        assert ok, f"schema: {msg} :: {claim}"
        if not claim["verified"] and claim["class"] in {"MEASURED", "PROVEN"}:
            inflated += 1
    assert inflated == 0, f"{inflated} unverified rows inflated to MEASURED/PROVEN"


def test_unverified_rows_are_never_a_positive_class():
    """The load-bearing honesty invariant: every unverified row is HEURISTIC/ABSTAIN and
    NOT a positive target -- never MEASURED/PROVEN. (This corpus happens to be verification-
    skewed to all-positive; the builder reports that in summary['note'] rather than hiding
    it -- honest negatives are mined from reverted PRs as an S1 follow-up.)"""
    rows, summary = build()
    assert summary["positives"] > 0
    assert "honest_negatives" in summary and "note" in summary
    for r in rows:
        c = r["claims"][0]
        if not c["verified"]:
            assert c["class"] in {"HEURISTIC", "ABSTAIN"}
            assert r["label"]["positive"] is False
