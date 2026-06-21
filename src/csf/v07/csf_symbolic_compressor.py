"""CSF Symbolic Compressor v0.7 — analysis-only symbolic projection.

⚠️  LOSSY / NON-INVERTIBLE — NOT a general compressor.
    `compress_text` is a *lossy symbolic projection*, not a reversible codec:
      • the tokenizer (`_tokenize`) drops digits, whitespace and most
        punctuation ($ % # / ( ) etc.), and
      • tokens below `min_freq` encode to id 0 (unknown, unstored).
    There is **no `decompress_text`** — the original text cannot be
    reconstructed. The reported `ratio` is therefore measured against this
    lossy form and is **not a real compression ratio**; `CompressionResult`
    carries `lossless=False` to make that explicit.
    For real, reversible compression of text/memory use `csf.csf_pack`
    (per-file zstd-19 + optional shared dictionary), benchmarked far smaller.

Useful for:
  • symbolic-density analysis (anchor overlap, dictionary coverage)

Pipeline (lossy):
  1. Pre-loaded symbolic dictionary (world anchors baked in)
  2. Tokenize → dictionary IDs (recurring anchors cost ~1 byte)
  3. Sparse CSR for static / default token patterns
  4. Delta encoding for sequential observations
  5. zlib/DEFLATE (level 3) final byte-level pass  [NOT zstd, despite earlier docs]
"""

from __future__ import annotations

import io
import re
import struct
import zlib
from dataclasses import dataclass
from typing import List, Tuple

from .symbolic_dictionary import SymbolicDictionary
from .quantum_dust import QuantumDustField
from .convergence_engine import ConvergenceEngine
from .qutrit_delta import QutritDelta


@dataclass
class CompressionResult:
    original_bytes: int
    compressed_bytes: int
    ratio: float
    dictionary_size: int
    baseline_positions: int
    active_deltas: int
    dust_percentage: float
    convergence_collapsed: int = 0
    # compress_text is a lossy symbolic projection with no decoder; the field
    # exists so the (invalid) text ratio can never be mistaken for a real one.
    lossless: bool = False


def _tokenize(text: str) -> List[str]:
    """Tokenizer that preserves symbolic anchors as single tokens."""
    # Split on whitespace, keep punctuation as separate tokens
    return re.findall(r"[A-Za-z_]+|[.,;!?—\-]", text)


def _pack_varints(values: List[int]) -> bytes:
    buf = bytearray()
    for v in values:
        while v >= 128:
            buf.append((v & 0x7F) | 0x80)
            v >>= 7
        buf.append(v)
    return bytes(buf)


def _sparse_encode(data: bytes, default: int = 0, block_size: int = 512) -> Tuple[bytes, bytes]:
    """CSR-like sparse encoding with zlib."""
    blocks = []
    for i in range(0, len(data), block_size):
        chunk = data[i:i + block_size]
        if any(b != default for b in chunk):
            blocks.append((i // block_size, chunk))

    meta = struct.pack(">III", len(data), block_size, default)
    meta += struct.pack(">I", len(blocks))

    buf = io.BytesIO()
    for idx, chunk in blocks:
        buf.write(struct.pack(">IH", idx, len(chunk)))
        buf.write(chunk)

    compressed = zlib.compress(buf.getvalue(), level=3)
    return meta, compressed


class SymbolicCompressor:
    """End-to-end symbolic compressor."""

    def __init__(self, block_size: int = 512):
        self.block_size = block_size
        self.dictionary = SymbolicDictionary()

    def compress_text(self, text: str) -> Tuple[bytes, CompressionResult]:
        """Compress symbolic text."""
        tokens = _tokenize(text)
        self.dictionary.train(tokens)

        ids = [self.dictionary.encode(t) for t in tokens]
        id_bytes = _pack_varints(ids)

        meta, sparse_compressed = _sparse_encode(
            id_bytes, default=0, block_size=self.block_size
        )

        dict_bytes = self.dictionary.to_bytes()
        body = io.BytesIO()
        body.write(struct.pack(">I", len(dict_bytes)))
        body.write(dict_bytes)
        body.write(meta)
        body.write(sparse_compressed)

        final = zlib.compress(body.getvalue(), level=3)

        original = len(text.encode("utf-8"))
        compressed = len(final)
        ratio = 1.0 - (compressed / original) if original else 0.0

        return final, CompressionResult(
            original_bytes=original,
            compressed_bytes=compressed,
            ratio=ratio,
            dictionary_size=self.dictionary.vocab_size(),
            baseline_positions=0,
            active_deltas=len(tokens),
            dust_percentage=0.0,
        )

    def compress_field(self, field: QuantumDustField) -> Tuple[bytes, CompressionResult]:
        """Compress a Quantum Dust field."""
        engine = ConvergenceEngine(threshold=field.convergence_threshold)
        conv = engine.run(field)

        # Encode active deltas
        delta_buf = io.BytesIO()
        delta_buf.write(struct.pack(">I", len(field.active_deltas)))
        for pos, deltas in sorted(field.active_deltas.items()):
            from .qutrit_delta import pack_delta_list
            delta_buf.write(struct.pack(">I", pos))
            delta_buf.write(pack_delta_list(deltas))

        # Encode baseline (sparse sample)
        base_buf = io.BytesIO()
        base_buf.write(struct.pack(">I", len(field.baseline)))
        for pos, states in sorted(field.baseline.items()):
            base_buf.write(struct.pack(">I", pos))
            for s in states:
                base_buf.write(struct.pack(">BB", s.amplitude, s.phase))

        meta, sparse_data = _sparse_encode(
            delta_buf.getvalue(), default=0, block_size=self.block_size
        )

        body = io.BytesIO()
        body.write(base_buf.getvalue())
        body.write(meta)
        body.write(sparse_data)

        final = zlib.compress(body.getvalue(), level=3)

        original = field.total_positions * 24  # rough
        compressed = len(final)
        ratio = 1.0 - (compressed / original) if original else 0.0

        return final, CompressionResult(
            original_bytes=original,
            compressed_bytes=compressed,
            ratio=ratio,
            dictionary_size=0,
            baseline_positions=len(field.baseline),
            active_deltas=sum(len(d) for d in field.active_deltas.values()),
            dust_percentage=field.dust_percentage,
            convergence_collapsed=conv.collapsed,
        )
