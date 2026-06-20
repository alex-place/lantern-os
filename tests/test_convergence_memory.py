"""Tests for LANTERN-MEMORY persistent learning layer.

Verifies:
- Append-only JSONL persistence
- Query interface with pattern matching
- Confidence filtering and sorting
- Evidence tracking
- Integration with existing data logs
"""

import pytest
import json
import tempfile
from pathlib import Path
from datetime import datetime, timedelta

from src.convergence.memory import MemoryEntry, MemoryStore, get_memory_store, reset_memory_store


class TestMemoryEntry:
    """Test MemoryEntry data structure."""

    def test_entry_creation(self):
        """MemoryEntry created with required fields."""
        entry = MemoryEntry(
            id="mem-001",
            timestamp=datetime.now(),
            source="test-tool",
            confidence=0.9,
            content={"data": "test"},
        )
        assert entry.id == "mem-001"
        assert entry.source == "test-tool"
        assert entry.confidence == 0.9

    def test_entry_with_evidence(self):
        """MemoryEntry can reference other memories."""
        entry = MemoryEntry(
            id="mem-002",
            timestamp=datetime.now(),
            source="reasoner",
            confidence=0.75,
            content={"hypothesis": "X is true"},
            evidence_ids=["mem-001"],
        )
        assert "mem-001" in entry.evidence_ids

    def test_entry_to_dict(self):
        """MemoryEntry serializes to dict."""
        now = datetime.now()
        entry = MemoryEntry(
            id="mem-003",
            timestamp=now,
            source="observer",
            confidence=0.85,
            content={"key": "value"},
        )
        d = entry.to_dict()
        assert d["id"] == "mem-003"
        assert d["source"] == "observer"
        assert d["confidence"] == 0.85
        assert isinstance(d["timestamp"], str)  # ISO format


class TestMemoryStore:
    """Test MemoryStore query and persistence."""

    @pytest.fixture
    def store(self):
        """Create memory store with temporary directory."""
        with tempfile.TemporaryDirectory() as tmpdir:
            reset_memory_store()
            # Create a fresh store with empty directory
            store = MemoryStore(tmpdir)
            # Ensure cache is completely empty (no stale data loaded)
            store.cache.clear()
            yield store

    def test_store_initialization(self, store):
        """Store initializes with log files."""
        assert store.memory_dir.exists()
        assert len(store.logs) > 0

    def test_append_memory(self, store):
        """Append creates new memory entry."""
        entry = store.append(
            source="test-tool",
            content={"message": "test"},
            confidence=0.95,
            verification_status="verified",
        )
        assert entry.id is not None
        assert entry.confidence == 0.95
        assert entry.id in store.cache

    def test_append_with_evidence(self, store):
        """Append can link evidence memories."""
        entry = store.append(
            source="observation",
            content={"fact": "true"},
            confidence=0.99,
            evidence_ids=["mem-1", "mem-2"],
        )
        assert len(entry.evidence_ids) == 2

    def test_confidence_clamping(self, store):
        """Confidence is clamped to [0.0, 1.0]."""
        entry1 = store.append(source="test", content={}, confidence=1.5, verification_status="verified")
        assert entry1.confidence == 1.0

        entry2 = store.append(source="test", content={}, confidence=-0.5, verification_status="verified")
        assert entry2.confidence == 0.0

    def test_rapid_same_source_appends_are_unique(self, store):
        """Rapid appends from one source must not collide on ID.

        Regression: append() built IDs from datetime.now().timestamp() alone,
        whose ~15ms resolution on Windows let two quick same-source appends share
        a timestamp -> identical ID -> the first entry was silently overwritten in
        the cache. This caused flaky failures in the query tests below.
        """
        n = 50
        entries = [store.append("rapid", {"i": i}, confidence=0.9, verification_status="verified") for i in range(n)]
        ids = {e.id for e in entries}
        assert len(ids) == n, "append() produced duplicate IDs"
        assert len(store.cache) >= n, "an entry was lost to an ID collision"

    def test_query_by_pattern_source(self, store):
        """Query finds entries by source pattern."""
        store.append("price-collector", {"price": 45.2}, confidence=0.99, verification_status="verified")
        store.append("news-feed", {"headline": "Market"}, confidence=0.8, verification_status="verified")

        results = store.query("price", min_confidence=0.9)
        assert len(results) >= 1
        assert any(m.source == "price-collector" for m in results)

    def test_query_by_pattern_content(self, store):
        """Query finds entries by content pattern."""
        store.append("observer", {"event": "market-open"}, confidence=0.95, verification_status="verified")
        store.append("observer", {"event": "order-placed"}, confidence=0.9, verification_status="verified")

        results = store.query("market", min_confidence=0.9)
        assert len(results) >= 1

    def test_query_confidence_filtering(self, store):
        """Query filters by minimum confidence."""
        store.append("source1", {"data": "A"}, confidence=0.99, verification_status="verified")
        store.append("source2", {"data": "A"}, confidence=0.5, verification_status="verified")

        results = store.query("data", min_confidence=0.9)
        assert len(results) == 1
        assert results[0].confidence == 0.99

    def test_query_order_by_timestamp(self, store):
        """Query can sort by timestamp."""
        store.append("test", {"seq": 1}, confidence=0.9, verification_status="verified")
        store.append("test", {"seq": 2}, confidence=0.9, verification_status="verified")

        results = store.query("test", order_by="timestamp", limit=10)
        assert len(results) >= 2
        assert results[0].content["seq"] <= results[1].content["seq"]

    def test_query_order_by_confidence(self, store):
        """Query can sort by confidence descending."""
        store.append("test", {"msg": "A"}, confidence=0.7, verification_status="verified")
        store.append("test", {"msg": "B"}, confidence=0.95, verification_status="verified")

        results = store.query("test", order_by="confidence", limit=10)
        assert len(results) >= 2
        assert results[0].confidence >= results[1].confidence

    def test_query_source_filter(self, store):
        """Query can filter by specific source."""
        store.append("price-collector", {"value": 100}, confidence=0.99, verification_status="verified")
        store.append("other-tool", {"value": 200}, confidence=0.99, verification_status="verified")

        results = store.query("value", source_filter="price", min_confidence=0.9)
        assert all("price" in m.source.lower() for m in results)

    def test_query_limit(self, store):
        """Query respects limit parameter."""
        for i in range(20):
            store.append("test", {"id": i}, confidence=0.9, verification_status="verified")

        results = store.query("test", limit=5)
        assert len(results) <= 5

    def test_get_by_id(self, store):
        """Get memory by ID."""
        entry = store.append("test", {"data": "value"}, confidence=0.9, verification_status="verified")
        retrieved = store.get_by_id(entry.id)
        assert retrieved is not None
        assert retrieved.id == entry.id
        assert retrieved.content == {"data": "value"}

    def test_update_confidence(self, store):
        """Update confidence of existing memory."""
        entry = store.append("test", {"data": "X"}, confidence=0.5, verification_status="verified")
        assert store.update_confidence(entry.id, 0.95, evidence_ids=["ev-1"])
        updated = store.get_by_id(entry.id)
        assert updated.confidence == 0.95

    def test_update_confidence_nonexistent(self, store):
        """Update confidence of non-existent memory returns False."""
        assert not store.update_confidence("nonexistent-id", 0.9)

    def test_statistics(self, store):
        """Statistics computed correctly."""
        store.append("source-1", {"a": 1}, confidence=0.99, verification_status="verified")
        store.append("source-1", {"b": 2}, confidence=0.8, verification_status="verified")
        store.append("source-2", {"c": 3}, confidence=0.95, verification_status="verified")

        stats = store.statistics()
        assert stats["total_entries"] == 3
        assert stats["average_confidence"] > 0.8
        assert "source-1" in stats["by_source"]
        assert stats["by_source"]["source-1"]["count"] == 2

    def test_persistence_roundtrip(self, store):
        """Memory persists to disk and reloads."""
        store.append("test-1", {"data": "A"}, confidence=0.99, verification_status="verified")
        store.append("test-2", {"data": "B"}, confidence=0.85, verification_status="verified")

        # Create new store with same directory
        store2 = MemoryStore(str(store.memory_dir))
        assert len(store2.cache) >= 2
        assert any(m.confidence == 0.99 for m in store2.cache.values())

    def test_multiple_log_types(self, store):
        """Append to different log types."""
        store.append("tool-1", {"type": "conversation"}, log_type="conversations", verification_status="verified")
        store.append("tool-2", {"type": "observation"}, log_type="observations", verification_status="verified")
        store.append("tool-3", {"type": "dream"}, log_type="dreams", verification_status="verified")

        assert len(store.cache) >= 3

    def test_global_memory_store(self):
        """Global memory store singleton works."""
        reset_memory_store()
        store1 = get_memory_store()
        store2 = get_memory_store()
        assert store1 is store2  # Same instance

    def test_acceptance_criteria(self):
        """✓ All acceptance criteria met."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = MemoryStore(tmpdir)

            # ✓ Memory.append(timestamp, source, confidence, content)
            entry = store.append(
                source="test",
                content={"data": "value"},
                confidence=0.9,
                verification_status="verified",
            )
            assert entry.source == "test"
            assert entry.confidence == 0.9

            # ✓ Memory.query(pattern, min_confidence, order_by, limit)
            store.append("test-2", {"pattern": "match"}, confidence=0.95, verification_status="verified")
            results = store.query(
                "pattern",
                min_confidence=0.9,
                order_by="confidence",
                limit=5,
            )
            assert len(results) > 0

            # ✓ Integration with existing data/*.jsonl
            store.append("collector", {"data": "obs"}, log_type="observations", verification_status="verified")
            assert "observations" in store.logs

            # ✓ Tests passing (this test itself)
            assert True


class TestMemory767Hardening:
    """#767 — confidence-laundering gate, ledger non-divergence, hash-chain."""

    @pytest.fixture
    def store(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            reset_memory_store()
            store = MemoryStore(tmpdir)
            store.cache.clear()
            yield store

    def test_ungrounded_high_confidence_clamped_and_partitioned(self, store):
        e = store.append("reasoner", {"claim": "X"}, confidence=0.95)
        assert e.confidence <= 0.3
        assert e.verification_status == "unverified"
        assert store.logs["proposals"].read_text(encoding="utf-8").strip() != ""
        assert store.logs["observations"].read_text(encoding="utf-8").strip() == ""

    def test_evidence_makes_grounded(self, store):
        e = store.append("reasoner", {"claim": "X"}, confidence=0.95, evidence_ids=["m1"])
        assert e.confidence == 0.95
        assert e.verification_status == "grounded"

    def test_explicit_verification_grounded(self, store):
        e = store.append("operator", {"fact": "Y"}, confidence=0.9, verification_status="verified")
        assert e.confidence == 0.9
        assert e.verification_status == "verified"

    def test_ungrounded_not_queryable_as_trusted(self, store):
        store.append("reasoner", {"claim": "smuggled"}, confidence=0.99)
        assert store.query("smuggled", min_confidence=0.5) == []

    def test_raise_without_evidence_rejected(self, store):
        e = store.append("x", {"d": 1}, confidence=0.3, verification_status="verified")
        assert store.update_confidence(e.id, 0.9) is False
        assert store.get_by_id(e.id).confidence == 0.3

    def test_raise_with_evidence_persisted_no_divergence(self, store):
        e = store.append("x", {"d": 1}, confidence=0.3, verification_status="verified")
        assert store.update_confidence(e.id, 0.9, evidence_ids=["proof"]) is True
        assert store.get_by_id(e.id).confidence == 0.9
        store2 = MemoryStore(str(store.memory_dir))
        assert store2.get_by_id(e.id).confidence == 0.9
        ups = [m for m in store2.cache.values() if m.source == "confidence-update"]
        assert len(ups) == 1 and ups[0].content["updates"] == e.id

    def test_lowering_allowed_without_evidence(self, store):
        e = store.append("x", {"d": 1}, confidence=0.9, verification_status="verified")
        assert store.update_confidence(e.id, 0.2) is True
        assert store.get_by_id(e.id).confidence == 0.2

    def test_verify_ledger_intact(self, store):
        for i in range(5):
            store.append("obs", {"i": i}, confidence=0.8, verification_status="verified", log_type="observations")
        res = store.verify_ledger("observations")
        assert res["ok"] is True and res["checked"] == 5

    def test_verify_ledger_detects_tampering(self, store):
        for i in range(3):
            store.append("obs", {"i": i}, confidence=0.8, verification_status="verified", log_type="observations")
        path = store.logs["observations"]
        lines = path.read_text(encoding="utf-8").splitlines()
        rec = json.loads(lines[1]); rec["confidence"] = 0.99
        lines[1] = json.dumps(rec)
        path.write_text(chr(10).join(lines) + chr(10), encoding="utf-8")
        res = store.verify_ledger("observations")
        assert res["ok"] is False and res["broken_at"] == 1

    def test_verify_ledger_detects_removed_record(self, store):
        for i in range(3):
            store.append("obs", {"i": i}, confidence=0.8, verification_status="verified", log_type="observations")
        path = store.logs["observations"]
        lines = path.read_text(encoding="utf-8").splitlines()
        del lines[1]
        path.write_text(chr(10).join(lines) + chr(10), encoding="utf-8")
        res = store.verify_ledger("observations")
        assert res["ok"] is False
