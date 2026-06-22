"""Int8-quantized KV cache for Ouro's looped (Universal-Transformer) attention.

Ouro's KV cache is ~4x a normal model's at a given length — it caches K/V at every UT loop
step (no sharing) and uses full MHA (no GQA). At 20k tokens that's ~15.4 GB in fp16, which
OOMs an 8GB card. This subclass stores each cache slot as **int8 + a per-token scale**
(symmetric, per (batch, head, token) row over head_dim) and **dequantizes one slot at a time**
on read, so the persistent cache is ~2x smaller while only one slot's fp16 view is ever
materialized (~0.3 GB transient at 20k, vs the full 7.7 GB). This is CSF's ternary/low-bit
*substrate* (BitNet b1.58 lineage) applied at the live-tensor layer, where a byte-archive
compressor (CSF-Omni) cannot run.

int8 symmetric quant is near-lossless for attention K/V (KIVI; LLM.int8); set OURO_KV_INT8=1
to use it. Drop-in: pass an instance as ``past_key_values`` — same interface as
``UniversalTransformerCache``.
"""
from __future__ import annotations

from typing import Optional

import torch


def _quantize(x: torch.Tensor):
    """Per-(batch,head,token) symmetric int8 quant over the head_dim axis.
    x: [B, H, S, D] float -> (int8 q [B,H,S,D], scale [B,H,S,1] in x.dtype)."""
    scale = x.abs().amax(dim=-1, keepdim=True) / 127.0
    scale = scale.clamp(min=1e-8)
    q = torch.round(x / scale).clamp(-127, 127).to(torch.int8)
    return q, scale.to(x.dtype)


def _dequantize(q: torch.Tensor, scale: torch.Tensor, dtype: torch.dtype) -> torch.Tensor:
    return (q.to(dtype) * scale)


class QuantizedUTCache:
    """int8 drop-in for UniversalTransformerCache. Stores int8 + scales per slot; returns
    dequantized fp16/bf16 on update so attention is unchanged."""

    def __init__(self, max_cache_size: Optional[int] = None):
        self.key_cache: list[Optional[torch.Tensor]] = []     # int8 [B,H,S,D]
        self.value_cache: list[Optional[torch.Tensor]] = []
        self.key_scale: list[Optional[torch.Tensor]] = []     # [B,H,S,1]
        self.value_scale: list[Optional[torch.Tensor]] = []
        self.layers: list = []          # HF Cache utilities expect this attribute
        self._seen_tokens = 0
        self.max_cache_size = max_cache_size

    def update(self, key_states, value_states, layer_idx, cache_kwargs=None):
        if layer_idx < 0:
            raise ValueError(f"layer_idx must be non-negative, got {layer_idx}")
        if self.max_cache_size is not None and layer_idx >= self.max_cache_size:
            raise IndexError(
                f"Cache index {layer_idx} exceeds max_cache_size={self.max_cache_size}.")
        while len(self.key_cache) <= layer_idx:
            for lst in (self.key_cache, self.value_cache, self.key_scale, self.value_scale):
                lst.append(None)

        dtype = key_states.dtype
        qk, sk = _quantize(key_states)
        qv, sv = _quantize(value_states)

        if self.key_cache[layer_idx] is None:
            self.key_cache[layer_idx], self.key_scale[layer_idx] = qk, sk
            self.value_cache[layer_idx], self.value_scale[layer_idx] = qv, sv
        else:
            self.key_cache[layer_idx] = torch.cat([self.key_cache[layer_idx], qk], dim=2)
            self.key_scale[layer_idx] = torch.cat([self.key_scale[layer_idx], sk], dim=2)
            self.value_cache[layer_idx] = torch.cat([self.value_cache[layer_idx], qv], dim=2)
            self.value_scale[layer_idx] = torch.cat([self.value_scale[layer_idx], sv], dim=2)

        self._seen_tokens = self.key_cache[layer_idx].shape[2]
        # dequantize ONLY this slot (one transient fp16 view) for attention
        result_key = _dequantize(self.key_cache[layer_idx], self.key_scale[layer_idx], dtype)
        result_value = _dequantize(self.value_cache[layer_idx], self.value_scale[layer_idx], dtype)
        return result_key, result_value

    def get_seq_length(self, layer_idx: Optional[int] = 0) -> int:
        if layer_idx is None:
            layer_idx = 0
        if layer_idx < 0 or len(self.key_cache) <= layer_idx or self.key_cache[layer_idx] is None:
            return 0
        return self.key_cache[layer_idx].shape[2]

    def get_mask_sizes(self, cache_position, layer_idx: int = 0):
        return self.get_seq_length(layer_idx) + cache_position.shape[0], 0

    def get_max_length(self):
        return None

    def get_usable_length(self, new_seq_length, layer_idx: Optional[int] = 0) -> int:
        return self.get_seq_length(layer_idx)

    def reorder_cache(self, beam_idx) -> None:
        for lst in (self.key_cache, self.value_cache, self.key_scale, self.value_scale):
            for i, e in enumerate(lst):
                if e is not None:
                    lst[i] = e.index_select(0, beam_idx.to(e.device))

    @property
    def is_compileable(self) -> bool:
        return False

    def clear(self) -> None:
        for lst in (self.key_cache, self.value_cache, self.key_scale, self.value_scale):
            lst.clear()
        self._seen_tokens = 0
