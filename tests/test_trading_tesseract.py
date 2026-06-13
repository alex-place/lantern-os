"""
TradingTesseract tests (Trading Phase 4, issue #325).

Covers:
  - All 5 dimension classifiers in isolation
  - Confidence computation
  - Action derivation rules
  - Full evaluate() contract
  - evaluate_watchlist() sorting + output shape
  - Edge cases: empty inputs, missing keys, unknown dimension values
"""

from __future__ import annotations

import sys
import importlib
from pathlib import Path
import pytest

# Make src/trading_agents importable without installing agents.py deps
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "trading_agents"))

# Import the module under test directly (no agents.py dependency)
import importlib.util
_spec = importlib.util.spec_from_file_location(
    "trading_tesseract",
    Path(__file__).resolve().parents[1] / "src" / "trading_agents" / "trading_tesseract.py",
)
tt_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tt_mod)

TradingTesseract       = tt_mod.TradingTesseract
_classify_time         = tt_mod._classify_time
_classify_market       = tt_mod._classify_market
_classify_signal       = tt_mod._classify_signal
_classify_layer        = tt_mod._classify_layer
_classify_asset_state  = tt_mod._classify_asset_state
_compute_confidence    = tt_mod._compute_confidence
_derive_action         = tt_mod._derive_action
TIME_DIMS              = tt_mod.TIME_DIMS
MARKET_DIMS            = tt_mod.MARKET_DIMS
SIGNAL_DIMS            = tt_mod.SIGNAL_DIMS
LAYER_DIMS             = tt_mod.LAYER_DIMS
ASSET_DIMS             = tt_mod.ASSET_DIMS


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

MARKET_OPEN   = {"market_open": True,  "vix_regime": "CALM",     "spy_day_change_pct": 1.2}
MARKET_BEAR   = {"market_open": True,  "vix_regime": "HIGH",     "spy_day_change_pct": -1.5}
MARKET_CLOSED = {"market_open": False, "vix_regime": "CALM",     "spy_day_change_pct": 0.0}

ZONES_AAPL = {
    "AAPL": {
        "mid": 185.0,
        "top": 187.0,
        "bottom": 183.0,
        "timestamp": "2026-06-13T09:00:00Z",
    }
}

AGENT_LOG_STRONG = [
    {"symbol": "AAPL", "strength": "strong", "agent": "claude", "confidence": 0.9},
]
AGENT_LOG_WEAK = [
    {"symbol": "AAPL", "strength": "weak", "agent": "scanner", "confidence": 0.2},
]
AGENT_LOG_OTHER = [
    {"symbol": "TSLA", "strength": "strong", "agent": "riley"},
]

POSITIONS_HELD  = [{"symbol": "AAPL", "qty": 50}]
POSITIONS_EMPTY = []


# ---------------------------------------------------------------------------
# Dimension: time
# ---------------------------------------------------------------------------

class TestClassifyTime:
    def test_market_closed_returns_eod(self):
        assert _classify_time({}, MARKET_CLOSED) == "eod"

    def test_fresh_data_realtime(self):
        from datetime import datetime, timezone, timedelta
        ts = (datetime.now(timezone.utc) - timedelta(seconds=20)).isoformat()
        zones = {"timestamp": ts}
        assert _classify_time(zones, MARKET_OPEN) == "realtime"

    def test_stale_data_intraday(self):
        from datetime import datetime, timezone, timedelta
        ts = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
        zones = {"timestamp": ts}
        assert _classify_time(zones, MARKET_OPEN) == "intraday"

    def test_very_stale_returns_session(self):
        from datetime import datetime, timezone, timedelta
        ts = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
        zones = {"timestamp": ts}
        assert _classify_time(zones, MARKET_OPEN) == "session"

    def test_no_timestamp_defaults_intraday_when_open(self):
        assert _classify_time({}, MARKET_OPEN) == "intraday"

    def test_result_always_in_valid_set(self):
        for ms in (MARKET_OPEN, MARKET_CLOSED, MARKET_BEAR):
            assert _classify_time({}, ms) in TIME_DIMS


# ---------------------------------------------------------------------------
# Dimension: market
# ---------------------------------------------------------------------------

class TestClassifyMarket:
    def test_high_vix_returns_volatile(self):
        assert _classify_market(MARKET_BEAR) == "volatile"

    def test_strong_spy_up_returns_bullish(self):
        assert _classify_market(MARKET_OPEN) == "bullish"

    def test_strong_spy_down_returns_bearish(self):
        ms = {"vix_regime": "CALM", "spy_day_change_pct": -1.2}
        assert _classify_market(ms) == "bearish"

    def test_flat_spy_calm_vix_returns_calm(self):
        ms = {"vix_regime": "CALM", "spy_day_change_pct": 0.1}
        assert _classify_market(ms) == "calm"

    def test_flat_spy_elevated_vix_returns_neutral(self):
        ms = {"vix_regime": "ELEVATED", "spy_day_change_pct": 0.3}
        assert _classify_market(ms) == "neutral"

    def test_extreme_vix_returns_volatile(self):
        ms = {"vix_regime": "EXTREME", "spy_day_change_pct": 2.0}
        assert _classify_market(ms) == "volatile"

    def test_result_always_in_valid_set(self):
        for ms in (MARKET_OPEN, MARKET_BEAR, MARKET_CLOSED):
            assert _classify_market(ms) in MARKET_DIMS


# ---------------------------------------------------------------------------
# Dimension: signal
# ---------------------------------------------------------------------------

class TestClassifySignal:
    def test_agent_log_strong(self):
        assert _classify_signal("AAPL", ZONES_AAPL, AGENT_LOG_STRONG) == "strong"

    def test_agent_log_weak(self):
        assert _classify_signal("AAPL", ZONES_AAPL, AGENT_LOG_WEAK) == "weak"

    def test_no_matching_log_falls_back_to_zone_spread(self):
        # AAPL zones: spread 4/185 ~2.2% → moderate
        result = _classify_signal("AAPL", ZONES_AAPL, [])
        assert result in ("moderate", "weak")

    def test_wrong_symbol_in_log_ignored(self):
        result = _classify_signal("AAPL", ZONES_AAPL, AGENT_LOG_OTHER)
        assert result in SIGNAL_DIMS

    def test_missing_zones_and_no_log_returns_weak_or_invalid(self):
        result = _classify_signal("AAPL", {}, [])
        assert result in ("invalid", "weak")

    def test_case_insensitive_symbol_match(self):
        log = [{"symbol": "aapl", "strength": "strong", "agent": "claude"}]
        assert _classify_signal("AAPL", {}, log) == "strong"

    def test_result_always_in_valid_set(self):
        for log in ([], AGENT_LOG_STRONG, AGENT_LOG_WEAK, AGENT_LOG_OTHER):
            assert _classify_signal("AAPL", ZONES_AAPL, log) in SIGNAL_DIMS


# ---------------------------------------------------------------------------
# Dimension: layer
# ---------------------------------------------------------------------------

class TestClassifyLayer:
    def test_claude_layer_detected(self):
        assert _classify_layer(AGENT_LOG_STRONG, "AAPL") == "claude"

    def test_riley_layer_detected(self):
        log = [{"symbol": "AAPL", "agent": "riley"}]
        assert _classify_layer(log, "AAPL") == "riley"

    def test_scanner_is_default_when_no_log(self):
        assert _classify_layer([], "AAPL") == "scanner"

    def test_wrong_asset_returns_scanner(self):
        assert _classify_layer(AGENT_LOG_OTHER, "AAPL") == "scanner"

    def test_result_always_in_valid_set(self):
        for log in ([], AGENT_LOG_STRONG, AGENT_LOG_WEAK):
            assert _classify_layer(log, "AAPL") in LAYER_DIMS


# ---------------------------------------------------------------------------
# Dimension: asset_state
# ---------------------------------------------------------------------------

class TestClassifyAssetState:
    def test_held_position_returns_in_trade(self):
        ms = {**MARKET_OPEN, "positions": POSITIONS_HELD}
        assert _classify_asset_state("AAPL", ms) == "in_trade"

    def test_zero_qty_returns_closed(self):
        ms = {**MARKET_OPEN, "positions": [{"symbol": "AAPL", "qty": 0}]}
        assert _classify_asset_state("AAPL", ms) == "closed"

    def test_no_position_returns_watching(self):
        ms = {**MARKET_OPEN, "positions": POSITIONS_EMPTY}
        assert _classify_asset_state("AAPL", ms) == "watching"

    def test_no_positions_key_returns_watching(self):
        assert _classify_asset_state("AAPL", MARKET_OPEN) == "watching"

    def test_result_always_in_valid_set(self):
        for ms in (MARKET_OPEN, {**MARKET_OPEN, "positions": POSITIONS_HELD}):
            assert _classify_asset_state("AAPL", ms) in ASSET_DIMS


# ---------------------------------------------------------------------------
# Confidence + action
# ---------------------------------------------------------------------------

class TestConfidenceAndAction:
    def test_all_best_dims_gives_high_confidence(self):
        cube = {"time": "realtime", "market": "bullish",
                "signal": "strong", "layer": "claude", "asset_state": "in_trade"}
        c = _compute_confidence(cube)
        assert c >= 0.85

    def test_all_worst_dims_gives_low_confidence(self):
        cube = {"time": "eod", "market": "bearish",
                "signal": "invalid", "layer": "execution", "asset_state": "rejected"}
        c = _compute_confidence(cube)
        assert c <= 0.25

    def test_confidence_in_range(self):
        cube = {"time": "intraday", "market": "neutral",
                "signal": "moderate", "layer": "scanner", "asset_state": "watching"}
        c = _compute_confidence(cube)
        assert 0.0 <= c <= 1.0

    def test_invalid_signal_forces_skip(self):
        cube = {"time": "realtime", "market": "bullish",
                "signal": "invalid", "layer": "claude", "asset_state": "watching"}
        assert _derive_action(0.9, cube) == "skip"

    def test_high_confidence_bullish_returns_buy(self):
        cube = {"time": "realtime", "market": "bullish",
                "signal": "strong", "layer": "claude", "asset_state": "watching"}
        assert _derive_action(0.75, cube) == "buy"

    def test_volatile_low_confidence_returns_hold(self):
        cube = {"time": "intraday", "market": "volatile",
                "signal": "weak", "layer": "scanner", "asset_state": "watching"}
        assert _derive_action(0.40, cube) in ("hold", "skip")

    def test_closed_state_forces_skip(self):
        cube = {"time": "realtime", "market": "bullish",
                "signal": "strong", "layer": "claude", "asset_state": "closed"}
        assert _derive_action(0.90, cube) == "skip"


# ---------------------------------------------------------------------------
# Full TradingTesseract.evaluate()
# ---------------------------------------------------------------------------

class TestTradingTesseractEvaluate:
    def setup_method(self):
        self.tt = TradingTesseract()

    def test_returns_all_required_keys(self):
        result = self.tt.evaluate("AAPL", ZONES_AAPL, MARKET_OPEN, AGENT_LOG_STRONG)
        assert set(result.keys()) >= {"asset", "cube", "confidence", "action", "evaluated_at"}

    def test_asset_is_uppercased(self):
        result = self.tt.evaluate("aapl", {}, {}, [])
        assert result["asset"] == "AAPL"

    def test_cube_has_all_five_dims(self):
        result = self.tt.evaluate("AAPL", ZONES_AAPL, MARKET_OPEN, AGENT_LOG_STRONG)
        cube = result["cube"]
        assert set(cube.keys()) == {"time", "market", "signal", "layer", "asset_state"}

    def test_cube_values_are_valid(self):
        result = self.tt.evaluate("AAPL", ZONES_AAPL, MARKET_OPEN, AGENT_LOG_STRONG)
        c = result["cube"]
        assert c["time"]        in TIME_DIMS
        assert c["market"]      in MARKET_DIMS
        assert c["signal"]      in SIGNAL_DIMS
        assert c["layer"]       in LAYER_DIMS
        assert c["asset_state"] in ASSET_DIMS

    def test_confidence_is_float_in_range(self):
        result = self.tt.evaluate("AAPL", ZONES_AAPL, MARKET_OPEN, AGENT_LOG_STRONG)
        assert isinstance(result["confidence"], float)
        assert 0.0 <= result["confidence"] <= 1.0

    def test_action_is_valid(self):
        result = self.tt.evaluate("AAPL", ZONES_AAPL, MARKET_OPEN, AGENT_LOG_STRONG)
        assert result["action"] in ("buy", "watch", "hold", "skip")

    def test_empty_inputs_still_returns_valid_result(self):
        result = self.tt.evaluate("MSFT", None, None, None)
        assert result["asset"] == "MSFT"
        assert result["action"] in ("buy", "watch", "hold", "skip")

    def test_bearish_market_biases_toward_non_buy(self):
        ms = {**MARKET_BEAR, "spy_day_change_pct": -2.0}
        result = self.tt.evaluate("AAPL", {}, ms, AGENT_LOG_WEAK)
        # In a very bearish volatile market with weak signal, should not be buy
        assert result["action"] != "buy"


# ---------------------------------------------------------------------------
# evaluate_watchlist()
# ---------------------------------------------------------------------------

class TestEvaluateWatchlist:
    def setup_method(self):
        self.tt = TradingTesseract()

    def test_returns_list_of_correct_length(self):
        watchlist = ["AAPL", "TSLA", "SPY"]
        results = self.tt.evaluate_watchlist(watchlist, {}, MARKET_OPEN, [])
        assert len(results) == 3

    def test_sorted_by_confidence_descending(self):
        watchlist = ["AAPL", "TSLA", "SPY", "NVDA"]
        results = self.tt.evaluate_watchlist(watchlist, {}, MARKET_OPEN, [])
        confidences = [r["confidence"] for r in results]
        assert confidences == sorted(confidences, reverse=True)

    def test_all_assets_present(self):
        watchlist = ["AAPL", "TSLA"]
        results = self.tt.evaluate_watchlist(watchlist, {}, MARKET_OPEN, [])
        symbols = {r["asset"] for r in results}
        assert symbols == {"AAPL", "TSLA"}

    def test_empty_watchlist_returns_empty_list(self):
        results = self.tt.evaluate_watchlist([], {}, {}, [])
        assert results == []

    def test_each_result_has_full_schema(self):
        results = self.tt.evaluate_watchlist(["SPY"], ZONES_AAPL, MARKET_OPEN, [])
        assert len(results) == 1
        assert set(results[0].keys()) >= {"asset", "cube", "confidence", "action", "evaluated_at"}