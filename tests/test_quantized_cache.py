"""Regression tests for the int8 KV cache (sigma0.quantized_cache.QuantizedUTCache).

Pure-CPU, model-free: exercises quant round-trip accuracy + the UniversalTransformerCache
drop-in interface (update returns dequantized full slot, cats along seq, tracks seq length).

Run:  python -m pytest tests/test_quantized_cache.py -q
  or: python tests/test_quantized_cache.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

import pytest  # noqa: E402

pytest.importorskip("torch")
import torch  # noqa: E402

from sigma0.quantized_cache import QuantizedUTCache, _quantize, _dequantize  # noqa: E402


def test_quant_roundtrip_near_lossless():
    """int8 + per-token scale must round-trip within ~1/127 relative error per row."""
    x = torch.randn(1, 4, 32, 64)
    q, s = _quantize(x)
    xr = _dequantize(q, s, x.dtype)
    assert q.dtype == torch.int8, "must store int8"
    rel = ((x - xr).abs().max() / x.abs().max()).item()
    assert rel < 0.02, f"int8 round-trip rel error too high: {rel}"


def test_update_stores_int8_returns_dequantized():
    """update() stores int8 internally but returns a same-shape dequantized slot for attention."""
    c = QuantizedUTCache()
    k = torch.randn(1, 4, 5, 16)
    v = torch.randn(1, 4, 5, 16)
    rk, rv = c.update(k, v, layer_idx=0)
    assert c.key_cache[0].dtype == torch.int8 and c.value_cache[0].dtype == torch.int8
    assert rk.shape == k.shape and rv.shape == v.shape
    assert rk.dtype == k.dtype, "returned slot must match input dtype (for attention)"
    assert ((k - rk).abs().mean() / k.abs().mean()).item() < 0.02


def test_update_concatenates_along_seq_and_tracks_length():
    c = QuantizedUTCache()
    c.update(torch.randn(1, 4, 5, 16), torch.randn(1, 4, 5, 16), 0)
    assert c.get_seq_length(0) == 5
    rk, _ = c.update(torch.randn(1, 4, 1, 16), torch.randn(1, 4, 1, 16), 0)  # decode step
    assert rk.shape[2] == 6 and c.get_seq_length(0) == 6
    assert c.get_mask_sizes(torch.zeros(1), 0)[0] == 7  # seq(6) + query(1)


def test_slots_are_independent():
    """Distinct UT*layer slots accumulate independently (the flat-slot model)."""
    c = QuantizedUTCache()
    for slot in range(3):
        c.update(torch.randn(1, 4, 5, 16), torch.randn(1, 4, 5, 16), slot)
    assert len(c.key_cache) == 3 and all(c.get_seq_length(s) == 5 for s in range(3))


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn(); print(f"PASS {fn.__name__}")
        except AssertionError as e:
            failed += 1; print(f"FAIL {fn.__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)
