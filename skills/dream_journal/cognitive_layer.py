"""
Cognitive Dream Journal Layer for Lantern OS

Adds:
- Bayesian fallacy detection on dream / reflection text
- Persistent dream characters (The Fox, The Old Tower) with memory
- Character conversation interface

Designed to coexist with the canonical Lantern Dreamer notebook system
(data/dreamer/notebooks/*.jsonl) and the structured dream journal
(data/dream_journal/). This module focuses on cognitive analysis and
symbolic character interaction.
"""

from datetime import datetime, timezone
import json
from pathlib import Path
from typing import List, Dict, Optional


class BayesianFallacyDetector:
    """Lightweight Bayesian heuristic for common reasoning fallacies in text."""

    def __init__(self):
        self.fallacy_priors = {
            "false_dichotomy": 0.28,
            "appeal_to_emotion": 0.32,
            "hasty_generalization": 0.35,
            "circular_reasoning": 0.18,
        }
        self.threshold = 0.30

    def detect(self, text: str) -> List[Dict]:
        text_lower = text.lower()
        detected = []
        for fallacy, prior in self.fallacy_priors.items():
            likelihood = self._get_likelihood(text_lower, fallacy)
            posterior = (likelihood * prior) / (likelihood * prior + 0.5 * (1 - prior))
            if posterior >= self.threshold:
                detected.append({
                    "fallacy": fallacy.replace("_", " ").title(),
                    "probability": round(posterior, 3),
                    "note": self._get_note(fallacy),
                })
        return detected

    def _get_likelihood(self, text: str, fallacy: str) -> float:
        if fallacy == "false_dichotomy" and ("either" in text or "only" in text):
            return 0.75
        if fallacy == "appeal_to_emotion" and any(w in text for w in ["scary", "feel", "afraid", "beautiful", "terrifying", "wonderful"]):
            return 0.70
        if fallacy == "hasty_generalization" and ("always" in text or "never" in text or "everyone" in text):
            return 0.68
        if fallacy == "circular_reasoning" and "because" in text and text.count("because") > 1:
            return 1.0
        return 0.35

    def _get_note(self, fallacy: str) -> str:
        notes = {
            "false_dichotomy": "Considering only two options when more may exist.",
            "appeal_to_emotion": "Heavy reliance on emotion rather than evidence.",
            "hasty_generalization": "Broad conclusion from limited examples.",
            "circular_reasoning": "Conclusion assumed in the premise.",
        }
        return notes.get(fallacy, "Potential reasoning issue.")


class DreamCharacter:
    """Persistent symbolic character with memory."""

    def __init__(self, name: str, personality: str, save_dir: Path):
        self.name = name
        self.personality = personality
        self.save_path = save_dir / f"character_{name.lower().replace(' ', '_')}.json"
        self.memory: List[Dict] = []
        self.load_memory()

    def remember(self, event: str, source: str = "unknown"):
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event": event,
            "source": source,
        }
        self.memory.append(entry)
        self.save_memory()

    def speak(self, context: str) -> str:
        name_lower = self.name.lower()
        recent = self.memory[-3:] if self.memory else []
        memory_hint = ""
        if recent:
            memory_hint = f" (I carry {len(self.memory)} memories of our talks.)"

        if "fox" in name_lower:
            return f"The Fox tilts its head, eyes glinting.{memory_hint} \"{context}\""
        if "tower" in name_lower:
            return f"The Old Tower stands silent, then a low voice echoes.{memory_hint} \"{context}\""
        return f"{self.name} says: \"{context}\""

    def save_memory(self):
        self.save_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.save_path, "w", encoding="utf-8") as f:
            json.dump({
                "name": self.name,
                "personality": self.personality,
                "memory": self.memory,
            }, f, indent=2)

    def load_memory(self):
        if not self.save_path.exists():
            self.memory = []
            return
        try:
            with open(self.save_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                self.memory = data.get("memory", [])
        except Exception:
            self.memory = []


class CognitiveJournal:
    """High-level journal that wires fallacy detection + character memory."""

    def __init__(self, data_dir: str = "data/dreams"):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.detector = BayesianFallacyDetector()
        self.characters: Dict[str, DreamCharacter] = {}
        self._ensure_characters()

    def _ensure_characters(self):
        defaults = {
            "fox": ("The Fox", "wise, cautious, symbolic guide"),
            "tower": ("The Old Tower", "ancient, watchful, mysterious"),
        }
        for key, (name, personality) in defaults.items():
            if key not in self.characters:
                self.characters[key] = DreamCharacter(name, personality, self.data_dir)

    def analyze(self, text: str) -> List[Dict]:
        """Run fallacy detection on arbitrary text."""
        return self.detector.detect(text)

    def talk(self, character_key: str, message: str, user_id: str = "unknown") -> str:
        """Talk to a character. They remember and respond."""
        key = character_key.lower().strip()
        if key not in self.characters:
            known = ", ".join(self.characters.keys())
            return f"Unknown character '{character_key}'. Known: {known}"
        char = self.characters[key]
        char.remember(message, source=user_id)
        return char.speak(message)

    def character_status(self) -> str:
        """Summary of all characters and their memory counts."""
        lines = ["Dream Characters:"]
        for key, char in self.characters.items():
            lines.append(f"- {char.name}: {len(char.memory)} memories | {char.personality}")
        return "\n".join(lines)


    def get_recent(self, limit: int = 7) -> List[Dict]:
        """Return recent dreams from structured journal JSONL files."""
        all_dreams: List[Dict] = []
        search_dirs = [self.data_dir, Path("data/dream_journal"), Path("data/dreamer/notebooks")]
        for search_dir in search_dirs:
            if not search_dir.exists():
                continue
            for pattern in ("dreams_*.jsonl", "*.jsonl"):
                for file in sorted(search_dir.glob(pattern)):
                    try:
                        with open(file, "r", encoding="utf-8-sig") as f:
                            for line in f:
                                if line.strip():
                                    entry = json.loads(line)
                                    normalized = {
                                        "id": entry.get("id") or entry.get("entry_id") or f"{file.stem}-{len(all_dreams)}",
                                        "content": entry.get("content") or entry.get("text") or "",
                                        "timestamp": entry.get("timestamp") or entry.get("createdAt") or entry.get("recordedAt") or datetime.now(timezone.utc).isoformat(),
                                        "kind": entry.get("kind") or entry.get("type") or "dream",
                                        "emotions": entry.get("emotions") or entry.get("mood") or [],
                                        "tags": entry.get("tags") or entry.get("symbols") or [],
                                        "lucidity": entry.get("lucidity", 0.0),
                                    }
                                    all_dreams.append(normalized)
                    except Exception as e:
                        print(f"[warn] Could not read {file}: {e}")
        all_dreams.sort(key=lambda d: d.get("timestamp", ""), reverse=True)
        return all_dreams[:limit]

    def get_entry(self, entry_id) -> Optional[Dict]:
        """Return a single normalized dream entry by id (string-compared), or None.

        Ids are compared as strings because entries may carry a caller-supplied id
        or a synthesized ``<file>-<n>`` id; there is no separate primary key.
        """
        target = str(entry_id)
        for entry in self.get_recent(limit=10000):
            if str(entry.get("id")) == target:
                return entry
        return None

# Global instance for bot import
_cognitive_journal: CognitiveJournal | None = None


def get_cognitive_journal() -> CognitiveJournal:
    global _cognitive_journal
    if _cognitive_journal is None:
        _cognitive_journal = CognitiveJournal()
    return _cognitive_journal
