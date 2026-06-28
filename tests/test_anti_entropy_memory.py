"""
Unit tests for Anti-Entropy Memory System
"""

import sys
import os
import tempfile
import pytest

# Add the apps directory to Python path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'apps'))

from superfleet_memory.anti_entropy_memory import AntiEntropyMemory
from datetime import datetime

class TestAntiEntropyMemory:
    
    @pytest.fixture
    def memory(self):
        """Create a fresh memory system for each test."""
        return AntiEntropyMemory()

    # ========== Episodic Memory Tests ==========

    def test_log_dream(self, memory):
        """Test logging a dream."""
        entry = memory.log_dream("I was flying", lucidity=0.9, tags=["flying", "sky"])
        assert entry is not None
        assert len(memory.episodic) == 1

    def test_log_event(self, memory):
        """Test logging an event."""
        entry = memory.log_event("Had a great conversation", "social", importance=0.8)
        assert entry is not None
        assert len(memory.episodic) == 1

    def test_multiple_dreams(self, memory):
        """Test logging multiple dreams."""
        memory.log_dream("Dream 1", lucidity=0.5)
        memory.log_dream("Dream 2", lucidity=0.7)
        memory.log_dream("Dream 3", lucidity=0.3)

        assert len(memory.episodic) == 3

    # ========== Semantic Memory Tests ==========

    def test_update_belief(self, memory):
        """Test updating a belief."""
        entry = memory.update_belief("world_is_good", value=0.7, confidence=0.85)
        assert "world_is_good" in memory.semantic

    def test_get_belief(self, memory):
        """Test retrieving a belief."""
        memory.update_belief("life_is_meaningful", value=0.9, confidence=0.95)
        belief = memory.get_belief("life_is_meaningful")

        assert belief is not None
        assert belief["value"] == 0.9
        assert belief["confidence"] == 0.95

    def test_get_world_model(self, memory):
        """Test getting the full world model."""
        memory.update_belief("belief1", 0.5, 0.8)
        memory.update_belief("belief2", 0.7, 0.9)

        model = memory.get_world_model()
        assert len(model) == 2
        assert "belief1" in model
        assert "belief2" in model

    def test_belief_update_history(self, memory):
        """Test that belief updates are tracked."""
        memory.update_belief("test_belief", 0.5, 0.8)
        memory.update_belief("test_belief", 0.6, 0.85)

        belief = memory.get_belief("test_belief")
        assert len(belief["update_history"]) >= 1

    def test_get_personal_fact(self, memory):
        """Test retrieving a personal fact."""
        memory.update_belief("favorite_color", value="blue", confidence=0.99)
        fact = memory.get_personal_fact("favorite_color")
        assert fact is not None
        assert fact["value"] == "blue"
        assert fact["confidence"] == 0.99

    # ========== Procedural Memory Tests ==========

    def test_record_skill(self, memory):
        """Test recording a skill."""
        entry = memory.record_skill("problem_solving", success_rate=0.85, uses=10)
        assert "problem_solving" in memory.procedural

    def test_get_skills(self, memory):
        """Test retrieving all skills."""
        memory.record_skill("skill1", 0.7, uses=5)
        memory.record_skill("skill2", 0.8, uses=10)

        skills = memory.get_skills()
        assert len(skills) == 2

    # ========== Coherence & Integrity Tests ==========

    def test_verify_integrity(self, memory):
        """Test that memory integrity can be verified."""
        memory.log_dream("Test dream")
        memory.update_belief("test_belief", 0.5, 0.8)

        assert memory.verify_integrity() is True

    def test_calculate_coherence(self, memory):
        """Test coherence score calculation."""
        memory.update_belief("belief1", 0.9, 0.95)
        memory.update_belief("belief2", 0.8, 0.92)

        coherence = memory.calculate_coherence_score()
        assert 0.0 <= coherence <= 1.0

    def test_anti_entropy_audit(self, memory):
        """Test running an anti-entropy audit."""
        memory.log_dream("Test")
        memory.update_belief("test", 0.5, 0.8)

        audit = memory.anti_entropy_audit()
        assert "chain_valid" in audit
        assert "coherence_score" in audit

    # ========== Export Tests ==========

    def test_export_full_memory(self, memory):
        """Test exporting the full memory state."""
        memory.log_dream("Dream 1")
        memory.update_belief("belief1", 0.5, 0.8)
        memory.record_skill("skill1", 0.7)

        export = memory.export_full_memory()
        assert "audit_chain" in export
        assert "episodic" in export
        assert "semantic" in export
        assert "procedural" in export

    def test_get_memory_stats(self, memory):
        """Test getting memory statistics."""
        memory.log_dream("Dream")
        memory.update_belief("belief", 0.5, 0.8)
        memory.record_skill("skill", 0.7)

        stats = memory.get_memory_stats()
        assert stats["total_entries"] == 1
        assert stats["total_beliefs"] == 1
        assert stats["total_skills"] == 1

    def test_memory_persistence(self):
        """Test that memories are saved to disk and loaded correctly."""
        temp_file = None
        try:
            # Create a temporary file for memory persistence
            with tempfile.NamedTemporaryFile(delete=False) as tmp:
                temp_file = tmp.name

            # 1. Create a memory instance, add data, and save
            memory1 = AntiEntropyMemory(memory_file=temp_file)
            memory1.log_dream("I flew to the moon", lucidity=0.8)
            memory1.update_belief("moon_is_cheese", value=0.1, confidence=0.9)
            memory1.record_skill("space_travel", success_rate=0.01)
            memory1.update_narrative("My journey began with a dream.")
            
            # Explicitly save, though methods should call it
            memory1._save_memory()

            # 2. Create a new memory instance, loading from the same file
            memory2 = AntiEntropyMemory(memory_file=temp_file)

            # 3. Assert that the data is loaded correctly
            assert len(memory2.episodic) == 1
            assert memory2.episodic[0]["data"]["content"] == "I flew to the moon"
            assert "moon_is_cheese" in memory2.semantic
            assert memory2.semantic["moon_is_cheese"]["value"] == 0.1
            assert "space_travel" in memory2.procedural
            assert "My journey began with a dream." in memory2.narrative_identity["story"]

        finally:
            # Clean up the temporary file
            if temp_file and os.path.exists(temp_file):
                os.remove(temp_file)

if __name__ == "__main__":
    pytest.main([__file__, "-v"])
