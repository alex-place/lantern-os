"""
Tests for scripts/ouro_compat.py — the Ouro transformers cache compatibility helpers.

Pure logic: no torch, no model load. scripts/ is added to sys.path because it is not on
pytest's `pythonpath` (apps src) and the helpers are co-located with their only consumer,
ouro_serve.py.

Two things under test:
  * transformers_cache_risk() — reports whether an Ouro model on a given transformers needs
    the cache patch (True for Ouro on >= 4.54, where Cache.key_cache became read-only).
  * patch_universal_transformer_cache() — makes an Ouro-style cache class's key_cache /
    value_cache settable again (verified against a fake read-only-property base, mirroring
    the real transformers>=4.54 situation).
"""
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from ouro_compat import (  # noqa: E402
    OURO_CACHE_FIX_PIN,
    parse_transformers_version,
    patch_universal_transformer_cache,
    transformers_cache_risk,
)


# ── version parsing ───────────────────────────────────────────────────────────

def test_parse_plain():
    assert parse_transformers_version("4.57.6") == (4, 57, 6)
    assert parse_transformers_version("4.55.0") == (4, 55, 0)


def test_parse_tolerant_of_suffixes():
    assert parse_transformers_version("4.56.0.dev0") == (4, 56, 0)
    assert parse_transformers_version("4.57.6+cu121") == (4, 57, 6)
    assert parse_transformers_version("4.54") == (4, 54, 0)  # short right-pads
    assert parse_transformers_version("4") == (4, 0, 0)


# ── cache-risk decision (threshold is 4.54, measured 2026-07-04) ──────────────

def test_ouro_on_current_env_is_at_risk():
    # This environment ships transformers 4.55/4.57 — the patch is required for an Ouro model.
    at_risk, msg = transformers_cache_risk("ByteDance/Ouro-1.4B-Thinking", "4.57.6")
    assert at_risk is True
    assert "patch_universal_transformer_cache" in msg
    assert "no setter" in msg or "read-only" in msg


def test_ouro_454_also_needs_patch():
    # The model card's "recommended ==4.54.1" does NOT avoid the read-only property — 4.54.1
    # is at_risk too (this was the correction: pinning does not fix it).
    assert transformers_cache_risk("ByteDance/Ouro-1.4B", "4.54.1")[0] is True
    assert transformers_cache_risk("ByteDance/Ouro-1.4B", "4.55.0")[0] is True


def test_boundary_is_inclusive_at_4_54_0():
    # 4.54.0 is the first at-risk version; 4.53.x is not (a different failure: missing imports).
    assert transformers_cache_risk("ByteDance/Ouro-1.4B", "4.54.0")[0] is True
    assert transformers_cache_risk("ByteDance/Ouro-1.4B", "4.53.9")[0] is False
    assert parse_transformers_version("4.54.0") == OURO_CACHE_FIX_PIN


def test_non_ouro_model_is_never_flagged():
    assert transformers_cache_risk("Qwen/Qwen2.5-Coder-7B-Instruct", "4.57.6")[0] is False
    assert transformers_cache_risk("meta-llama/Llama-3.2-3B", "5.0.0")[0] is False


def test_model_id_match_is_case_insensitive():
    assert transformers_cache_risk("some/OURO-Thing", "4.99.0")[0] is True


# ── the actual cache patch ────────────────────────────────────────────────────

def _fake_ouro_module():
    """A module holding an Ouro-style cache class whose base has read-only key_cache /
    value_cache properties — exactly the transformers>=4.54 situation."""
    class _ReadOnlyBase:
        @property
        def key_cache(self):
            return self.__dict__.get("_ro_k", [])

        @property
        def value_cache(self):
            return self.__dict__.get("_ro_v", [])

    class UniversalTransformerCache(_ReadOnlyBase):
        pass

    mod = types.ModuleType("transformers_modules.fake_rev.modeling_ouro")
    mod.UniversalTransformerCache = UniversalTransformerCache
    return mod


def test_patch_makes_key_cache_settable():
    mod = _fake_ouro_module()
    cls = mod.UniversalTransformerCache

    # Before patch: assignment to the inherited read-only property raises.
    with pytest.raises(AttributeError):
        cls().key_cache = []

    sys.modules[mod.__name__] = mod
    try:
        patched = patch_universal_transformer_cache()
        assert patched == mod.__name__

        # After patch: assignment works and round-trips (as Ouro's __init__ needs).
        inst = cls()
        inst.key_cache = [1, 2]
        inst.value_cache = [3]
        assert inst.key_cache == [1, 2]
        assert inst.value_cache == [3]
        inst.key_cache.append(4)  # Ouro's update() appends in place
        assert inst.key_cache == [1, 2, 4]

        # Idempotent: a second call is a no-op that still reports the class.
        assert patch_universal_transformer_cache() == mod.__name__
    finally:
        del sys.modules[mod.__name__]


def test_patch_returns_none_when_no_cache_class_loaded():
    # No UniversalTransformerCache in sys.modules -> nothing to patch.
    assert patch_universal_transformer_cache() is None
