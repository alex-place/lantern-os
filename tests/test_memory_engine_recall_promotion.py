"""Recall-triggered tier promotion for MemoryEngine (#2086).

The promote()/_next_cube() machinery existed but nothing ever CALLED it on a recall — a
frequently-retrieved TRACE stayed a TRACE in the RAW cube forever. #2086 wires a flag-gated
`recall_with_promotion()`: on recall, raw-tier hits graduate toward an anchor tier (advancing
RAW→REFINED), which is what #1685 measured as a +22pp@5 recall lift. These tests pin the two
contracts that matter: flag OFF is a pure no-op (query() semantics preserved), flag ON promotes
+ persists + counts exactly the raw-tier hits.
"""
import tempfile

from csf.memory_engine import (
    MemoryEngine,
    Tier,
    CubePartition,
    RECALL_PROMOTABLE,
    create_trace,
)


def _engine(tmp, **kw):
    return MemoryEngine(base_path=tmp, **kw)


def test_flag_off_is_a_pure_noop():
    """Default (flag off) recall_with_promotion == query(): same hits, no promotions written."""
    with tempfile.TemporaryDirectory() as tmp:
        eng = _engine(tmp)
        eng.write(create_trace("the lantern remembers the well", "s1", keywords=["lantern", "well"]))
        before = len(eng.query(keywords=["lantern"], use_multi_signal=True, match_any=True))

        hits = eng.recall_with_promotion(keywords=["lantern"], use_multi_signal=True, match_any=True)

        assert len(hits) == before == 1
        assert eng.recall_promotion_count() == 0
        # no promoted copy was written — the recall added nothing to the store
        assert len(eng.query(keywords=["lantern"], use_multi_signal=True, match_any=True)) == before


def test_flag_on_promotes_persists_and_counts_raw_tier_hit():
    """Flag on: a recalled TRACE is promoted to the anchor tier, the promoted copy is written
    (so it is retrievable next time), and the promotion counter increments once."""
    with tempfile.TemporaryDirectory() as tmp:
        eng = _engine(tmp)
        rec = create_trace("the codeword is zephyrine", "s1", keywords=["zephyrine"])
        eng.write(rec)

        hits = eng.recall_with_promotion(
            enabled=True, keywords=["zephyrine"], use_multi_signal=True, match_any=True)

        assert len(hits) == 1 and hits[0].tier == Tier.TRACE   # returns the ORIGINAL recalled record
        assert eng.recall_promotion_count() == 1

        # a promoted ANCHOR copy now exists in the store, in a more-canonical cube partition
        anchors = eng.query(tier=Tier.ANCHOR, keywords=["zephyrine"], use_multi_signal=True, match_any=True)
        assert len(anchors) == 1
        promoted = anchors[0]
        assert promoted.tier == Tier.ANCHOR
        assert promoted.cube_partition == CubePartition.REFINED   # _next_cube: ANCHOR ⇒ REFINED
        assert promoted.promoted_from == rec.memory_id           # lineage points back to the trace


def test_already_anchor_tier_is_not_repromoted():
    """A hit already at/above the promote target isn't in RECALL_PROMOTABLE ⇒ left untouched."""
    with tempfile.TemporaryDirectory() as tmp:
        eng = _engine(tmp)
        rec = create_trace("stable fact", "s1", keywords=["stable"])
        eng.write(rec.promote(to_tier=Tier.ANCHOR, agent="seed"))   # seed an ANCHOR directly

        eng.recall_with_promotion(
            enabled=True, keywords=["stable"], use_multi_signal=True, match_any=True)

        assert eng.recall_promotion_count() == 0
        assert Tier.ANCHOR not in RECALL_PROMOTABLE   # guards the contract this test relies on


def test_recall_promotable_is_the_raw_tiers():
    assert RECALL_PROMOTABLE == frozenset({Tier.TRACE, Tier.CORRECTION})


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"  ok  - {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL- {fn.__name__}\n       {e}")
    print(f"\n{'all passed' if not failed else str(failed) + ' FAILED'} ({len(fns)} tests)")
    import sys
    sys.exit(1 if failed else 0)
