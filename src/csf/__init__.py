"""CSF — Convergence-Fitted Searchable Binary Archive."""

from __future__ import annotations

import io
import struct
import zlib
from pathlib import Path
from typing import BinaryIO

from . import header, dictionary, sparse, search


class CsfArchive:
    """In-memory CSF archive: segments + dictionary + search index."""

    def __init__(self):
        self._segments: list[bytes] = []
        self._flags: int = 0

    @property
    def segment_count(self) -> int:
        return len(self._segments)

    @property
    def uncompressed_size(self) -> int:
        return sum(len(s) for s in self._segments)

    @property
    def ratio(self) -> float:
        uc = self.uncompressed_size
        if uc == 0:
            return 0.0
        buf = io.BytesIO()
        self._write_to(buf)
        return buf.tell() / uc

    def add_bytes(self, data: bytes) -> None:
        self._segments.append(data)

    def add_file(self, path: str | Path) -> None:
        with open(path, "rb") as f:
            self._segments.append(f.read())

    def write(self, path: str | Path) -> None:
        with open(path, "w+b") as f:
            self._write_to(f)

    def search(self, query: str) -> list[tuple[int, int, str]]:
        results = []
        qb = query.encode("utf-8")
        for i, seg in enumerate(self._segments):
            pos = seg.find(qb)
            if pos != -1:
                start = max(0, pos - 20)
                end = min(len(seg), pos + len(qb) + 20)
                ctx = seg[start:end].decode("utf-8", errors="replace")
                results.append((i, pos, ctx))
        return results

    def converge(self, other: CsfArchive) -> CsfArchive:
        merged = CsfArchive()
        merged._segments = list(self._segments) + list(other._segments)
        merged._flags = self._flags | other._flags | header.CSF_FLAG_CONVERGED
        return merged

    def _write_to(self, fh: BinaryIO) -> None:
        total_uncompressed = sum(len(s) for s in self._segments)
        header.write_header(fh, version=1, flags=self._flags,
                            segment_count=len(self._segments),
                            uncompressed_size=total_uncompressed)

        seg_table_start = fh.tell()
        fh.write(struct.pack("<I", len(self._segments)))
        placeholder_start = fh.tell()
        for _ in self._segments:
            fh.write(b"\0" * 20)

        sym_dict = dictionary.SymbolicDictionary()
        for seg in self._segments:
            sym_dict.ingest(seg)
        sym_dict.finalize()

        seg_offsets = []
        for seg in self._segments:
            encoded = sym_dict.encode(seg)
            compressed = zlib.compress(encoded, level=3)
            seg_offsets.append((fh.tell(), len(compressed)))
            fh.write(compressed)

        dict_offset = fh.tell()
        dictionary.write_dictionary(fh, sym_dict)

        index_offset = fh.tell()
        idx = search.SearchIndex()
        for i, seg in enumerate(self._segments):
            idx.add_segment(i, seg)
        search.write_index(fh, idx)

        end_pos = fh.tell()
        fh.seek(placeholder_start)
        for off, size in seg_offsets:
            fh.write(struct.pack("<Q", off))
            fh.write(struct.pack("<Q", size))
            fh.write(struct.pack("<I", 0))

        fh.seek(0)
        hdr_bytes = fh.read(header.CSF_HEADER_SIZE)
        patched = header.patch_offsets(hdr_bytes, dict_offset, index_offset)
        fh.seek(0)
        fh.write(patched)
        fh.seek(end_pos)

    @classmethod
    def _read_from(cls, fh: BinaryIO) -> CsfArchive:
        data = fh.read()
        hdr, offset = header.read_header(data)

        seg_count = struct.unpack_from("<I", data, offset)[0]
        offset += 4
        seg_info = []
        for _ in range(seg_count):
            seg_off = struct.unpack_from("<Q", data, offset)[0]
            seg_size = struct.unpack_from("<Q", data, offset + 8)[0]
            offset += 20
            seg_info.append((seg_off, seg_size))

        sym_dict = None
        if hdr.dictionary_offset > 0:
            sym_dict, _ = dictionary.read_dictionary(data, hdr.dictionary_offset)

        archive = cls()
        archive._flags = hdr.flags
        for seg_off, seg_size in seg_info:
            compressed = data[seg_off:seg_off + seg_size]
            encoded = zlib.decompress(compressed)
            if sym_dict:
                archive._segments.append(sym_dict.decode(encoded))
            else:
                archive._segments.append(encoded)
        return archive

    @classmethod
    def open(cls, path: str | Path) -> CsfArchive:
        with open(path, "rb") as f:
            return cls._read_from(f)
