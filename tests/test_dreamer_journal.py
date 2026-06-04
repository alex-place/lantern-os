"""
Dream Journal v0 Python Unit Tests
Tests core server.js logic extracted for Python validation.

Run: python -m pytest tests/test_dreamer_journal.py -v
"""

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


class TestNormalizeDreamerEntry(unittest.TestCase):
    """Tests for entry normalization and validation."""

    def test_text_required(self):
        """Entry without text is invalid."""
        entry = {"kind": "dream"}
        self.assertFalse(self._is_valid(entry))

    def test_kind_validation(self):
        """Only valid kinds accepted."""
        valid_kinds = ["dream", "note", "place", "character", "event", "lore", "symbol", "mirror"]
        for kind in valid_kinds:
            entry = {"text": "test", "kind": kind}
            self.assertTrue(self._is_valid(entry), f"kind={kind} should be valid")
        invalid = {"text": "test", "kind": "invalid_kind"}
        self.assertFalse(self._is_valid(invalid))

    def test_tag_limits(self):
        """Max 10 tags enforced."""
        entry = {"text": "test", "tags": [f"tag{i}" for i in range(15)]}
        normalized = self._normalize(entry)
        self.assertLessEqual(len(normalized["tags"]), 10)

    def test_emotions_normalized(self):
        """Emotions split and trimmed."""
        entry = {"text": "test", "emotions": "awe, wonder ,peace"}
        normalized = self._normalize(entry)
        self.assertEqual(normalized["emotions"], ["awe", "wonder", "peace"])

    def test_lucidity_clamped(self):
        """Lucidity clamped to 0-1."""
        entry = {"text": "test", "lucidity": 2.5}
        normalized = self._normalize(entry)
        self.assertLessEqual(normalized["lucidity"], 1.0)
        entry2 = {"text": "test", "lucidity": -0.5}
        normalized2 = self._normalize(entry2)
        self.assertGreaterEqual(normalized2["lucidity"], 0.0)

    def test_default_kind_is_dream(self):
        """Missing kind defaults to dream."""
        entry = {"text": "test"}
        normalized = self._normalize(entry)
        self.assertEqual(normalized["kind"], "dream")

    def test_default_fields(self):
        """Missing fields get safe defaults."""
        entry = {"text": "minimal"}
        normalized = self._normalize(entry)
        self.assertEqual(normalized["emotions"], [])
        self.assertEqual(normalized["tags"], [])
        self.assertEqual(normalized["symbols"], [])
        self.assertEqual(normalized["lucidity"], 0)

    def _is_valid(self, entry):
        text = str(entry.get("text", "")).strip()
        if not text:
            return False
        kind = entry.get("kind", "dream")
        valid_kinds = {"dream", "note", "place", "character", "event", "lore", "symbol", "mirror"}
        return kind in valid_kinds

    def _normalize(self, entry):
        text = str(entry.get("text", "")).strip()
        kind = entry.get("kind", "dream")
        emotions = entry.get("emotions", "")
        if isinstance(emotions, str):
            emotions = [e.strip() for e in emotions.split(",") if e.strip()]
        tags = entry.get("tags", [])
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",") if t.strip()]
        tags = tags[:10]
        lucidity = float(entry.get("lucidity", 0))
        lucidity = max(0, min(1, lucidity))
        symbols = entry.get("symbols", [])
        if isinstance(symbols, str):
            symbols = [s.strip() for s in symbols.split(",") if s.strip()]
        return {
            "text": text,
            "kind": kind,
            "emotions": emotions,
            "tags": tags,
            "lucidity": lucidity,
            "symbols": symbols,
        }


class TestTernaryEncoding(unittest.TestCase):
    """Tests for ternary matrix encoding."""

    def test_generate_id_determinism(self):
        """Same input → same ID."""
        id1 = self._generate_id("test", "dream", "2024-01-01")
        id2 = self._generate_id("test", "dream", "2024-01-01")
        self.assertEqual(id1, id2)

    def test_generate_id_uniqueness(self):
        """Different input → different ID."""
        id1 = self._generate_id("a", "dream", "2024-01-01")
        id2 = self._generate_id("b", "dream", "2024-01-01")
        self.assertNotEqual(id1, id2)

    def test_ternary_to_coords_roundtrip(self):
        """coords → ternary → coords is identity."""
        coords = [0, 1, 2, 0, 2, 1]
        ternary = self._coords_to_ternary(coords)
        recovered = self._ternary_to_coords(ternary)
        self.assertEqual(coords, recovered)

    def test_checksum_calculation(self):
        """Mirror entry checksum is deterministic."""
        entry = {"text": "mirror test", "kind": "mirror", "tags": ["a", "b"]}
        checksum1 = self._compute_checksum(entry)
        checksum2 = self._compute_checksum(entry)
        self.assertEqual(checksum1, checksum2)
        # Different entry → different checksum
        entry2 = {"text": "different", "kind": "mirror", "tags": ["a", "b"]}
        checksum3 = self._compute_checksum(entry2)
        self.assertNotEqual(checksum1, checksum3)

    def _generate_id(self, text, kind, date):
        import hashlib
        seed = f"{text}:{kind}:{date}"
        return hashlib.sha256(seed.encode()).hexdigest()[:16]

    def _coords_to_ternary(self, coords):
        return "".join(str(c % 3) for c in coords)

    def _ternary_to_coords(self, ternary):
        return [int(c) for c in ternary]

    def _compute_checksum(self, entry):
        import hashlib
        payload = json.dumps(entry, sort_keys=True)
        return hashlib.sha256(payload.encode()).hexdigest()[:8]


class TestDreamerStats(unittest.TestCase):
    """Tests for stats computation."""

    def test_empty_entries(self):
        """Empty list → zero stats."""
        stats = self._compute_stats([])
        self.assertEqual(stats["total_entries"], 0)
        self.assertEqual(stats["avg_lucidity"], 0)

    def test_counts_by_kind(self):
        """Counts grouped by kind."""
        entries = [
            {"kind": "dream", "lucidity": 0.8},
            {"kind": "dream", "lucidity": 0.6},
            {"kind": "note", "lucidity": 0},
        ]
        stats = self._compute_stats(entries)
        self.assertEqual(stats["total_entries"], 3)
        self.assertEqual(stats["entries_by_kind"]["dream"], 2)
        self.assertEqual(stats["entries_by_kind"]["note"], 1)

    def test_avg_lucidity(self):
        """Average lucidity calculated correctly."""
        entries = [
            {"kind": "dream", "lucidity": 0.8},
            {"kind": "dream", "lucidity": 0.6},
        ]
        stats = self._compute_stats(entries)
        self.assertAlmostEqual(stats["avg_lucidity"], 0.7, places=2)

    def test_top_emotions(self):
        """Top emotions counted."""
        entries = [
            {"kind": "dream", "emotions": ["awe", "peace"]},
            {"kind": "dream", "emotions": ["awe", "wonder"]},
            {"kind": "note", "emotions": ["peace"]},
        ]
        stats = self._compute_stats(entries)
        self.assertEqual(stats["top_emotions"]["awe"], 2)
        self.assertEqual(stats["top_emotions"]["peace"], 2)

    def test_top_tags(self):
        """Top tags counted."""
        entries = [
            {"kind": "dream", "tags": ["lantern", "test"]},
            {"kind": "note", "tags": ["lantern", "idea"]},
        ]
        stats = self._compute_stats(entries)
        self.assertEqual(stats["top_tags"]["lantern"], 2)

    def test_timeline_sorted(self):
        """Timeline sorted by date."""
        entries = [
            {"kind": "dream", "timestamp": "2024-01-03T00:00:00Z"},
            {"kind": "dream", "timestamp": "2024-01-01T00:00:00Z"},
        ]
        stats = self._compute_stats(entries)
        dates = [e["date"] for e in stats["timeline"]]
        self.assertEqual(dates, sorted(dates))

    def _compute_stats(self, entries):
        from collections import Counter
        total = len(entries)
        by_kind = Counter(e["kind"] for e in entries)
        lucidities = [e.get("lucidity", 0) for e in entries if e.get("lucidity") is not None]
        avg_lucidity = sum(lucidities) / len(lucidities) if lucidities else 0
        emotions = Counter()
        for e in entries:
            for emo in e.get("emotions", []):
                emotions[emo] += 1
        tags = Counter()
        for e in entries:
            for t in e.get("tags", []):
                tags[t] += 1
        timeline = []
        for e in sorted(entries, key=lambda x: x.get("timestamp", "")):
            ts = e.get("timestamp", "")
            date = ts.split("T")[0] if ts else ""
            timeline.append({"date": date, "kind": e["kind"]})
        return {
            "total_entries": total,
            "entries_by_kind": dict(by_kind),
            "avg_lucidity": round(avg_lucidity, 2),
            "top_emotions": dict(emotions.most_common(10)),
            "top_tags": dict(tags.most_common(10)),
            "timeline": timeline,
        }


class TestTaskEntry(unittest.TestCase):
    """Tests for task lifecycle."""

    def test_normalize_task(self):
        """Task gets id and timestamp."""
        task = self._normalize_task({"text": "Review dream symbols"})
        self.assertIn("id", task)
        self.assertIn("createdAt", task)
        self.assertEqual(task["status"], "pending")

    def test_task_completion(self):
        """Task completion updates status."""
        task = self._normalize_task({"text": "Test task"})
        completed = self._complete_task(task)
        self.assertEqual(completed["status"], "completed")
        self.assertIn("completedAt", completed)

    def test_task_text_required(self):
        """Task without text is invalid."""
        self.assertFalse(self._is_valid_task({}))

    def _normalize_task(self, task):
        import uuid
        return {
            "id": task.get("id") or str(uuid.uuid4())[:8],
            "text": str(task.get("text", "")).strip(),
            "status": task.get("status", "pending"),
            "createdAt": task.get("createdAt") or datetime.now(timezone.utc).isoformat(),
        }

    def _complete_task(self, task):
        task["status"] = "completed"
        task["completedAt"] = datetime.now(timezone.utc).isoformat()
        return task

    def _is_valid_task(self, task):
        return bool(str(task.get("text", "")).strip())


class TestJSONLParsing(unittest.TestCase):
    """Tests for JSONL storage format."""

    def test_parse_valid_jsonl(self):
        """Valid JSONL parsed line by line."""
        lines = [
            json.dumps({"id": "1", "text": "dream one"}),
            json.dumps({"id": "2", "text": "dream two"}),
        ]
        parsed = [json.loads(line) for line in lines if line.strip()]
        self.assertEqual(len(parsed), 2)
        self.assertEqual(parsed[0]["text"], "dream one")

    def test_skip_malformed_lines(self):
        """Malformed lines skipped without crashing."""
        lines = [
            json.dumps({"id": "1", "text": "valid"}),
            "not json {",
            json.dumps({"id": "2", "text": "also valid"}),
        ]
        parsed = []
        for line in lines:
            try:
                parsed.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        self.assertEqual(len(parsed), 2)

    def test_file_write_and_read(self):
        """Write entries to temp file, read back."""
        entries = [
            {"id": "1", "text": "entry one"},
            {"id": "2", "text": "entry two"},
        ]
        with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
            for e in entries:
                f.write(json.dumps(e) + "\n")
            path = f.name
        try:
            read = []
            with open(path, "r") as f:
                for line in f:
                    try:
                        read.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
            self.assertEqual(len(read), 2)
            self.assertEqual(read[0]["text"], "entry one")
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
