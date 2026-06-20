"""Test Memory.query() integration with reasoners.

wq-008: Verify that dream-chat, router, and kalshi-suggest can query memory.
"""

import pytest
import json
import tempfile
from pathlib import Path
from datetime import datetime

import sys
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from convergence.memory import MemoryStore


class TestMemoryQueryIntegration:
    """Test Memory.query() exposed to reasoners."""

    @pytest.fixture
    def temp_memory_dir(self):
        """Create temporary memory directory with test data."""
        with tempfile.TemporaryDirectory() as tmpdir:
            yield tmpdir

    @pytest.fixture
    def memory_store(self, temp_memory_dir):
        """Initialize MemoryStore with test data."""
        store = MemoryStore(memory_dir=temp_memory_dir)

        # Add test memories with various confidence levels
        store.append(
            source="dream-chat",
            content={"intent": "user greeting", "text": "Hello Lantern"},
            confidence=0.95,
            verification_status="verified",
            log_type="conversations",
        )

        store.append(
            source="router",
            content={"route": "convergence-dispatch", "cache_hit": True},
            confidence=0.85,
            verification_status="verified",
            log_type="convergence",
        )

        store.append(
            source="kalshi-suggest",
            content={"suggestion": "tight-band entry", "market": "btc"},
            confidence=0.75,
            verification_status="verified",
            log_type="trading",
        )

        store.append(
            source="dream-chat",
            content={"intent": "system query", "text": "What trades executed today?"},
            confidence=0.90,
            verification_status="verified",
            log_type="conversations",
        )

        return store

    def test_query_by_pattern(self, memory_store):
        """Test pattern matching across sources."""
        results = memory_store.query(pattern="tight-band")
        assert len(results) == 1
        assert results[0].source == "kalshi-suggest"
        assert "tight-band" in results[0].content["suggestion"]

    def test_query_by_source(self, memory_store):
        """Test filtering by source."""
        results = memory_store.query(
            pattern="",
            source_filter="dream-chat",
        )
        assert len(results) == 2
        assert all(r.source == "dream-chat" for r in results)

    def test_query_by_confidence_threshold(self, memory_store):
        """Test minimum confidence filtering."""
        results = memory_store.query(
            pattern="",
            min_confidence=0.9,  # Only >= 0.9
        )
        assert len(results) == 2
        assert all(r.confidence >= 0.9 for r in results)

    def test_query_sort_by_confidence(self, memory_store):
        """Test sorting by confidence (highest first)."""
        results = memory_store.query(
            pattern="",
            order_by="confidence",
            limit=10,
        )
        # Should be sorted descending by confidence
        confidences = [r.confidence for r in results]
        assert confidences == sorted(confidences, reverse=True)

    def test_query_sort_by_timestamp(self, memory_store):
        """Test sorting by timestamp."""
        results = memory_store.query(
            pattern="",
            order_by="timestamp",
            limit=10,
        )
        # Should be sorted by timestamp
        timestamps = [r.timestamp for r in results]
        assert timestamps == sorted(timestamps)

    def test_query_limit(self, memory_store):
        """Test limit parameter."""
        results = memory_store.query(
            pattern="",
            limit=2,
        )
        assert len(results) == 2

    def test_query_json_serialization(self, memory_store):
        """Test that query results are JSON-serializable."""
        results = memory_store.query(pattern="")
        # Should be able to serialize to JSON
        json_str = json.dumps([r.to_dict() for r in results])
        assert json_str is not None

        # Should be able to deserialize
        data = json.loads(json_str)
        assert len(data) == 4
        assert all("id" in d and "timestamp" in d for d in data)

    def test_query_no_results(self, memory_store):
        """Test query with no matches."""
        results = memory_store.query(pattern="nonexistent")
        assert len(results) == 0

    def test_query_combined_filters(self, memory_store):
        """Test pattern + source + confidence filters."""
        results = memory_store.query(
            pattern="dream",
            source_filter="dream-chat",
            min_confidence=0.85,
        )
        # Should match dream-chat entries with "dream" in content and confidence >= 0.85
        assert len(results) >= 1
        assert all(r.source == "dream-chat" for r in results)

    def test_memory_reasoner_access_contract(self, memory_store):
        """Contract test: dream-chat/router/kalshi-suggest can call query().

        Verifies the interface contract that all reasoners can access:
        - memory_store.query(pattern, min_confidence, order_by, limit, source_filter)
        - Results are MemoryEntry objects with .to_dict() serialization
        """
        # Dream-chat query contract
        dream_results = memory_store.query(
            pattern="greeting",
            min_confidence=0.8,
            source_filter="dream-chat",
        )
        assert all(hasattr(r, "to_dict") for r in dream_results)

        # Router query contract
        router_results = memory_store.query(
            pattern="route",
            source_filter="router",
        )
        assert all(hasattr(r, "confidence") for r in router_results)

        # Kalshi-suggest query contract
        kalshi_results = memory_store.query(
            pattern="market",
            source_filter="kalshi-suggest",
        )
        assert all(hasattr(r, "content") for r in kalshi_results)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
