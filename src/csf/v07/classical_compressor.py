"""Classical Compressor v0.7 — hybrid pipeline optimized for 3^12 symbolic data.

Combines the best classical techniques:
  1. Dictionary encoding for recurring symbols/anchors.
  2. Sparse CSR for mostly-static regions.
  3. Delta encoding for sequential observations.
  4. Low-rank baseline approximation (SVD-style on coarse grid).
  5. Multi-level convergence for aggressive baseline collapse.
  6. zlib/DEFLATE (level 3) final byte-level pass.

This is the classical-computer-optimized heart of CSF v0.7.
NOTE: the final pass is zlib, not zstd (earlier docs misstated this). For
strong, reversible byte-level compression use `csf.csf_pack` (zstd-19).
"""

from __future__ import annotations

import io
import struct
import zlib
from collections import Counter
from dataclasses import dataclass
from typing import BinaryIO, Dict, List, Optional, Tuple

from .qutrit_delta import NUM_DIMENSIONS, QutritDelta, QutritState
from .quantum_dust import QuantumDustField


# ------------------------------------------------------------------
# Dictionary Encoding (L1)
# ------------------------------------------------------------------

class SymbolicDictionary:
    """Adaptive dictionary for recurring tokens/anchors."""

    def __init__(self, min_freq: int = 3):
        self.min_freq = min_freq
        self._token_to_id: Dict[str, int] = {}
        self._id_to_token: Dict[int, str] = {}
        self._next_id = 1  # 0 reserved for unknown

    def train(self, tokens: List[str]) -> None:
        """Build dictionary from token frequency counts."""
        counts = Counter(tokens)
        for token, count in counts.most_common():
            if count < self.min_freq:
                break
            if token not in self._token_to_id:
                self._token_to_id[token] = self._next_id
                self._id_to_token[self._next_id] = token
                self._next_id += 1

    def encode(self, token: str) -> int:
        return self._token_to_id.get(token, 0)

    def decode(self, token_id: int) -> str:
        return self._id_to_token.get(token_id, f"?{token_id}")

    def to_bytes(self) -> bytes:
        """Serialize dictionary as: [count:2] then [id:2][len:1][token]."""
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
        sd = cls()
        for _ in range(count):
            tid, tlen = struct.unpack_from(">HB", data, offset)
            offset += 3
            token = data[offset:offset + tlen].decode("utf-8")
            offset += tlen
            sd._token_to_id[token] = tid
            sd._id_to_token[tid] = token
            sd._next_id = max(sd._next_id, tid + 1)
        return sd


# ------------------------------------------------------------------
# Sparse CSR Encoding (L2)
# ------------------------------------------------------------------

@dataclass
class CSRBlock:
    """One sparse block: index + raw bytes."""
    block_index: int
    data: bytes


def encode_sparse(
    data: bytes,
    default_value: int = 0,
    block_size: int = 256,
) -> Tuple[bytes, bytes]:
    """Encode data as sparse blocks. Returns (meta_bytes, compressed_blocks)."""
    blocks: List[CSRBlock] = []
    for i in range(0, len(data), block_size):
        chunk = data[i:i + block_size]
        if any(b != default_value for b in chunk):
            blocks.append(CSRBlock(i // block_size, chunk))

    # Meta: original_length, block_size, default_value, num_blocks
    meta = struct.pack(">III", len(data), block_size, default_value)
    meta += struct.pack(">I", len(blocks))

    # Block data: [index:4][len:2][data] per block
    buf = io.BytesIO()
    for b in blocks:
        buf.write(struct.pack(">IH", b.block_index, len(b.data)))
        buf.write(b.data)

    compressed = zlib.compress(buf.getvalue(), level=3)
    return meta, compressed


def decode_sparse(meta: bytes, compressed: bytes) -> bytes:
    """Decode sparse blocks back to raw data."""
    orig_len, block_size, default_val = struct.unpack_from(">III", meta, 0)
    num_blocks = struct.unpack_from(">I", meta, 12)[0]

    raw = zlib.decompress(compressed)
    output = bytearray([default_val] * orig_len)

    offset = 0
    for _ in range(num_blocks):
        idx, blen = struct.unpack_from(">IH", raw, offset)
        offset += 6
        block_data = raw[offset:offset + blen]
        offset += blen
        start = idx * block_size
        end = min(start + blen, orig_len)
        output[start:end] = block_data[:end - start]

    return bytes(output)


# ------------------------------------------------------------------
# Low-Rank Baseline Approximation (L3)
# ------------------------------------------------------------------

@dataclass
class LowRankBaseline:
    """Approximate baseline as a low-rank matrix for coarse-grid positions.

    For classical computers, we approximate the 3^12 space by sampling
    a coarse grid (e.g., every N positions) and storing only the non-default
    samples. This is effectively a manual low-rank approximation.
    """
    grid_step: int  # Sample every N positions
    default_state: List[QutritState]
    samples: Dict[int, List[QutritState]]  # Sparse samples


def build_low_rank_baseline(
    field: QuantumDustField,
    grid_step: int = 27,  # 3^3, coarse but meaningful
) -> LowRankBaseline:
    """Sample the baseline at coarse grid points."""
    default = [QutritState(0, 0) for _ in range(NUM_DIMENSIONS)]
    samples: Dict[int, List[QutritState]] = {}

    for pos in sorted(field.baseline.keys()):
        if pos % grid_step == 0:
            samples[pos] = field.baseline[pos]

    return LowRankBaseline(
        grid_step=grid_step,
        default_state=default,
        samples=samples,
    )


# ------------------------------------------------------------------
# Full Hybrid Pipeline
# ------------------------------------------------------------------

@dataclass
class CompressionResult:
    original_bytes: int
    compressed_bytes: int
    ratio: float
    dictionary_size: int
    baseline_positions: int
    active_deltas: int
    dust_percentage: float
    # v0.7: convergence metadata
    convergence_levels: int = 0
    positions_collapsed: int = 0
    clusters_promoted: int = 0
    threshold_final: float = 0.0


class ClassicalCompressor:
    """End-to-end classical compression for symbolic data."""

    def __init__(self, block_size: int = 512):
        self.block_size = block_size
        self.dictionary = SymbolicDictionary()

    def compress_text(self, text: str) -> Tuple[bytes, CompressionResult]:
        """Compress plain text using hybrid classical pipeline.

        ⚠️  LOSSY / NON-INVERTIBLE — analysis only, no decoder (see the
        sibling `csf_symbolic_compressor` module header). The tokenizer drops
        digits/whitespace/most punctuation, so the original cannot be rebuilt;
        the returned ratio is not a real compression ratio.

        Strategy for normal text (where CSF is not expected to beat ZIP):
          1. Tokenize into words + punctuation.
          2. Dictionary-encode frequent tokens.
          3. Represent as token-ID stream.
          4. Sparse-encode the token stream (many repeats = sparse).
          5. zlib/DEFLATE (level 3) final pass.  [NOT zstd]

        For symbolic text with anchors, the dictionary step captures
        recurring concepts and the sparse step handles the static structure.
        """
        # Step 1: Simple tokenization
        tokens = _tokenize(text)

        # Step 2: Build dictionary
        self.dictionary.train(tokens)

        # Step 3: Encode to token IDs
        ids = [self.dictionary.encode(t) for t in tokens]
        id_bytes = _pack_varints(ids)

        # Step 4: Sparse encoding (text often has repeated/default patterns)
        meta, sparse_compressed = encode_sparse(
            id_bytes, default_value=0, block_size=self.block_size
        )

        # Step 5: Assemble and final zstd
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

        result = CompressionResult(
            original_bytes=original,
            compressed_bytes=compressed,
            ratio=ratio,
            dictionary_size=len(self.dictionary._token_to_id),
            baseline_positions=0,
            active_deltas=len(tokens),
            dust_percentage=0.0,
        )
        return final, result

    def compress_field(self, field: QuantumDustField) -> Tuple[bytes, CompressionResult]:
        """Compress a QuantumDustField using the full v0.7 pipeline.

        v0.7: Uses multi-level convergence with cluster promotion for
        aggressive baseline collapse before encoding.
        """
        from .convergence_engine import multi_level_convergence

        # Step 1: Multi-level convergence (coarse → fine)
        # v0.7: run convergence on the field directly, leveraging the
        # built-in delta deduplication and cached get_state.
        convergence_results = multi_level_convergence(
            field,
            levels=[0.24, 0.14, 0.08, 0.05],
            promote_clusters=True,
        )
        total_collapsed = sum(r.collapsed for r in convergence_results)
        total_promoted = sum(r.clusters_promoted for r in convergence_results)
        final_threshold = (
            convergence_results[-1].threshold_used
            if convergence_results else field.convergence_threshold
        )

        # Step 2: Compact any zero deltas left after convergence
        field.compact()

        # Step 3: Baseline as low-rank approximation
        low_rank = build_low_rank_baseline(field)

        # Step 4: Encode active deltas
        delta_buf = io.BytesIO()
        delta_buf.write(struct.pack(">I", len(field.active_deltas)))
        for pos, deltas in sorted(field.active_deltas.items()):
            from .qutrit_delta import pack_delta_list
            delta_buf.write(struct.pack(">I", pos))
            delta_buf.write(pack_delta_list(deltas))

        # Step 5: Encode low-rank baseline samples
        base_buf = io.BytesIO()
        base_buf.write(struct.pack(">I", low_rank.grid_step))
        base_buf.write(struct.pack(">I", len(low_rank.samples)))
        for pos, states in sorted(low_rank.samples.items()):
            base_buf.write(struct.pack(">I", pos))
            for s in states:
                base_buf.write(struct.pack(">BB", s.amplitude, s.phase))

        # Step 6: Sparse + Zstd
        meta, sparse_data = encode_sparse(
            delta_buf.getvalue(), default_value=0, block_size=self.block_size
        )

        body = io.BytesIO()
        body.write(base_buf.getvalue())
        body.write(meta)
        body.write(sparse_data)

        final = zlib.compress(body.getvalue(), level=3)

        original = field.total_positions * NUM_DIMENSIONS * 2  # Rough: 2 bytes per qutrit
        compressed = len(final)
        ratio = 1.0 - (compressed / original) if original else 0.0

        result = CompressionResult(
            original_bytes=original,
            compressed_bytes=compressed,
            ratio=ratio,
            dictionary_size=0,
            baseline_positions=len(field.baseline),
            active_deltas=sum(len(d) for d in field.active_deltas.values()),
            dust_percentage=field.dust_percentage,
            # v0.7 metadata
            convergence_levels=len(convergence_results),
            positions_collapsed=total_collapsed,
            clusters_promoted=total_promoted,
            threshold_final=final_threshold,
        )
        return final, result


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _tokenize(text: str) -> List[str]:
    """Simple whitespace + punctuation tokenizer."""
    import re
    return re.findall(r"[\w']+|[.,;!?—\-]", text)


def _pack_varints(values: List[int]) -> bytes:
    """Pack a list of non-negative ints as LEB128 varints."""
    buf = bytearray()
    for v in values:
        while v >= 128:
            buf.append((v & 0x7F) | 0x80)
            v >>= 7
        buf.append(v)
    return bytes(buf)


def _unpack_varints(data: bytes) -> List[int]:
    """Unpack LEB128 varints."""
    values = []
    i = 0
    while i < len(data):
        v = 0
        shift = 0
        while True:
            b = data[i]
            i += 1
            v |= (b & 0x7F) << shift
            if not (b & 0x80):
                break
            shift += 7
        values.append(v)
    return values
