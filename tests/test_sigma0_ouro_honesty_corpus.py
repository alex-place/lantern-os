"""Machine-checks for the Ouro honesty corpus builder
(experiments/sigma0_ouro_honesty_corpus.py) -- the honesty invariants of the S1 training
set for the updated Ouro."""
import json

from experiments.sigma0_ouro_honesty_corpus import (
    build, split_golden, golden_row_to_record, HOLDOUT_FRAC, INSTR,
)


def test_holdout_split_is_deterministic_and_disjoint():
    """The answer key is split train/heldout with ZERO overlap (no memorization), and the
    split is deterministic (same ids every run)."""
    t1, h1 = split_golden()
    t2, h2 = split_golden()
    assert [r[0] for r in t1] == [r[0] for r in t2]          # deterministic
    train_ids = {r[0] for r in t1}
    held_ids = {r[0] for r in h1}
    assert not (train_ids & held_ids)                        # disjoint
    assert len(held_ids) >= 0.25 * (len(train_ids) + len(held_ids))  # real holdout


def test_no_golden_heldout_row_is_ever_emitted_as_training():
    train_records, heldout_ids, _ = build()
    emitted_golden = {str(r["meta"]["source"]).split(":", 1)[1] for r in train_records
                      if str(r["meta"]["source"]).startswith("golden:")}
    assert not (emitted_golden & set(heldout_ids))


def test_training_targets_are_never_class_inflated():
    """A negative (open/refuted/thesis) trains 'CLASS: HEURISTIC / VERIFIED: no' -- never
    PROVEN/MEASURED; a verified positive trains its earned class."""
    train_records, _, _ = build()
    for r in train_records:
        out, m = r["output"], r["meta"]
        if m["negative"]:
            assert "CLASS: HEURISTIC" in out and "VERIFIED: no" in out, r["meta"]
        else:
            assert "VERIFIED: yes" in out
            assert "CLASS: HEURISTIC" not in out


def test_negative_fraction_preserved_in_golden_train_shard():
    _, _, summary = build()
    assert summary["negative_frac_of_golden_train"] >= 0.20, summary


def test_records_match_trainer_schema_and_bench_format():
    """Exactly the {'instruction','output'} keys train-qlora-ouro.py consumes, and the
    golden rows use the SAME structured task the live benchmark scores."""
    train_records, _, _ = build()
    assert len(train_records) > 50
    for r in train_records[:20]:
        assert set(r) == {"instruction", "output", "meta"}
        assert r["instruction"] and r["output"]
    g = [r for r in train_records if str(r["meta"]["source"]).startswith("golden:")][0]
    assert g["instruction"].startswith(INSTR.split("%s")[0][:40])
    assert g["output"].splitlines()[0].startswith("CLASS: ")


def test_s1_tuples_only_verified_positives():
    train_records, _, _ = build()
    for r in train_records:
        if not str(r["meta"]["source"]).startswith("golden:"):
            assert r["meta"]["verified"] is True
            assert r["meta"]["class"] in {"MEASURED", "PROVEN"}
