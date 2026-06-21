"""
⚠️ DEPRECATED — CSF v0.3 (dead lineage). Nothing in the live tree imports this; it
and its dependency ``csf.base3`` are the retired v0.3 symbolic delta stream. It is
**NOT** the CSF format — use the canonical lossless ``csf`` package (``csf_pack`` /
``omni``) for compression and ``csf.v07`` for the lattice storage face. Historical only.

Observation Delta Stream encoder/decoder for CSF v0.3.

Record types:
  - Confirmation (heartbeat): confirms a region is still at converged baseline.
  - Delta: reports an actual state change at a specific position.

Wire format per record:
  [1-byte header] [base3-encoded position] [payload]

Header layout:
  bit 7:   record type (0 = confirmation, 1 = delta)
  bits 6-4: hierarchical level (0 = coarsest, 7 = finest)
  bits 3-0: delta type (only when bit 7 = 1)
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from enum import IntEnum
from typing import List, Optional, Tuple

from .base3 import Base3Codec, encode_absolute


class DeltaType(IntEnum):
    LIGHT_CHANGED = 0x0
    NEW_RELATIONSHIP = 0x1
    RELATIONSHIP_DISSOLVED = 0x2
    CHARACTER_APPEARANCE = 0x3
    CHARACTER_DEPARTURE = 0x4
    CONVERGENCE_EVENT = 0x5
    ANCHOR_ACTIVATION = 0x6
    ANCHOR_DEACTIVATION = 0x7


_TYPE_BIT = 0x80
_LEVEL_SHIFT = 4
_LEVEL_MASK = 0x70
_DTYPE_MASK = 0x0F


@dataclass
class Record:
    is_confirmation: bool
    level: int
    delta_type: DeltaType = DeltaType.LIGHT_CHANGED
    position: Tuple[int, ...] = ()
    payload: bytes = b""


def _build_header(is_confirmation: bool, level: int, delta_type: int = 0) -> int:
    if not 0 <= level <= 7:
        raise ValueError("level must be 0-7")
    h = (level & 0x07) << _LEVEL_SHIFT
    if not is_confirmation:
        h |= _TYPE_BIT | (delta_type & _DTYPE_MASK)
    return h


def _parse_header(byte: int) -> Tuple[bool, int, int]:
    is_confirmation = (byte & _TYPE_BIT) == 0
    level = (byte & _LEVEL_MASK) >> _LEVEL_SHIFT
    delta_type = byte & _DTYPE_MASK if not is_confirmation else 0
    return is_confirmation, level, delta_type


# --- Encoding ---

def encode_confirmation(level: int, position: Tuple[int, ...],
                        extent: int = 0xFF) -> bytes:
    header = _build_header(True, level)
    pos_bytes = encode_absolute(position)
    return bytes([header]) + pos_bytes + bytes([extent & 0xFF])


def encode_delta(level: int, delta_type: DeltaType,
                 position: Tuple[int, ...], payload: bytes = b"",
                 codec: Optional[Base3Codec] = None) -> bytes:
    header = _build_header(False, level, int(delta_type))
    if codec is not None:
        pos_bytes = codec.encode(position)
    else:
        pos_bytes = encode_absolute(position)
    return bytes([header]) + pos_bytes + bytes([len(payload)]) + payload


# --- Decoding ---

def decode_record(data: bytes, offset: int,
                  codec: Optional[Base3Codec] = None) -> Tuple[Record, int]:
    """Decode one record from the stream. Returns (record, new_offset).

    Raises ValueError if the buffer is truncated mid-record rather than
    silently substituting defaults, so truncation is detected, not swallowed.
    """
    if offset >= len(data):
        raise ValueError("truncated delta stream: missing record header")
    header = data[offset]
    offset += 1
    is_conf, level, dtype = _parse_header(header)

    try:
        if codec is not None:
            position, offset = codec.decode(data, offset)
        else:
            from .base3 import decode_absolute
            position, offset = decode_absolute(data, offset)
    except IndexError:
        raise ValueError("truncated delta stream: incomplete position field")

    if is_conf:
        if offset >= len(data):
            raise ValueError(
                "truncated delta stream: confirmation record missing extent byte")
        extent = data[offset]
        offset += 1
        return Record(True, level, position=position,
                      payload=bytes([extent])), offset
    else:
        if offset >= len(data):
            raise ValueError(
                "truncated delta stream: delta record missing payload length")
        payload_len = data[offset]
        offset += 1
        end = offset + payload_len
        if end > len(data):
            raise ValueError(
                "truncated delta stream: delta payload shorter than declared length")
        payload = data[offset:end]
        offset = end
        return Record(False, level, DeltaType(dtype),
                      position=position, payload=payload), offset


# --- Stream helpers ---

class DeltaStreamWriter:
    """Writes a sequence of records into a byte buffer."""

    def __init__(self):
        self._codec = Base3Codec()
        self._buf = bytearray()

    def confirm(self, level: int, position: Tuple[int, ...],
                extent: int = 0xFF):
        self._buf.extend(encode_confirmation(level, position, extent))

    def delta(self, level: int, dtype: DeltaType,
              position: Tuple[int, ...], payload: bytes = b""):
        self._buf.extend(
            encode_delta(level, dtype, position, payload, self._codec))

    def to_bytes(self) -> bytes:
        return bytes(self._buf)


class DeltaStreamReader:
    """Reads records from a byte buffer."""

    def __init__(self, data: bytes):
        self._data = data
        self._offset = 0
        self._codec = Base3Codec()

    def read(self) -> Optional[Record]:
        if self._offset >= len(self._data):
            return None
        rec, self._offset = decode_record(
            self._data, self._offset, self._codec)
        return rec

    def read_all(self, expected: Optional[int] = None) -> List[Record]:
        """Decode every record in the buffer.

        A record truncated mid-stream raises (via ``decode_record``) instead of
        being silently dropped. If ``expected`` is given, the final record count
        must match it exactly or a ValueError is raised — catching the case
        where the buffer ends cleanly on a record boundary but is short records.
        """
        records = []
        while True:
            rec = self.read()
            if rec is None:
                break
            records.append(rec)
        if expected is not None and len(records) != expected:
            raise ValueError(
                f"delta stream record count mismatch: "
                f"decoded {len(records)}, expected {expected}")
        return records
