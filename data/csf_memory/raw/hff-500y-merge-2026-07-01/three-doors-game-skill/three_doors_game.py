"""
Three Doors Game skill — state management for Keystone OS (#1099)

Provides programmatic access to the canonical Three Doors scene graph at
data/three-doors/scenes.json and persistent player state at
data/three-doors/player-state.json.

Functions
---------
load_scene_graph()        → dict of all scenes
get_scene(scene_id)       → single scene dict (raises KeyError if not found)
load_player_state()       → current player state
save_player_state(state)  → persist state
get_active_scene()        → (scene_id, scene_dict) for current player location
enter_scene(scene_id)     → move to a new scene, return updated state
reset_game()              → return to start, clear history
export_csf(name)          → CSF-format portable state string for !ingest / handoff
list_choices()            → list of door dicts available at current scene

These are pure state-management helpers. The LLM persona (in dream-chat.js)
drives narrative. The Python layer drives persistence + routing.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

# ── Paths ─────────────────────────────────────────────────────────────────────

_HERE = Path(__file__).parent
_REPO = _HERE.parent.parent
_SCENE_GRAPH_PATH = _REPO / "data" / "three-doors" / "scenes.json"
_PLAYER_STATE_PATH = _REPO / "data" / "three-doors" / "player-state.json"

_DEFAULT_STATE: Dict[str, Any] = {
    "current_scene": "start",
    "history": [],
    "fox_present": False,
    "images_only": False,
    "notes": "",
    "created": None,
    "updated": None,
}

# ── Scene graph ───────────────────────────────────────────────────────────────

def load_scene_graph() -> Dict[str, Any]:
    """Load the canonical scene graph from data/three-doors/scenes.json."""
    with _SCENE_GRAPH_PATH.open(encoding="utf-8") as f:
        data = json.load(f)
    return data.get("scenes", data)


def get_scene(scene_id: str) -> Dict[str, Any]:
    """Return a single scene dict. Raises KeyError if scene_id is unknown."""
    graph = load_scene_graph()
    if scene_id not in graph:
        available = sorted(graph.keys())
        raise KeyError(f"Unknown scene '{scene_id}'. Available: {available}")
    return graph[scene_id]


def list_scene_ids() -> list[str]:
    """Return sorted list of all scene IDs in the graph."""
    return sorted(load_scene_graph().keys())


# ── Player state ──────────────────────────────────────────────────────────────

def load_player_state() -> Dict[str, Any]:
    """Load player state, falling back to defaults if file does not exist."""
    if not _PLAYER_STATE_PATH.exists():
        state = dict(_DEFAULT_STATE)
        state["created"] = datetime.now(timezone.utc).isoformat()
        state["updated"] = state["created"]
        return state
    with _PLAYER_STATE_PATH.open(encoding="utf-8") as f:
        data = json.load(f)
    # fill missing keys from defaults
    for k, v in _DEFAULT_STATE.items():
        if k not in data:
            data[k] = v
    return data


def save_player_state(state: Dict[str, Any]) -> None:
    """Persist player state to data/three-doors/player-state.json."""
    _PLAYER_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    state["updated"] = datetime.now(timezone.utc).isoformat()
    with _PLAYER_STATE_PATH.open("w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)


# ── Gameplay ──────────────────────────────────────────────────────────────────

def get_active_scene() -> Tuple[str, Dict[str, Any]]:
    """Return (scene_id, scene_dict) for the player's current location."""
    state = load_player_state()
    scene_id = state.get("current_scene", "start")
    try:
        scene = get_scene(scene_id)
    except KeyError:
        scene_id = "start"
        scene = get_scene(scene_id)
    return scene_id, scene


def list_choices() -> list[Dict[str, Any]]:
    """
    Return the list of door choices available at the current scene.
    Each door dict includes at minimum a 'name'; may also have 'label',
    'description', etc. depending on the scene graph format.
    """
    _, scene = get_active_scene()
    doors = scene.get("doors", [])
    # Normalize: scene graph uses either list[str] or list[dict]
    result = []
    for door in doors:
        if isinstance(door, str):
            try:
                dest_scene = get_scene(door)
                result.append({
                    "id": door,
                    "name": dest_scene.get("name", door),
                    "description": dest_scene.get("description", ""),
                })
            except KeyError:
                result.append({"id": door, "name": door, "description": ""})
        elif isinstance(door, dict):
            result.append(door)
    return result


def enter_scene(scene_id: str) -> Dict[str, Any]:
    """
    Move the player to scene_id. Validates the scene exists, appends to history,
    and persists state. Returns the updated state dict.
    """
    # Validate destination
    scene = get_scene(scene_id)  # raises KeyError if unknown

    state = load_player_state()
    current = state.get("current_scene", "start")
    if current != scene_id:
        state.setdefault("history", []).append(current)

    state["current_scene"] = scene_id

    # Auto-set fox_present if the scene has it
    if "fox_present" in scene:
        state["fox_present"] = scene["fox_present"]

    save_player_state(state)
    return state


def reset_game() -> Dict[str, Any]:
    """Clear history and return the player to 'start'. Persists state."""
    state = load_player_state()
    state["current_scene"] = "start"
    state["history"] = []
    state["fox_present"] = False
    state["images_only"] = False
    state["notes"] = ""
    save_player_state(state)
    return state


def set_images_only(enabled: bool) -> Dict[str, Any]:
    """Toggle images-only mode. Persists and returns updated state."""
    state = load_player_state()
    state["images_only"] = bool(enabled)
    save_player_state(state)
    return state


# ── CSF export ────────────────────────────────────────────────────────────────

def export_csf(player_name: str = "the dreamer") -> str:
    """
    Return a CSF-format portable state string for !ingest / Grok handoff.
    Format matches the contract in SKILL.md §CSF export/import format.
    """
    state = load_player_state()
    scene_id = state.get("current_scene", "start")
    try:
        scene = get_scene(scene_id)
        scene_name = scene.get("name", scene_id)
        scene_prose = scene.get("text", scene.get("prose", ""))
    except KeyError:
        scene_name = scene_id
        scene_prose = ""

    history = state.get("history", [])
    fox = state.get("fox_present", False)
    images_only = state.get("images_only", False)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    lines = [
        "```csf-ingest",
        "## Instructions",
        "This is a Three Doors Game portable state export. Use it to continue the game from the saved state.",
        "",
        "## Identity & Symbolic Self",
        f"[{today}] - Player: {player_name}.",
        f"[{today}] - Fox companion present: {fox}.",
        f"[{today}] - Images-only mode: {images_only}.",
        "",
        "## Dreams & Memories",
    ]
    if history:
        for past in history:
            try:
                past_scene = get_scene(past)
                past_name = past_scene.get("name", past)
            except KeyError:
                past_name = past
            lines.append(f"[{today}] - Walked through: {past_name} ({past}).")
    else:
        lines.append(f"[{today}] - No prior scenes recorded.")
    lines += [
        "",
        "## Projects & Systems",
        f"[{today}] - Active scene: {scene_name} ({scene_id}).",
    ]
    if scene_prose:
        short = scene_prose[:200].replace("\n", " ") + ("…" if len(scene_prose) > 200 else "")
        lines.append(f"[{today}] - Scene text: {short}")
    choices = list_choices()
    if choices:
        door_names = ", ".join(d.get("name", d.get("id", "?")) for d in choices)
        lines.append(f"[{today}] - Available doors: {door_names}.")
    lines += [
        "",
        "## Preferences",
        f"[{today}] - Game tone: artsy, dreamlike, liminal.",
        f"[{today}] - Fox companion style: brass tag, name FRIEND OF THE ONE WHO CHOSE GREEN.",
        "```",
    ]
    return "\n".join(lines)
