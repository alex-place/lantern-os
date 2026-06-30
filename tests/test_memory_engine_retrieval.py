"""Retrieval-quality tests for MemoryEngine: IDF ranking, keyword breadth,
and durable, throttled index persistence (issues #1689 / #1728)."""
import tempfile
from unittest import mock

from csf.memory_engine import (
    MemoryEngine,
    create_trace,
    _derive_keywords,
    _DERIVE_KEYWORD_CAP,
    _INDEX_SAVE_EVERY,
)


def _engine(tmp, **kw):
    return MemoryEngine(base_path=tmp, **kw)


# ── IDF ranking (#1689) ──────────────────────────────────────────────────────
def test_idf_is_higher_for_rarer_terms():
    with tempfile.TemporaryDirectory() as tmp:
        eng = _engine(tmp)
        for i in range(20):
            eng.write(create_trace(f"standup {i}", f"s{i}", keywords=["meeting", "standup"]))
        eng.write(create_trace("odd one out", "rare", keywords=["meeting", "pomegranate"]))
        # "pomegranate" appears in 1 doc, "meeting" in 21 -> rarer term scores higher
        assert eng._idf("pomegranate") > eng._idf("meeting")
        assert eng._idf("meeting") > 0  # smoothed IDF is always positive


def test_rare_match_outranks_common_match():
    with tempfile.TemporaryDirectory() as tmp:
        eng = _engine(tmp)
        for i in range(15):
            eng.write(create_trace(f"standup {i}", f"f{i}", keywords=["meeting", "standup"]))
        gold = create_trace("harvest report", "gold", keywords=["meeting", "pomegranate"])
        eng.write(gold)
        eng.write(create_trace("another meeting", "d", keywords=["meeting", "calendar"]))
        results = eng.query(keywords=["meeting", "pomegranate"], use_multi_signal=True,
                            match_any=True, limit=20)
        # The record matching the rare distinctive term ranks first.
        assert results[0].memory_id == gold.memory_id


# ── Keyword breadth / auto-derive (#1689 follow-up) ──────────────────────────
def test_create_trace_auto_derives_keywords_when_omitted():
    rec = create_trace("The lighthouse keeper logged a peculiar aurora over the bay", "s1")
    assert "lighthouse" in rec.keywords and "aurora" in rec.keywords
    assert "the" not in rec.keywords          # stopword dropped
    assert len(rec.keywords) <= _DERIVE_KEYWORD_CAP


def test_explicit_keywords_override_derivation():
    rec = create_trace("some long content here about many things", "s1", keywords=["pinned"])
    assert rec.keywords == ["pinned"]


def test_auto_derived_trace_is_retrievable_by_deep_token():
    # A word late in the text (beyond the first dozen tokens) must still be indexed.
    with tempfile.TemporaryDirectory() as tmp:
        eng = _engine(tmp)
        filler = " ".join(f"word{i}" for i in range(20))
        eng.write(create_trace(f"{filler} the secret codeword is zephyrine", "s1"))
        hits = eng.query(keywords=["zephyrine"], use_multi_signal=True, match_any=True)
        assert len(hits) == 1


def test_derive_keywords_caps_breadth():
    text = " ".join(f"token{i}" for i in range(200))
    assert len(_derive_keywords(text)) == _DERIVE_KEYWORD_CAP


# ── persist_index escape hatch (#1728) ───────────────────────────────────────
def test_persist_index_false_skips_disk_but_query_works():
    with tempfile.TemporaryDirectory() as tmp:
        eng = _engine(tmp, persist_index=False)
        eng.write(create_trace("ephemeral lantern note", "s1"))
        # In-memory index is current -> query still works...
        assert len(eng.query(keywords=["lantern"], use_multi_signal=True, match_any=True)) == 1
        # ...but no _index.json was persisted.
        assert not (eng.base / "_index.json").exists()


def test_persist_index_true_writes_index_file():
    with tempfile.TemporaryDirectory() as tmp:
        eng = _engine(tmp, persist_index=True)
        for i in range(_INDEX_SAVE_EVERY):  # reach the throttle threshold -> auto-flush
            eng.write(create_trace(f"persisted note {i}", f"s{i}"))
        assert (eng.base / "_index.json").exists()


# ── Throttled, durable index persistence (#1728) ─────────────────────────────
def _spy_rebuild():
    """Return (spy_fn, counter) to count _rebuild_index calls under mock.patch."""
    calls = {"n": 0}
    orig = MemoryEngine._rebuild_index

    def spy(self):
        calls["n"] += 1
        return orig(self)

    return spy, calls


def test_unflushed_writes_are_recovered_by_rebuild_on_cold_start():
    # Fewer than the throttle threshold -> index never auto-saved. A fresh engine
    # must still surface the records (rebuild-on-stale), never lose them.
    with tempfile.TemporaryDirectory() as tmp:
        e1 = _engine(tmp)
        for i in range(10):
            e1.write(create_trace(f"note {i} zephyrine{i}", f"s{i}"))
        # deliberately no flush() — simulate an ungraceful exit
        e2 = _engine(tmp)
        hits = e2.query(keywords=["zephyrine7"], use_multi_signal=True, match_any=True)
        assert len(hits) == 1


def test_stale_index_is_detected_and_rebuilt():
    with tempfile.TemporaryDirectory() as tmp:
        e1 = _engine(tmp)
        for i in range(5):
            e1.write(create_trace(f"note {i} alpha{i}", f"s{i}"))
        spy, calls = _spy_rebuild()
        with mock.patch.object(MemoryEngine, "_rebuild_index", spy):
            e2 = _engine(tmp)  # stale cache (no flush) -> must rebuild
        assert calls["n"] == 1
        assert len(e2.query(keywords=["alpha3"], use_multi_signal=True, match_any=True)) == 1


def test_flush_lets_cold_start_trust_cache_without_rebuild():
    with tempfile.TemporaryDirectory() as tmp:
        e1 = _engine(tmp)
        for i in range(5):
            e1.write(create_trace(f"note {i} bravo{i}", f"s{i}"))
        e1.flush()  # graceful: persist current index
        spy, calls = _spy_rebuild()
        with mock.patch.object(MemoryEngine, "_rebuild_index", spy):
            e2 = _engine(tmp)
        assert calls["n"] == 0  # registry sizes match -> trusted, no rebuild
        assert len(e2.query(keywords=["bravo2"], use_multi_signal=True, match_any=True)) == 1


def test_auto_flush_at_threshold_persists_current_cache():
    with tempfile.TemporaryDirectory() as tmp:
        e1 = _engine(tmp)
        for i in range(_INDEX_SAVE_EVERY):  # last write triggers an auto-flush
            e1.write(create_trace(f"note {i} charlie{i}", f"s{i}"))
        spy, calls = _spy_rebuild()
        with mock.patch.object(MemoryEngine, "_rebuild_index", spy):
            e2 = _engine(tmp)
        assert calls["n"] == 0  # threshold flush left a current cache
        assert len(e2.query(keywords=["charlie100"], use_multi_signal=True, match_any=True)) == 1
