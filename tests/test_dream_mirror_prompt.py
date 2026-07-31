"""
#2097 — the dream-journal /mirror endpoint must build its prompt from the ACTUAL
dream entry, not a hardcoded placeholder string.

Two layers:
  * `CognitiveJournal.get_entry(id)` resolves a real entry by id (stdlib only — runs
    in CI).

The Flask-route layer this file also covered was removed: src/hff-api/ was deleted
in its entirety as dead code with zero external wiring (#2539, "repo-slim removal
wave 2"), and no /mirror endpoint was reimplemented in the Node server. Those two
tests loaded src/hff-api/routes/dream_journal.py by path, so they failed with
FileNotFoundError on every clone — invisible until the pytest collection abort was
fixed (#3102). They are deleted rather than repointed because there is no longer a
route to point them at.

Run: python -m pytest tests/test_dream_mirror_prompt.py -q
"""
import json
import sys
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SKILL_DIR = REPO / "skills" / "dream_journal"
sys.path.insert(0, str(SKILL_DIR))

import cognitive_layer  # noqa: E402  (after sys.path insert)


def _seed_journal(tmp_path, monkeypatch):
    """A CognitiveJournal backed by a temp dir holding one known dream, with cwd
    pointed at the temp dir so get_recent's relative fallback dirs stay empty."""
    monkeypatch.chdir(tmp_path)
    dreams = tmp_path / "dreams"
    dreams.mkdir()
    entry = {
        "id": "dream-xyz-1",
        "content": "I was flying over a burning city while a fox watched from a tower.",
        "emotions": ["fear", "awe"],
        "tags": ["flight", "fire", "city"],
        "timestamp": "2026-07-10T00:00:00+00:00",
    }
    (dreams / "dreams_test.jsonl").write_text(json.dumps(entry) + "\n", encoding="utf-8")
    return cognitive_layer.CognitiveJournal(data_dir=str(dreams)), entry


def test_get_entry_resolves_by_id(tmp_path, monkeypatch):
    journal, entry = _seed_journal(tmp_path, monkeypatch)
    found = journal.get_entry("dream-xyz-1")
    assert found is not None
    assert found["content"] == entry["content"]
    assert found["tags"] == entry["tags"]
    # unknown id → None (not a crash, not the wrong entry)
    assert journal.get_entry("no-such-id") is None
