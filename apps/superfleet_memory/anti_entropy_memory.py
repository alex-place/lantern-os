"""
Anti-Entropy 4-Layer Memory System

Episodic + Semantic + Procedural + Meta/Narrative layers with cryptographic audit.
"""

import os
from typing import Dict, List, Optional
import json
from datetime import datetime
from .anti_entropy_audit import CryptographicAuditChain


class AntiEntropyMemory:
    """
    4-Layer memory system for long-term coherent intelligence.

    Layers:
    - Episodic: Raw experiences (dreams, events)
    - Semantic: Facts, beliefs, world model (Bayesian)
    - Procedural: Skills, routines, strategies
    - Meta/Narrative: Identity, coherence, wisdom
    """

    def __init__(self, memory_file: str = "memory.json"):
        self.memory_file = memory_file
        self.audit = CryptographicAuditChain()

        # Layer 1: Episodic Memory (dreams, events)
        self.episodic: List[Dict] = []

        # Layer 2: Semantic Memory (beliefs, facts)
        self.semantic: Dict[str, Dict] = {}

        # Layer 3: Procedural Memory (skills, routines)
        self.procedural: Dict[str, Dict] = {}

        # Layer 4: Meta/Narrative Identity
        self.narrative_identity: Dict = {
            "story": [],
            "last_updated": None,
            "coherence_score": 1.0,
            "paradigm": "default"
        }
        self._load_memory()

    def _load_memory(self):
        """Loads memory from the persistence file."""
        if os.path.exists(self.memory_file):
            with open(self.memory_file, 'r') as f:
                data = json.load(f)
                self.episodic = data.get("episodic", [])
                self.semantic = data.get("semantic", {})
                self.procedural = data.get("procedural", {})
                self.narrative_identity = data.get("narrative_identity", self.narrative_identity)
                
                # Re-initialize audit chain from loaded data
                audit_chain_data = data.get("audit_chain", [])
                self.audit = CryptographicAuditChain() # Reset to empty
                for entry in audit_chain_data:
                    # Directly append, assuming loaded chain is valid
                    self.audit.chain.append(entry)
        else:
            # If no file, ensure audit chain is initialized with a genesis block
            self.audit = CryptographicAuditChain()
            self._save_memory() # Save initial empty state

    def _save_memory(self):
        """Saves current memory state to the persistence file."""
        data = {
            "audit_chain": self.audit.export_chain(),
            "episodic": self.episodic,
            "semantic": self.semantic,
            "procedural": self.procedural,
            "narrative_identity": self.narrative_identity,
        }
        with open(self.memory_file, 'w') as f:
            json.dump(data, f, indent=2)

    # ========== EPISODIC MEMORY ==========

    def log_dream(self, content: str, lucidity: float = 0.0,
                 tags: List[str] = None, emotional_intensity: float = 0.5) -> Dict:
        """Log a dream to episodic memory."""
        entry = self.audit.log(
            action="dream_logged",
            data={
                "content": content,
                "lucidity": lucidity,
                "tags": tags or [],
                "emotional_intensity": emotional_intensity
            }
        )
        self.episodic.append(entry)
        self._save_memory()
        return entry

    def log_event(self, description: str, event_type: str,
                 importance: float = 0.5) -> Dict:
        """Log an event to episodic memory."""
        entry = self.audit.log(
            action="event_logged",
            data={
                "description": description,
                "event_type": event_type,
                "importance": importance
            }
        )
        self.episodic.append(entry)
        self._save_memory()
        return entry

    # ========== SEMANTIC MEMORY ==========

    def update_belief(self, key: str, value: float, confidence: float,
                     source: str = "direct") -> Dict:
        """Update a belief in semantic memory (Bayesian)."""
        entry = self.audit.log(
            action="belief_updated",
            data={
                "key": key,
                "value": value,
                "confidence": confidence,
                "source": source
            }
        )

        self.semantic[key] = {
            "value": value,
            "confidence": confidence,
            "last_updated": entry["timestamp"],
            "update_history": self.semantic.get(key, {}).get("update_history", []) + [entry]
        }
        self._save_memory()
        return entry

    def get_personal_fact(self, fact_key: str) -> Optional[Dict]:
        """Retrieves a specific personal fact (semantic memory entry) by its key."""
        return entry

    def get_belief(self, key: str) -> Optional[Dict]:
        """Retrieve a belief from semantic memory."""
        return self.semantic.get(key)

    def get_world_model(self) -> Dict:
        """Get the current world model (all beliefs)."""
        return {
            k: {"value": v["value"], "confidence": v["confidence"]}
            for k, v in self.semantic.items()
        }

    # ========== PROCEDURAL MEMORY ==========

    def record_skill(self, skill_name: str, success_rate: float,
                    uses: int = 0) -> Dict:
        """Record a skill in procedural memory."""
        entry = self.audit.log(
            action="skill_recorded",
            data={
                "skill_name": skill_name,
                "success_rate": success_rate,
                "uses": uses
            }
        )

        self.procedural[skill_name] = {
            "success_rate": success_rate,
            "uses": uses,
            "last_used": entry["timestamp"]
        self._save_memory()
        }
        return entry

    def get_skills(self) -> Dict:
        """Get all recorded skills."""
        return self.procedural.copy()

    # ========== NARRATIVE IDENTITY ==========

    def update_narrative(self, story_element: str, paradigm: Optional[str] = None) -> Dict:
        """Update the narrative identity story."""
        entry = self.audit.log(
            action="narrative_updated",
            data={
                "story_element": story_element,
                "paradigm": paradigm
            }
        )

        self.narrative_identity["story"].append(story_element)
        self.narrative_identity["last_updated"] = entry["timestamp"]

        if paradigm:
            self.narrative_identity["paradigm"] = paradigm
        self._save_memory()

        return entry

    def get_narrative(self) -> str:
        """Get the current narrative identity story."""
        return " ".join(self.narrative_identity["story"])

    # ========== COHERENCE & ANTI-ENTROPY ==========

    def calculate_coherence_score(self) -> float:
        """Calculate overall memory coherence."""
        if not self.semantic:
            return 1.0

        # Check for contradictions
        contradictions = 0
        total_checks = 0

        for key, belief in self.semantic.items():
            total_checks += 1
            # Simple heuristic: contradictions if confidence is very low on key beliefs
            if belief["confidence"] < 0.3 and key in ["self_image", "world_view"]:
                contradictions += 1

        if total_checks == 0:
            return 1.0

        coherence = 1.0 - (contradictions / total_checks)
        self.narrative_identity["coherence_score"] = coherence
        return coherence

    def verify_integrity(self) -> bool:
        """Verify the integrity of the entire memory system."""
        return self.audit.verify_chain()

    def anti_entropy_audit(self) -> Dict:
        """Run an anti-entropy audit to detect drift."""
        return {
            "timestamp": datetime.now().isoformat(),
            "chain_valid": self.verify_integrity(),
            "coherence_score": self.calculate_coherence_score(),
            "chain_stats": self.audit.get_stats(),
            "episodic_entries": len(self.episodic),
            "semantic_beliefs": len(self.semantic),
            "procedural_skills": len(self.procedural)
        }

    # ========== EXPORT & BACKUP ==========

    def export_full_memory(self) -> Dict:
        """Export the complete memory state."""
        return {
            "timestamp": datetime.now().isoformat(),
            "audit_chain": self.audit.export_chain(),
            "episodic": self.episodic,
            "semantic": self.semantic,
            "procedural": self.procedural,
            "narrative_identity": self.narrative_identity,
            "coherence_score": self.calculate_coherence_score()
        }

    def get_memory_stats(self) -> Dict:
        """Get memory system statistics."""
        return {
            "total_entries": len(self.episodic),
            "total_beliefs": len(self.semantic),
            "total_skills": len(self.procedural),
            "coherence": self.calculate_coherence_score(),
            "is_valid": self.verify_integrity(),
            "audit_chain_length": self.audit.get_stats()["chain_length"]
        }
