"""Symbolic Dictionary — world-anchor token table for the v0.7 lattice storage face.

A **lossless primitive** (symbol ↔ token id), pre-loaded with the Lantern cosmology
vocabulary and extended on the fly, used by the kept v0.7 lattice container
(``csf.v07.csf_file``). It is **NOT a compressor** and gives no ratio advantage over
the canonical core — the old lossy "symbolic compression" this once fed was
**removed** in the v2 CSF consolidation (2026-06). For real compression use the
canonical ``csf`` package (``csf_pack`` / ``omni``).
"""

from __future__ import annotations

import io
import struct
from collections import Counter
from typing import Dict, List, Optional, Set


# ------------------------------------------------------------------
# Pre-loaded World Anchors (from lantern-os lore / DREAM_DOORS)
# ------------------------------------------------------------------

BUILTIN_ANCHORS = [
    # Core cosmology
    "Lantern", "Keystone", "Garden", "Table", "Return", "Convergence",
    "CityOfDoors", "Sigil", "Founder", "Wish", "Anchor", "Door",
    "Blinkbug", "Gage", "Xenon", "Fog", "Cloud", "Sea", "Dream",
    "Mirror", "Reflection", "Light", "Path", "Threshold", "Crossing",
    # Door series
    "FoundersWishDoor", "GagesWindowsXPDoor", "XenonDoor",
    "SeaOfFogAndCloudsDoor", "CityOfDoors", "ReturnDoor",
    # Emotional / thematic anchors
    "Love", "Safety", "Truth", "Beauty", "Freedom", "Memory",
    # Qutrit / system concepts
    "QuantumDust", "Qutrit", "Delta", "Baseline", "ConvergencePass",
    "Observation", "Sensor", "Drift", "Cluster", "Phase", "Amplitude",
    # Common dream vocabulary
    "Vivid", "Strange", "Familiar", "Distant", "Near", "Holding",
    "Protecting", "Building", "Becoming", "Waking", "Sleeping",
    # Structural markers
    "ENTRY_START", "ENTRY_END", "ANCHOR", "CHARACTER", "PLACE",
    "EMOTION", "COLOR", "TIME", "EVENT",
]


class SymbolicDictionary:
    """Adaptive dictionary seeded with the full Lantern cosmology.

    For symbolic data, this means recurring anchors cost ~1 byte
    instead of their full UTF-8 length.
    """

    def __init__(self, min_freq: int = 2, builtins: Optional[List[str]] = None):
        self.min_freq = min_freq
        self._token_to_id: Dict[str, int] = {}
        self._id_to_token: Dict[int, str] = {}
        self._next_id = 1  # 0 reserved for unknown / out-of-vocab

        # Seed with builtins
        for token in (builtins or BUILTIN_ANCHORS):
            self._register(token)

    def _register(self, token: str) -> int:
        if token not in self._token_to_id:
            self._token_to_id[token] = self._next_id
            self._id_to_token[self._next_id] = token
            self._next_id += 1
        return self._token_to_id[token]

    def train(self, tokens: List[str]) -> None:
        """Extend dictionary from observed token frequencies."""
        counts = Counter(tokens)
        for token, count in counts.most_common():
            if count < self.min_freq:
                break
            self._register(token)

    def encode(self, token: str) -> int:
        return self._token_to_id.get(token, 0)

    def decode(self, token_id: int) -> str:
        return self._id_to_token.get(token_id, f"?{token_id}")

    def vocab_size(self) -> int:
        return len(self._token_to_id)

    def known_tokens(self) -> Set[str]:
        return set(self._token_to_id.keys())

    def to_bytes(self) -> bytes:
        """Serialize: [count:2] then [id:2][len:1][token]..."""
        buf = io.BytesIO()
        buf.write(struct.pack(">H", len(self._token_to_id)))
        for tid, token in sorted(self._id_to_token.items()):
            tok_bytes = token.encode("utf-8")
            buf.write(struct.pack(">HB", tid, len(tok_bytes)))
            buf.write(tok_bytes)
        return buf.getvalue()

    @classmethod
    def from_bytes(cls, data: bytes) -> "SymbolicDictionary":
        offset = 0
        count = struct.unpack_from(">H", data, offset)[0]
        offset += 2
        sd = cls(builtins=[])
        for _ in range(count):
            tid, tlen = struct.unpack_from(">HB", data, offset)
            offset += 3
            token = data[offset:offset + tlen].decode("utf-8")
            offset += tlen
            sd._token_to_id[token] = tid
            sd._id_to_token[tid] = token
            sd._next_id = max(sd._next_id, tid + 1)
        return sd
