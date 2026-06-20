"""
CSF file format — reference writer and reader.

Layout:
  [Magic 4 bytes: CSF\\x00]
  [Version 2 bytes: major.minor]
  [Flags 2 bytes]
  [Baseline section]
  [Dictionary section]
  [Delta stream section]
  [Footer: checksum + sizes]
"""

from __future__ import annotations

import hashlib
import json
import struct
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .base3 import DIMENSIONS, TOTAL_POSITIONS, _from_scalar, _to_scalar
from .delta_stream import DeltaStreamWriter, DeltaStreamReader, DeltaType, Record

MAGIC = b"CSF\x00"
VERSION_MAJOR = 0
VERSION_MINOR = 3

# Footer: the low 16 hex chars of sha256(everything-before-footer), ASCII-encoded.
FOOTER_LEN = 16


@dataclass
class CSFMetadata:
    version: Tuple[int, int] = (VERSION_MAJOR, VERSION_MINOR)
    created_at: float = 0.0
    baseline_hash: str = ""
    dictionary_size: int = 0
    delta_count: int = 0
    total_bytes: int = 0


class SymbolicDictionary:
    """Maps anchor/character names to short integer codes."""

    # Well-known anchors from the world model
    BUILTIN = {
        "Garden": 0x01,
        "Table": 0x02,
        "Lantern": 0x03,
        "Convergence": 0x04,
        "CityOfDoors": 0x05,
        "Sigil": 0x06,
        "Return": 0x07,
        "Founder": 0x10,
        "Keystone": 0x11,
        "Blinkbug": 0x12,
        "Gage": 0x13,
    }

    def __init__(self):
        self._name_to_code: Dict[str, int] = dict(self.BUILTIN)
        self._code_to_name: Dict[int, str] = {v: k for k, v in self.BUILTIN.items()}
        self._next_code = 0x80

    def encode_name(self, name: str) -> int:
        if name in self._name_to_code:
            return self._name_to_code[name]
        code = self._next_code
        self._next_code += 1
        self._name_to_code[name] = code
        self._code_to_name[code] = name
        return code

    def decode_code(self, code: int) -> str:
        return self._code_to_name.get(code, f"unknown_{code:#x}")

    def to_bytes(self) -> bytes:
        blob = json.dumps(self._name_to_code, separators=(",", ":")).encode()
        return struct.pack(">H", len(blob)) + blob

    @classmethod
    def from_bytes(cls, data: bytes, offset: int = 0) -> Tuple["SymbolicDictionary", int]:
        length = struct.unpack_from(">H", data, offset)[0]
        offset += 2
        mapping = json.loads(data[offset:offset + length])
        offset += length
        sd = cls()
        sd._name_to_code = mapping
        sd._code_to_name = {v: k for k, v in mapping.items()}
        sd._next_code = max(sd._code_to_name.keys(), default=0x7F) + 1
        return sd, offset


class CSFWriter:
    """Writes a .csf file."""

    def __init__(self):
        self.dictionary = SymbolicDictionary()
        self._delta_writer = DeltaStreamWriter()
        self._baseline: bytes = b""
        self._delta_count = 0

    def set_baseline(self, sparse_cells: Dict[int, int]):
        """Set the converged baseline as a sparse map of scalar_position → value."""
        blob = json.dumps(
            {str(k): v for k, v in sparse_cells.items()},
            separators=(",", ":"),
        ).encode()
        self._baseline = struct.pack(">I", len(blob)) + blob

    def add_confirmation(self, level: int, position: Tuple[int, ...],
                         extent: int = 0xFF):
        self._delta_writer.confirm(level, position, extent)
        self._delta_count += 1

    def add_delta(self, level: int, dtype: DeltaType,
                  position: Tuple[int, ...], payload: bytes = b""):
        self._delta_writer.delta(level, dtype, position, payload)
        self._delta_count += 1

    def write(self, path: str | Path) -> CSFMetadata:
        path = Path(path)
        dict_bytes = self.dictionary.to_bytes()
        delta_bytes = self._delta_writer.to_bytes()

        body = bytearray()
        body.extend(MAGIC)
        body.extend(struct.pack(">BB", VERSION_MAJOR, VERSION_MINOR))
        body.extend(struct.pack(">H", 0))  # flags reserved

        # Baseline section
        body.extend(self._baseline if self._baseline else struct.pack(">I", 0))

        # Dictionary section
        body.extend(dict_bytes)

        # Delta stream section
        body.extend(struct.pack(">I", len(delta_bytes)))
        body.extend(delta_bytes)

        # Footer: integrity checksum over the entire body written so far.
        checksum = hashlib.sha256(body).hexdigest()[:FOOTER_LEN]
        body.extend(checksum.encode())

        path.write_bytes(bytes(body))

        return CSFMetadata(
            version=(VERSION_MAJOR, VERSION_MINOR),
            created_at=time.time(),
            baseline_hash=hashlib.sha256(self._baseline).hexdigest()[:16],
            dictionary_size=len(self.dictionary._name_to_code),
            delta_count=self._delta_count,
            total_bytes=len(body),
        )


class CSFReader:
    """Reads a .csf file."""

    def __init__(self, path: str | Path):
        self._data = Path(path).read_bytes()
        self._offset = 0
        self.metadata = CSFMetadata()
        self.dictionary = SymbolicDictionary()
        self.baseline: Dict[int, int] = {}
        self.records: List[Record] = []
        self._parse()

    @staticmethod
    def _verify_integrity(d: bytes) -> None:
        """Recompute the SHA-256 footer over the body and compare it to the
        stored footer. Raises ValueError on truncation or any byte mismatch."""
        if len(d) < FOOTER_LEN:
            raise ValueError(
                "CSF file too small / truncated (missing integrity footer)")
        body, footer = d[:-FOOTER_LEN], d[-FOOTER_LEN:]
        expected = hashlib.sha256(body).hexdigest()[:FOOTER_LEN].encode()
        if footer != expected:
            raise ValueError(
                "CSF integrity check failed (footer checksum mismatch)")

    def _parse(self):
        d = self._data
        o = 0

        magic = d[o:o + 4]
        if magic != MAGIC:
            raise ValueError(f"not a CSF file (magic={magic!r})")
        o += 4

        # Integrity FIRST — the writer appends a SHA-256 footer over everything
        # before it. Recompute and compare before parsing, so corruption or
        # truncation fails with a clean error instead of silently-wrong records.
        self._verify_integrity(d)

        major, minor = struct.unpack_from(">BB", d, o)
        o += 2
        self.metadata.version = (major, minor)

        _flags = struct.unpack_from(">H", d, o)[0]
        o += 2

        # Baseline
        bl_len = struct.unpack_from(">I", d, o)[0]
        o += 4
        if bl_len > 0:
            raw = json.loads(d[o:o + bl_len])
            self.baseline = {int(k): v for k, v in raw.items()}
            o += bl_len

        # Dictionary
        self.dictionary, o = SymbolicDictionary.from_bytes(d, o)

        # Delta stream
        ds_len = struct.unpack_from(">I", d, o)[0]
        o += 4
        if ds_len > 0:
            reader = DeltaStreamReader(d[o:o + ds_len])
            self.records = reader.read_all()
            o += ds_len

        self.metadata.total_bytes = len(d)
        self.metadata.delta_count = len(self.records)
        self.metadata.dictionary_size = len(self.dictionary._name_to_code)
