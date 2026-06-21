"""
⚠️ DEPRECATED — CSF v0.3 (dead lineage). This is the retired v0.3 symbolic
delta-stream encoding; nothing in the live tree imports it except the equally-dead
``csf.delta_stream``. It is **NOT** the CSF format. For compression use the
canonical lossless ``csf`` package (``csf_pack`` / ``omni``); for the 3^12 lattice
storage face use ``csf.v07``. Kept for historical reference only.

Variable-length base-3 positional encoding for 3^12 normalized light matrices.

Coordinates are 12-tuples of base-3 digits (0, 1, 2).
The codec supports two modes:
  - Absolute: packs the full position into 1-3 bytes.
  - Delta: encodes the shortest cyclic distance from the previous
    position, using only 2 bits per dimension (3 bytes total for 12D).

Cyclic delta uses the shortest path around the base-3 ring:
  0→1 = +1,  1→0 = -1,  0→2 = -1 (not +2),  2→0 = +1 (not -2).
This guarantees deltas are always in {-1, 0, +1}.
"""

from __future__ import annotations

from typing import Optional, Tuple

DIMENSIONS = 12
TOTAL_POSITIONS = 3 ** DIMENSIONS  # 531_441

# Header bit 7 distinguishes absolute (0) from delta (1).
_FLAG_DELTA = 0x80


def _to_scalar(coords: Tuple[int, ...]) -> int:
    value = 0
    for d in coords:
        value = value * 3 + d
    return value


def _from_scalar(value: int, dims: int = DIMENSIONS) -> Tuple[int, ...]:
    digits = []
    for _ in range(dims):
        digits.append(value % 3)
        value //= 3
    digits.reverse()
    return tuple(digits)


def _cyclic_delta(a: int, b: int) -> int:
    """Shortest signed distance from b to a on the ring Z/3Z."""
    raw = a - b
    if raw > 1:
        return raw - 3
    if raw < -1:
        return raw + 3
    return raw


def encode_absolute(coords: Tuple[int, ...]) -> bytes:
    """Encode a 12D base-3 position as 2-4 bytes (header + 1-3 payload)."""
    if len(coords) != DIMENSIONS:
        raise ValueError(f"expected {DIMENSIONS}-tuple, got {len(coords)}")
    if any(d < 0 or d > 2 for d in coords):
        raise ValueError("all digits must be 0, 1, or 2")

    value = _to_scalar(coords)

    if value < 0x100:
        return bytes([0x01, value])
    if value < 0x10000:
        return bytes([0x02, value >> 8, value & 0xFF])
    return bytes([0x03, (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF])


def decode_absolute(data: bytes, offset: int = 0) -> Tuple[Tuple[int, ...], int]:
    """Decode an absolute position. Returns (coords, new_offset)."""
    header = data[offset]
    if header & _FLAG_DELTA:
        raise ValueError("not an absolute record")
    length = header & 0x7F
    offset += 1

    value = 0
    for i in range(length):
        value = (value << 8) | data[offset + i]
    offset += length

    return _from_scalar(value), offset


def encode_delta(current: Tuple[int, ...], previous: Tuple[int, ...]) -> bytes:
    """
    Encode the cyclic delta between two positions.

    Each dimension's delta is in {-1, 0, +1}, mapped to {0, 1, 2} and
    packed 4 per byte (2 bits each). 12 dimensions = 3 bytes payload.
    """
    if len(current) != DIMENSIONS or len(previous) != DIMENSIONS:
        raise ValueError(f"both positions must be {DIMENSIONS}-tuples")

    deltas = [_cyclic_delta(c, p) for c, p in zip(current, previous)]

    packed = bytearray(3)
    for i, d in enumerate(deltas):
        mapped = d + 1  # -1,0,+1 → 0,1,2
        byte_idx = i // 4
        bit_shift = (3 - (i % 4)) * 2
        packed[byte_idx] |= (mapped & 0x03) << bit_shift

    return bytes([_FLAG_DELTA | 3]) + bytes(packed)


def decode_delta(data: bytes, offset: int, previous: Tuple[int, ...]) -> Tuple[Tuple[int, ...], int]:
    """Decode a delta record given the previous position."""
    header = data[offset]
    if not (header & _FLAG_DELTA):
        raise ValueError("not a delta record")
    length = header & 0x7F
    offset += 1

    if length != 3:
        raise ValueError(f"expected 3-byte delta payload, got {length}")

    packed = data[offset:offset + 3]
    offset += 3

    coords = []
    for i in range(DIMENSIONS):
        byte_idx = i // 4
        bit_shift = (3 - (i % 4)) * 2
        mapped = (packed[byte_idx] >> bit_shift) & 0x03
        delta = mapped - 1  # 0,1,2 → -1,0,+1
        coords.append((previous[i] + delta) % 3)

    return tuple(coords), offset


class Base3Codec:
    """Stateful encoder/decoder that tracks position for delta coding."""

    def __init__(self):
        self._last: Optional[Tuple[int, ...]] = None

    def encode(self, coords: Tuple[int, ...]) -> bytes:
        if self._last is not None:
            result = encode_delta(coords, self._last)
        else:
            result = encode_absolute(coords)
        self._last = coords
        return result

    def decode(self, data: bytes, offset: int = 0) -> Tuple[Tuple[int, ...], int]:
        header = data[offset]
        if header & _FLAG_DELTA:
            if self._last is None:
                raise ValueError("delta record with no previous position")
            coords, new_offset = decode_delta(data, offset, self._last)
        else:
            coords, new_offset = decode_absolute(data, offset)
        self._last = coords
        return coords, new_offset

    def reset(self):
        self._last = None

    @property
    def last_position(self) -> Optional[Tuple[int, ...]]:
        return self._last
