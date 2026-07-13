"""
Dream Journal API Routes for Lantern OS

Exposes Dream Journal v2 endpoints via Flask blueprint.
Endpoints:
  POST /api/dreams/         — Log a dream
  GET  /api/dreams/recent   — Get recent dreams
  GET  /api/dreams/mirror/<id> — Generate mirror prompt
  POST /api/dreams/character/<name> — Talk to a character
"""

import sys
import os
from pathlib import Path
from flask import Blueprint, request, jsonify

# Add skills to path
_repo_root = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_repo_root / "skills" / "dream_journal"))

try:
    from cognitive_layer import get_cognitive_journal
    COGNITIVE_AVAILABLE = True
except ImportError as e:
    COGNITIVE_AVAILABLE = False
    print(f"[WARN] Cognitive layer not available: {e}")
    get_cognitive_journal = None

dream_bp = Blueprint('dream_journal', __name__, url_prefix='/api/dreams')


def _get_journal():
    """Lazy-init cognitive journal."""
    if get_cognitive_journal:
        return get_cognitive_journal()
    return None


@dream_bp.route('/', methods=['POST'])
def log_dream():
    """Log a dream and run fallacy detection."""
    data = request.get_json(silent=True) or {}
    content = data.get('content', '').strip()
    if not content:
        return jsonify({"error": "content_required"}), 400

    journal = _get_journal()
    fallacies = journal.analyze(content) if journal else []

    return jsonify({
        "status": "logged",
        "content_preview": content[:120],
        "fallacies_detected": len(fallacies),
        "fallacies": fallacies,
    }), 201


@dream_bp.route('/recent', methods=['GET'])
def get_recent():
    """Get recent dreams (placeholder — wired to cognitive layer)."""
    journal = _get_journal()
    if not journal:
        return jsonify({"entries": [], "note": "cognitive_layer_unavailable"})

    limit = request.args.get('limit', 7, type=int)
    entries = journal.get_recent(limit=limit)
    return jsonify({
        "entries": entries,
        "count": len(entries),
        "characters": journal.character_status(),
    })


def _build_mirror_prompt(entry):
    """Compose a reflective mirror prompt from the ACTUAL dream entry — its
    narrative, recorded symbols, and emotions — rather than a fixed string."""
    content = (entry.get("content") or "").strip()
    symbols = entry.get("tags") or []
    emotions = entry.get("emotions") or []

    parts = []
    if content:
        snippet = content[:240] + ("…" if len(content) > 240 else "")
        parts.append(f'In your dream you wrote: "{snippet}"')
    else:
        parts.append("This dream has no recorded narrative yet.")
    if symbols:
        parts.append(
            "Sit with these recurring symbols: "
            + ", ".join(str(s) for s in symbols[:6]) + "."
        )
    if emotions:
        parts.append(
            "You felt "
            + ", ".join(str(e) for e in emotions[:6])
            + " — where in waking life does that feeling live?"
        )
    parts.append(
        "What is this dream asking you to notice, and what pattern connects it to "
        "your recent dreams?"
    )
    return " ".join(parts)


@dream_bp.route('/mirror/<dream_id>', methods=['GET'])
def get_mirror(dream_id):
    """Generate a mirror prompt from the real dream entry (#2097)."""
    journal = _get_journal()
    if not journal:
        return jsonify({"error": "cognitive_layer_unavailable"}), 503

    entry = journal.get_entry(dream_id)
    if not entry:
        return jsonify({"error": "dream_not_found", "dream_id": dream_id}), 404

    content = entry.get("content") or ""
    return jsonify({
        "dream_id": entry.get("id"),
        "prompt": _build_mirror_prompt(entry),
        "content_preview": content[:160],
        "symbols": entry.get("tags") or [],
        "emotions": entry.get("emotions") or [],
        "characters": journal.character_status(),
    })


@dream_bp.route('/character/<name>', methods=['POST'])
def talk_to_character(name):
    """Talk to a persistent dream character."""
    data = request.get_json(silent=True) or {}
    message = data.get('message', '').strip()
    user_id = data.get('user_id', 'api_user')

    if not message:
        return jsonify({"error": "message_required"}), 400

    journal = _get_journal()
    if not journal:
        return jsonify({"error": "cognitive_layer_unavailable"}), 503

    response = journal.talk(name, message, user_id=user_id)
    return jsonify({
        "character": name,
        "message": message,
        "response": response,
    })


@dream_bp.route('/health', methods=['GET'])
def health():
    """Dream Journal API health check."""
    return jsonify({
        "status": "ok",
        "cognitive_layer": COGNITIVE_AVAILABLE,
    })
