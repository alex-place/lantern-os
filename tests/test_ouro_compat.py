"""
Tests for scripts/ouro_compat.py — the transformers>=4.56 Ouro cache-risk guard.

Pure logic: no torch, no transformers, no model load. scripts/ is added to sys.path
because it is not on pytest's `pythonpath` (apps src) and the helper is co-located with
its only consumer, ouro_serve.py.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from ouro_compat import (  # noqa: E402
    OURO_CACHE_FIX_PIN,
    parse_transformers_version,
    transformers_cache_risk,
)


def test_parse_plain():
    assert parse_transformers_version("4.57.6") == (4, 57, 6)
    assert parse_transformers_version("4.54.1") == (4, 54, 1)


def test_parse_tolerant_of_suffixes():
    assert parse_transformers_version("4.56.0.dev0") == (4, 56, 0)
    assert parse_transformers_version("4.57.6+cu121") == (4, 57, 6)
    assert parse_transformers_version("4.56") == (4, 56, 0)  # short right-pads
    assert parse_transformers_version("4") == (4, 0, 0)


def test_ouro_on_current_env_is_at_risk():
    # This environment ships transformers 4.57.6 — the guard MUST fire for an Ouro model.
    at_risk, msg = transformers_cache_risk("ByteDance/Ouro-1.4B-Thinking", "4.57.6")
    assert at_risk is True
    assert "ouro-cache-fix" in msg
    assert "OURO_STRICT_TRANSFORMERS" in msg


def test_ouro_on_pinned_version_is_safe():
    at_risk, msg = transformers_cache_risk("ByteDance/Ouro-1.4B", "4.54.1")
    assert at_risk is False
    assert msg == ""


def test_boundary_is_inclusive_at_4_56_0():
    # 4.56.0 is the first at-risk version; 4.55.x is safe.
    assert transformers_cache_risk("ByteDance/Ouro-1.4B", "4.56.0")[0] is True
    assert transformers_cache_risk("ByteDance/Ouro-1.4B", "4.55.9")[0] is False
    assert parse_transformers_version("4.56.0") == OURO_CACHE_FIX_PIN


def test_non_ouro_model_is_never_flagged():
    # The cache issue is Ouro-specific; a Qwen coder slot on new transformers is fine.
    assert transformers_cache_risk("Qwen/Qwen2.5-Coder-7B-Instruct", "4.57.6")[0] is False
    assert transformers_cache_risk("meta-llama/Llama-3.2-3B", "5.0.0")[0] is False


def test_model_id_match_is_case_insensitive():
    assert transformers_cache_risk("some/OURO-Thing", "4.99.0")[0] is True
