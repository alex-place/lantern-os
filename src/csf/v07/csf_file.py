"""⚠️ NOT the canonical CSF compression format. This is the v0.6/0.7 binary
*container* for the 3^12 lattice "storage face" (the Tesseract substrate), used by
the Status-Cube store (``csf.status_cube``) — not for general file/blob compression.
For real, lossless, zstd/omni-backed compression use the canonical ``csf`` package
(``csf.csf_pack`` / ``csf.omni``). See ``csf.v07`` for the lattice primitives.

CSF v0.6 binary container — Binary writer and reader.

Layout:
  [Header]         24 bytes
  [Dictionary]     variable (optional)
  [Baseline]       variable (low-rank approximation)
  [Delta Stream]   variable (sparse active deltas)
  [Footer]         16 bytes (checksum)

Header (24 bytes):
  0-3   Magic        b"CSF\x06"
  4-5   Version      major.minor (0.6)
  6-7   Flags        bit 0: has dictionary, bit 1: has baseline
  8-11  Baseline CRC CRC32 of baseline section (or 0)
  12-15 Delta count  Number of active delta records
  16-19 Original sz  Original uncompressed size (or 0 for symbolic)
  20-23 File CRC     CRC32 of entire file (excluding this field)
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

from .classical_compressor import SymbolicDictionary, decode_sparse, encode_sparse
from .qutrit_delta import NUM_DIMENSIONS, QutritState
from .quantum_dust import QuantumDustField

MAGIC = b"CSF\x06"
VERSION_MAJOR = 0
VERSION_MINOR = 6

FLAG_HAS_DICTIONARY = 0x01
FLAG_HAS_BASELINE = 0x02


@dataclass
class CSFHeader:
    major: int
    minor: int
    flags: int
    baseline_crc: int
    delta_count: int
    original_size: int
    file_crc: int

    @classmethod
    def from_bytes(cls, data: bytes) -> "CSFHeader":
        if len(data) < 24:
            raise ValueError("header too short")
        return cls(
            major=data[4],
            minor=data[5],
            flags=struct.unpack_from(">H", data, 6)[0],
            baseline_crc=struct.unpack_from(">I", data, 8)[0],
            delta_count=struct.unpack_from(">I", data, 12)[0],
            original_size=struct.unpack_from(">I", data, 16)[0],
            file_crc=struct.unpack_from(">I", data, 20)[0],
        )

    def to_bytes(self) -> bytes:
        buf = bytearray()
        buf.extend(MAGIC)
        buf.append(self.major)
        buf.append(self.minor)
        buf.extend(struct.pack(">H", self.flags))
        buf.extend(struct.pack(">I", self.baseline_crc))
        buf.extend(struct.pack(">I", self.delta_count))
        buf.extend(struct.pack(">I", self.original_size))
        buf.extend(struct.pack(">I", self.file_crc))
        return bytes(buf)


class CSFFileWriter:
    """Write a .csf v0.6 file."""

    def __init__(self):
        self._dictionary: Optional[SymbolicDictionary] = None
        self._baseline_data: bytes = b""
        self._delta_data: bytes = b""
        self._original_size = 0

    def set_dictionary(self, dictionary: SymbolicDictionary) -> None:
        self._dictionary = dictionary

    def set_baseline(self, baseline_bytes: bytes) -> None:
        self._baseline_data = baseline_bytes

    def set_delta_stream(self, delta_bytes: bytes, original_size: int = 0) -> None:
        self._delta_data = delta_bytes
        self._original_size = original_size

    def write(self, path: str | Path) -> int:
        path = Path(path)

        # Build body
        body = bytearray()

        # Header placeholder (24 bytes)
        header = CSFHeader(
            major=VERSION_MAJOR,
            minor=VERSION_MINOR,
            flags=0,
            baseline_crc=0,
            delta_count=0,
            original_size=self._original_size,
            file_crc=0,
        )
        body.extend(header.to_bytes())

        # Dictionary section
        if self._dictionary is not None:
            header.flags |= FLAG_HAS_DICTIONARY
            dict_bytes = self._dictionary.to_bytes()
            body.extend(struct.pack(">I", len(dict_bytes)))
            body.extend(dict_bytes)
        else:
            body.extend(struct.pack(">I", 0))

        # Baseline section
        if self._baseline_data:
            header.flags |= FLAG_HAS_BASELINE
            header.baseline_crc = zlib.crc32(self._baseline_data) & 0xFFFFFFFF
            meta, compressed = encode_sparse(
                self._baseline_data, default_value=0, block_size=1024
            )
            body.extend(struct.pack(">I", len(meta)))
            body.extend(meta)
            body.extend(struct.pack(">I", len(compressed)))
            body.extend(compressed)
        else:
            body.extend(struct.pack(">I", 0))  # meta len = 0

        # Delta stream section
        if self._delta_data:
            delta_compressed = zlib.compress(self._delta_data, level=3)
            body.extend(struct.pack(">I", len(delta_compressed)))
            body.extend(delta_compressed)
            header.delta_count = struct.unpack_from(">I", self._delta_data, 0)[0] if len(self._delta_data) >= 4 else 0
        else:
            body.extend(struct.pack(">I", 0))

        # Recalculate header with correct delta_count
        header_bytes = header.to_bytes()
        body[:24] = header_bytes

        # Compute file CRC over everything except the CRC field itself
        pre_crc = bytes(body[:20] + body[24:])
        file_crc = zlib.crc32(pre_crc) & 0xFFFFFFFF
        header.file_crc = file_crc
        body[:24] = header.to_bytes()

        path.write_bytes(bytes(body))
        return len(body)


class CSFFileReader:
    """Read a .csf v0.6 file."""

    def __init__(self, path: str | Path):
        self._data = Path(path).read_bytes()
        self._offset = 0
        self.header = self._read_header()
        self.dictionary: Optional[SymbolicDictionary] = None
        self.baseline: bytes = b""
        self.delta_stream: bytes = b""
        self._parse()

    def _read_header(self) -> CSFHeader:
        if self._data[:4] != MAGIC:
            raise ValueError(f"not a CSF v0.6 file (magic={self._data[:4]!r})")
        return CSFHeader.from_bytes(self._data)

    def _parse(self) -> None:
        self._offset = 24  # skip header

        # Dictionary
        dict_len = struct.unpack_from(">I", self._data, self._offset)[0]
        self._offset += 4
        if dict_len > 0:
            self.dictionary = SymbolicDictionary.from_bytes(
                self._data[self._offset:self._offset + dict_len]
            )
            self._offset += dict_len

        # Baseline
        meta_len = struct.unpack_from(">I", self._data, self._offset)[0]
        self._offset += 4
        if meta_len > 0:
            meta = self._data[self._offset:self._offset + meta_len]
            self._offset += meta_len
            compressed_len = struct.unpack_from(">I", self._data, self._offset)[0]
            self._offset += 4
            compressed = self._data[self._offset:self._offset + compressed_len]
            self._offset += compressed_len
            self.baseline = decode_sparse(meta, compressed)

        # Delta stream
        delta_len = struct.unpack_from(">I", self._data, self._offset)[0]
        self._offset += 4
        if delta_len > 0:
            self.delta_stream = zlib.decompress(
                self._data[self._offset:self._offset + delta_len]
            )
            self._offset += delta_len

    def verify(self) -> bool:
        """Verify file CRC."""
        pre_crc = self._data[:20] + self._data[24:]
        computed = zlib.crc32(pre_crc) & 0xFFFFFFFF
        return computed == self.header.file_crc
