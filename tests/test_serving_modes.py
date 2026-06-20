"""Regression tests for serving modes (#729 / PR #723).

Pins the FAST-mode product default and its anti-repetition decode params so a
future change cannot silently regress them. The live-ops half of #729 (restart
servers, monitor latency, watch for token loops across providers) cannot be
exercised by a unit test — this locks the *code contract* those ops depend on.
"""
import importlib

serving_modes = importlib.import_module("serving_modes")


def test_fast_is_default(monkeypatch):
    """No OURO_NATIVE → fast mode (the product default)."""
    monkeypatch.delenv("OURO_NATIVE", raising=False)
    assert serving_modes.get_serving_mode().name == "fast"


def test_deep_when_ouro_native(monkeypatch):
    """OURO_NATIVE in {1,true,yes} → deep mode."""
    for v in ("1", "true", "yes", "TRUE"):
        monkeypatch.setenv("OURO_NATIVE", v)
        assert serving_modes.get_serving_mode().name == "deep", f"OURO_NATIVE={v}"


def test_fast_decode_params():
    """FAST mode anti-repetition params are exactly the documented values."""
    p = serving_modes.get_decode_params(serving_modes.FAST_MODE)
    assert p["top_p"] == 0.95
    assert p["frequency_penalty"] == 0.5
    assert p["repetition_penalty"] == 1.1
    assert p["repeat_last_n"] == 64


def test_deep_decode_params():
    """DEEP mode uses gentler anti-repetition (adaptive loop needs some repetition)."""
    p = serving_modes.get_decode_params(serving_modes.DEEP_MODE)
    assert p["top_p"] == 0.98
    assert p["frequency_penalty"] == 0.2


def test_both_modes_enable_antirepetition():
    assert serving_modes.FAST_MODE.decode_antirepetition is True
    assert serving_modes.DEEP_MODE.decode_antirepetition is True
    assert serving_modes.FAST_MODE.max_latency_ms == 2000
    assert serving_modes.DEEP_MODE.max_latency_ms == 120000


# ── dilation-gated serving mode (within→without bridge, #764/#731) ──────────────

def test_serving_mode_for_none_is_env_default(monkeypatch):
    monkeypatch.delenv("OURO_NATIVE", raising=False)
    assert serving_modes.serving_mode_for(None).name == "fast"


def test_serving_mode_for_low_dilation_stays_fast(monkeypatch):
    monkeypatch.delenv("OURO_NATIVE", raising=False)
    assert serving_modes.serving_mode_for(0.5).name == "fast"
    assert serving_modes.serving_mode_for(1.0).name == "fast"
    assert serving_modes.serving_mode_for(2.0).name == "fast"   # deep only at D>=3


def test_serving_mode_for_high_dilation_escalates_to_deep(monkeypatch):
    monkeypatch.delenv("OURO_NATIVE", raising=False)
    assert serving_modes.serving_mode_for(3.0).name == "deep"
    assert serving_modes.serving_mode_for(5.0).name == "deep"


def test_serving_mode_for_ouro_native_forces_deep(monkeypatch):
    monkeypatch.setenv("OURO_NATIVE", "1")
    assert serving_modes.serving_mode_for(0.1).name == "deep"
    assert serving_modes.serving_mode_for(None).name == "deep"
