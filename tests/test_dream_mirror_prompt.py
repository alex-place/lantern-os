"""
#2097 — the dream-journal /mirror endpoint must build its prompt from the ACTUAL
dream entry, not a hardcoded placeholder string.

Two layers:
  * `CognitiveJournal.get_entry(id)` resolves a real entry by id (stdlib only — runs
    in CI).
  * the Flask route composes a content-derived prompt and 404s an unknown id
    (guarded by importorskip("flask") since the CI Python env has no flask).

Run: python -m pytest tests/test_dream_mirror_prompt.py -q
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

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


def test_mirror_route_uses_real_dream_content(tmp_path, monkeypatch):
    pytest.importorskip("flask")
    from flask import Flask

    journal, entry = _seed_journal(tmp_path, monkeypatch)

    # Load the hyphenated-dir route module by file path.
    route_path = REPO / "src" / "hff-api" / "routes" / "dream_journal.py"
    spec = importlib.util.spec_from_file_location("dream_journal_route", route_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    # Force the route to use our seeded temp journal.
    monkeypatch.setattr(mod, "_get_journal", lambda: journal)

    app = Flask(__name__)
    app.register_blueprint(mod.dream_bp)
    client = app.test_client()

    # Known id → 200, and the prompt is derived from the real dream (not the old
    # fixed placeholder string).
    resp = client.get("/api/dreams/mirror/dream-xyz-1")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["dream_id"] == "dream-xyz-1"
    assert "burning city" in body["prompt"]          # narrative echoed back
    assert "flight" in body["prompt"]                 # a recorded symbol
    assert "fear" in body["prompt"]                   # a recorded emotion
    assert body["prompt"] != "Reflect on the symbols and emotions in this dream. What patterns recur?"

    # Unknown id → 404 (no silent placeholder).
    missing = client.get("/api/dreams/mirror/nope")
    assert missing.status_code == 404
    assert missing.get_json()["error"] == "dream_not_found"


def test_build_mirror_prompt_handles_empty_content(tmp_path, monkeypatch):
    pytest.importorskip("flask")
    route_path = REPO / "src" / "hff-api" / "routes" / "dream_journal.py"
    spec = importlib.util.spec_from_file_location("dream_journal_route2", route_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    prompt = mod._build_mirror_prompt({"content": "", "tags": [], "emotions": []})
    assert "no recorded narrative" in prompt
    assert prompt  # never empty
