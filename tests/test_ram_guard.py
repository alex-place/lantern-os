"""RAM preflight guard for Ouro loads (#781 follow-up).

Guards Sigma0LoopLM.load() and ouro_serve.py so a model load fails fast with a clear
message instead of OOM-freezing the 12 GB dev box when evals/agents race.
"""
import os

import pytest

from sigma0.ram_guard import available_ram_gb, require_free_ram, SKIP_ENV, MIN_ENV


def test_available_ram_positive():
    gb = available_ram_gb()
    # On any real machine this must be a positive, sane number (or None if truly unknown).
    assert gb is None or gb > 0


def test_passes_when_threshold_trivial():
    # Effectively no requirement → returns the measured GB, never raises.
    out = require_free_ram(min_gb=0.0, what="test")
    assert out is None or out >= 0


def test_blocks_when_threshold_impossible(monkeypatch):
    monkeypatch.delenv(SKIP_ENV, raising=False)
    monkeypatch.delenv(MIN_ENV, raising=False)
    with pytest.raises(MemoryError) as ei:
        require_free_ram(min_gb=10_000_000.0, what="Ouro model 'x'")
    msg = str(ei.value)
    assert "Refusing to load" in msg and SKIP_ENV in msg  # message tells the user how to override


def test_skip_env_bypasses(monkeypatch):
    monkeypatch.setenv(SKIP_ENV, "1")
    # Even an impossible threshold must NOT raise when the bypass is set.
    require_free_ram(min_gb=10_000_000.0, what="x")


def test_min_env_overrides_threshold(monkeypatch):
    monkeypatch.delenv(SKIP_ENV, raising=False)
    monkeypatch.setenv(MIN_ENV, "10000000")
    with pytest.raises(MemoryError):
        require_free_ram(min_gb=0.0, what="x")  # arg is low, but env floor is impossible


def test_unknown_ram_does_not_block(monkeypatch):
    # If RAM can't be measured, the guard is a no-op (never block on unknown state).
    monkeypatch.delenv(SKIP_ENV, raising=False)
    monkeypatch.delenv(MIN_ENV, raising=False)
    monkeypatch.setattr("sigma0.ram_guard.available_ram_gb", lambda: None)
    assert require_free_ram(min_gb=10_000_000.0, what="x") is None
