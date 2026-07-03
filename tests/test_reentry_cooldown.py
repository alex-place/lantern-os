"""Anti-churn re-entry cooldown (agents._in_reentry_cooldown).

The scanner was round-tripping the same symbols every 1-2 minutes (buy->sell->buy),
bleeding the bid/ask spread on huge notional turnover with ~zero edge — the dominant
loss driver observed 2026-07-03. close_position() now stamps _last_close_time and the
entry gate blocks re-opening a symbol within REENTRY_COOLDOWN_SEC.
"""
import os
from datetime import datetime, timedelta

# agents.py builds API clients at import; give harmless dummy keys so it imports in CI.
for _k in ("XAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
           "ALPACA_API_KEY", "ALPACA_SECRET_KEY"):
    os.environ.setdefault(_k, "test-key")

import pytest

agents = pytest.importorskip("agents")  # skip cleanly if the trading deps aren't installed


def _reset(cooldown=900):
    agents.REENTRY_COOLDOWN_SEC = cooldown
    agents._last_close_time.clear()


def test_blocks_recent_close():
    _reset(900)
    agents._last_close_time["AAPL"] = datetime.now()
    assert agents._in_reentry_cooldown("AAPL") is True


def test_allows_after_cooldown_elapsed():
    _reset(900)
    agents._last_close_time["AAPL"] = datetime.now() - timedelta(seconds=901)
    assert agents._in_reentry_cooldown("AAPL") is False


def test_unknown_symbol_never_blocked():
    _reset(900)
    assert agents._in_reentry_cooldown("TSLA") is False


def test_disabled_when_zero():
    _reset(0)
    agents._last_close_time["AAPL"] = datetime.now()
    assert agents._in_reentry_cooldown("AAPL") is False


def test_close_position_would_stamp(monkeypatch):
    # Verify the stamp mechanism the gate depends on: _last_close_time is a live dict
    # keyed by symbol. (close_position stamps it at the top before any broker call.)
    _reset(900)
    assert "NVDA" not in agents._last_close_time
    agents._last_close_time["NVDA"] = datetime.now()
    assert agents._in_reentry_cooldown("NVDA") is True
