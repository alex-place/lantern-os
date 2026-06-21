"""StatusCube — a player's ImagniVerse persisted via the v0.7 lattice container.

(Built on the kept ``csf.v07`` storage face, NOT the canonical CSF compression
format — for file/blob compression use ``csf`` / ``csf_pack`` / ``omni``.)

The cube holds a player's entire game history in one compact binary file:

  Dictionary section  → crystallized symbol tokens (SymbolicDictionary)
  Baseline section    → consolidated state: current position, crystallized
                        symbols, compressed loop history
  Delta stream        → live observations from the current (unconsolidated)
                        loop, one record per door choice

Consolidation runs at loop boundaries: live observations are pattern-matched
into crystallized symbols (e.g. "seeker-of-futures" when a player repeatedly
chooses future-facing doors), then pruned to a one-line loop summary. This
keeps the file small no matter how many loops a player walks.

Usage:
    cube = StatusCube.load("player-id")
    cube.add_observation(stage=0, choice="A", door="The Storybook Door",
                         agent="lantern")
    cube.advance_stage()         # increments stage; consolidates on loop wrap
    cube.save()
"""

from __future__ import annotations

import json
import re
import struct
import time
from collections import Counter
from pathlib import Path
from typing import Optional

from .v07.csf_file import CSFFileReader, CSFFileWriter
from .v07.classical_compressor import SymbolicDictionary

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_DATA_DIR = REPO_ROOT / "data" / "csf"

NUM_STAGES = 7

# Door-name keywords that signal each archetype lens.
_ARCHETYPE_KEYWORDS = {
    "seeker": ("tomorrow", "future", "star", "branch", "beyond", "convergence",
               "mirror", "page", "storybook", "deep"),
    "healer": ("today", "burrow", "ember", "harvest", "lucky", "return",
               "surface", "seed", "hollow", "stream"),
    "explorer": ("unknown", "fog", "echo", "merge", "eternal", "war",
                 "throne", "crown", "bell", "root"),
}


def _infer_archetype_for_door(door_name: str) -> str:
    """Classify a single door choice into an archetype lens."""
    name = door_name.lower()
    scores = {
        arch: sum(1 for kw in kws if kw in name)
        for arch, kws in _ARCHETYPE_KEYWORDS.items()
    }
    best = max(scores, key=lambda a: scores[a])
    return best if scores[best] > 0 else "seeker"


class StatusCube:
    """A single player's ImagniVerse: state + observations + symbols."""

    def __init__(self, user_id: str, data_dir: Path | None = None):
        self.user_id = user_id
        self.data_dir = Path(data_dir) if data_dir else DEFAULT_DATA_DIR
        # Consolidated (baseline) state
        self.stage_index: int = 0
        self.loop_count: int = 0
        self.scene_key: str = ""
        self.history: list[str] = []
        self.symbols: dict[str, dict] = {}       # name -> {definition, strength, loops_observed}
        self.loop_history: list[dict] = []       # [{loop, path, summary}]
        # Live (delta) observations for the current loop
        self.observations: list[dict] = []

    # ── Paths ──

    def _path(self) -> Path:
        safe = re.sub(r"[^a-zA-Z0-9._-]+", "-", self.user_id).strip("-").lower() or "user"
        return self.data_dir / f"{safe}.csf"

    # ── Load / save ──

    @classmethod
    def load(cls, user_id: str, data_dir: Path | None = None) -> "StatusCube":
        cube = cls(user_id, data_dir)
        path = cube._path()
        if not path.exists():
            return cube
        try:
            reader = CSFFileReader(path)
            if reader.baseline:
                base = json.loads(reader.baseline.decode("utf-8"))
                cube.stage_index = int(base.get("stage_index", 0))
                cube.loop_count = int(base.get("loop_count", 0))
                cube.scene_key = base.get("scene_key", "")
                cube.history = base.get("history", [])
                cube.symbols = base.get("symbols", {})
                cube.loop_history = base.get("loop_history", [])
            if reader.delta_stream:
                # Delta stream: 4-byte count then JSON lines
                payload = reader.delta_stream[4:].decode("utf-8")
                cube.observations = [
                    json.loads(line) for line in payload.splitlines() if line.strip()
                ]
        except (ValueError, json.JSONDecodeError, OSError):
            # Corrupt file: start fresh rather than crash the game
            pass
        return cube

    def save(self) -> int:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        writer = CSFFileWriter()

        # Dictionary: crystallized symbol tokens
        if self.symbols:
            sd = SymbolicDictionary(min_freq=1)
            sd.train(list(self.symbols))
            writer.set_dictionary(sd)

        # Baseline: consolidated state
        baseline = json.dumps({
            "stage_index": self.stage_index,
            "loop_count": self.loop_count,
            "scene_key": self.scene_key,
            "history": self.history[-24:],  # keep recent breadcrumbs only
            "symbols": self.symbols,
            "loop_history": self.loop_history[-50:],
        }, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        writer.set_baseline(baseline)

        # Delta stream: live observations as count-prefixed JSON lines
        lines = "\n".join(
            json.dumps(o, ensure_ascii=False, separators=(",", ":"))
            for o in self.observations
        ).encode("utf-8")
        delta = struct.pack(">I", len(self.observations)) + lines
        writer.set_delta_stream(delta, original_size=len(lines))

        return writer.write(self._path())

    def delete(self) -> None:
        path = self._path()
        if path.exists():
            path.unlink()

    # ── Observations ──

    def add_observation(self, stage: int, choice: str, door: str,
                        agent: str = "", scene_key: str = "") -> dict:
        obs = {
            "loop": self.loop_count,
            "stage": stage,
            "choice": choice.upper()[:1],
            "door": door,
            "archetype": _infer_archetype_for_door(door),
            "agent": agent,
            "scene": scene_key,
            "ts": time.time(),
        }
        self.observations.append(obs)
        return obs

    def advance_stage(self) -> bool:
        """Move to the next stage. Returns True when a loop completed
        (stage wrapped past the final stage and consolidation ran)."""
        self.stage_index += 1
        if self.stage_index >= NUM_STAGES:
            self.stage_index = 0
            self.loop_count += 1
            self.consolidate()
            return True
        return False

    # ── Archetype (observer slice) ──

    @property
    def archetype(self) -> str:
        """Dominant archetype across symbols + live observations."""
        counts: Counter = Counter()
        for obs in self.observations:
            counts[obs.get("archetype", "seeker")] += 1
        for name, sym in self.symbols.items():
            arch = sym.get("archetype")
            if arch:
                counts[arch] += int(sym.get("strength", 0.5) * 4)
        return counts.most_common(1)[0][0] if counts else "seeker"

    # ── Consolidation: observations → crystallized symbols ──

    def consolidate(self) -> dict[str, dict]:
        """Mature live observations into crystallized symbols, then prune
        them down to a one-line loop summary. Returns symbols added/updated."""
        if not self.observations:
            return {}

        updated: dict[str, dict] = {}
        loop_obs = self.observations
        arch_counts = Counter(o["archetype"] for o in loop_obs)
        dominant_arch, dom_n = arch_counts.most_common(1)[0]

        # Symbol 1: archetype consistency across the loop
        if dom_n >= max(2, len(loop_obs) // 2):
            name = f"{dominant_arch}-walker"
            prev = self.symbols.get(name, {"strength": 0.0, "loops_observed": 0})
            updated[name] = {
                "definition": f"chooses {dominant_arch}-aligned doors "
                              f"({dom_n}/{len(loop_obs)} choices this loop)",
                "archetype": dominant_arch,
                "strength": round(min(1.0, prev["strength"] + 0.15), 2),
                "loops_observed": prev["loops_observed"] + 1,
            }

        # Symbol 2: repeated specific doors across loops (door affinity)
        door_counts = Counter(o["door"].lower() for o in loop_obs)
        for hist in self.loop_history[-3:]:
            for door in hist.get("doors", []):
                door_counts[door] += 1
        for door, n in door_counts.items():
            if n >= 2:
                slug = re.sub(r"[^a-z0-9]+", "-", door).strip("-")
                name = f"affinity-{slug}"
                prev = self.symbols.get(name, {"strength": 0.0, "loops_observed": 0})
                updated[name] = {
                    "definition": f"repeatedly drawn to {door}",
                    "door": door,
                    "strength": round(min(1.0, prev["strength"] + 0.2), 2),
                    "loops_observed": prev["loops_observed"] + 1,
                }

        # Symbol 3: agent affinity
        agent_counts = Counter(o["agent"] for o in loop_obs if o.get("agent"))
        if agent_counts:
            agent, n = agent_counts.most_common(1)[0]
            if n >= len(loop_obs) // 2 and agent:
                name = f"{agent}-companion"
                prev = self.symbols.get(name, {"strength": 0.0, "loops_observed": 0})
                updated[name] = {
                    "definition": f"walks the doors with {agent}",
                    "agent": agent,
                    "strength": round(min(1.0, prev["strength"] + 0.1), 2),
                    "loops_observed": prev["loops_observed"] + 1,
                }

        self.symbols.update(updated)

        # Decay + prune symbols never reinforced (keeps the cube small)
        for name in list(self.symbols):
            if name not in updated:
                self.symbols[name]["strength"] = round(
                    self.symbols[name]["strength"] - 0.05, 2)
                if self.symbols[name]["strength"] <= 0:
                    del self.symbols[name]

        # Compress this loop's observations into one history line
        self.loop_history.append({
            "loop": loop_obs[0]["loop"],
            "path": "".join(o["choice"] for o in loop_obs),
            "doors": [o["door"].lower() for o in loop_obs],
            "summary": f"{dominant_arch} pattern",
        })
        self.observations = []
        return updated

    # ── Serialization for the game API ──

    def to_dict(self) -> dict:
        return {
            "stage_index": self.stage_index,
            "loop_count": self.loop_count,
            "scene_key": self.scene_key,
            "archetype": self.archetype,
            "history": self.history,
            "symbols": self.symbols,
            "observations_this_loop": len(self.observations),
        }
