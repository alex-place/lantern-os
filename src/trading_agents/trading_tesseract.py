"""
TradingTesseract — 5-dimension asset evaluation engine (Trading Phase 4, issue #325).

Evaluates each watchlist asset across five dimensions and produces a
{ asset, cube, confidence, action } recommendation for the Signal Panel.

IMPORTANT: This is a NEW module. Do NOT confuse with src/csf/status_cube.py
which backs the Three Doors gameplay. Names are deliberately distinct.

Dimensions
----------
1. time         realtime / intraday / session / eod
2. market       bullish / bearish / neutral / volatile / calm
3. signal       strong / moderate / weak / invalid
4. layer        scanner / riley / mft / risk / claude / execution
5. asset_state  watching / active / in_trade / closed / rejected

Usage
-----
    from trading_tesseract import TradingTesseract
    tt = TradingTesseract()
    result = tt.evaluate("AAPL", zones_data, market_status, agent_log)
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Dimension value sets
# ---------------------------------------------------------------------------

TIME_DIMS     = ("realtime", "intraday", "session", "eod")
MARKET_DIMS   = ("bullish", "bearish", "neutral", "volatile", "calm")
SIGNAL_DIMS   = ("strong", "moderate", "weak", "invalid")
LAYER_DIMS    = ("scanner", "riley", "mft", "risk", "claude", "execution")
ASSET_DIMS    = ("watching", "active", "in_trade", "closed", "rejected")

# Confidence weights per dimension
_DIM_WEIGHTS = {
    "time":         0.10,
    "market":       0.30,
    "signal":       0.35,
    "layer":        0.10,
    "asset_state":  0.15,
}

# Per-value confidence contributions (0.0-1.0)
_SIGNAL_SCORES = {"strong": 1.0, "moderate": 0.6, "weak": 0.3, "invalid": 0.0}
_MARKET_SCORES = {"bullish": 1.0, "neutral": 0.5, "calm": 0.5,
                  "volatile": 0.35, "bearish": 0.1}
_STATE_SCORES  = {"watching": 0.5, "active": 0.8, "in_trade": 0.9,
                  "closed": 0.0, "rejected": 0.0}
_LAYER_SCORES  = {"claude": 1.0, "mft": 0.85, "riley": 0.75, "scanner": 0.6,
                  "risk": 0.5, "execution": 0.4}
_TIME_SCORES   = {"realtime": 1.0, "intraday": 0.8, "session": 0.6, "eod": 0.4}


# ---------------------------------------------------------------------------
# Dimension classifiers
# ---------------------------------------------------------------------------


def _classify_time(zones_data: dict, market_status: dict) -> str:
    """Infer time dimension from data recency and market-hours flag."""
    if market_status.get("market_open"):
        ts_str = zones_data.get("timestamp") or zones_data.get("updated_at")
        if ts_str:
            try:
                ts = datetime.fromisoformat(str(ts_str).replace("Z", "+00:00"))
                age_s = (datetime.now(timezone.utc) - ts).total_seconds()
                if age_s < 60:
                    return "realtime"
                if age_s < 3600:
                    return "intraday"
                return "session"
            except (ValueError, TypeError):
                pass
        return "intraday"
    return "eod"


def _classify_market(market_status: dict) -> str:
    """Derive market regime from VIX regime + SPY trend."""
    vix_regime = str(market_status.get("vix_regime", "")).upper()
    if vix_regime in ("HIGH", "EXTREME"):
        return "volatile"
    spy_change = float(market_status.get("spy_day_change_pct", 0.0) or 0.0)
    if spy_change > 0.8:
        return "bullish"
    if spy_change < -0.8:
        return "bearish"
    if vix_regime == "CALM":
        return "calm"
    return "neutral"


def _classify_signal(asset: str, zones_data: dict, agent_log_entries: list) -> str:
    """Grade the latest agent signal for this asset."""
    # Check agent-log for a recent entry for this asset
    for entry in reversed(agent_log_entries[-50:]):
        sym = entry.get("symbol") or entry.get("asset") or entry.get("ticker") or ""
        if sym.upper() == asset.upper():
            strength = str(entry.get("signal_strength") or entry.get("strength") or "").lower()
            if strength in SIGNAL_DIMS:
                return strength
            # Infer from score/confidence
            score = float(entry.get("score") or entry.get("confidence") or 0.0)
            if score >= 0.75:
                return "strong"
            if score >= 0.45:
                return "moderate"
            if score > 0.0:
                return "weak"

    # Fall back to zone density
    asset_zones = zones_data.get(asset, {}) if isinstance(zones_data, dict) else {}
    if not asset_zones:
        return "invalid"
    top = float(asset_zones.get("top") or asset_zones.get("resistance") or 0.0)
    bot = float(asset_zones.get("bottom") or asset_zones.get("support") or 0.0)
    mid = float(asset_zones.get("mid") or asset_zones.get("entry_price") or 0.0)
    if top > 0 and bot > 0 and mid > 0:
        spread_pct = (top - bot) / mid if mid else 0.0
        if spread_pct < 0.02:
            return "strong"
        if spread_pct < 0.05:
            return "moderate"
        return "weak"
    return "weak"


def _classify_layer(agent_log_entries: list, asset: str) -> str:
    """Identify which agent layer produced the most recent signal for this asset."""
    for entry in reversed(agent_log_entries[-50:]):
        sym = entry.get("symbol") or entry.get("asset") or entry.get("ticker") or ""
        if sym.upper() == asset.upper():
            agent = str(entry.get("agent") or entry.get("layer") or "").lower()
            if agent in LAYER_DIMS:
                return agent
            if "claude" in agent:
                return "claude"
            if "mft" in agent or "multi" in agent:
                return "mft"
            if "riley" in agent:
                return "riley"
            if "risk" in agent:
                return "risk"
            if "execut" in agent:
                return "execution"
    return "scanner"


def _classify_asset_state(asset: str, market_status: dict) -> str:
    """Infer asset state from portfolio positions."""
    positions = market_status.get("positions") or []
    for pos in positions:
        sym = pos.get("symbol") or pos.get("ticker") or ""
        if sym.upper() == asset.upper():
            qty = float(pos.get("qty") or pos.get("quantity") or 0.0)
            return "in_trade" if qty != 0 else "closed"
    return "watching"


# ---------------------------------------------------------------------------
# Confidence & action derivation
# ---------------------------------------------------------------------------


def _compute_confidence(cube: dict[str, str]) -> float:
    """Weighted average of per-dimension scores."""
    scores = {
        "signal":      _SIGNAL_SCORES.get(cube["signal"], 0.0),
        "market":      _MARKET_SCORES.get(cube["market"], 0.5),
        "asset_state": _STATE_SCORES.get(cube["asset_state"], 0.0),
        "layer":       _LAYER_SCORES.get(cube["layer"], 0.5),
        "time":        _TIME_SCORES.get(cube["time"], 0.5),
    }
    total = sum(_DIM_WEIGHTS[k] * v for k, v in scores.items())
    return round(min(1.0, max(0.0, total)), 4)


def _derive_action(confidence: float, cube: dict[str, str]) -> str:
    """
    Map (confidence, cube state) to a recommended action.
    Rules are intentionally conservative — this is a rule-set, not ML.
    """
    if cube["signal"] == "invalid":
        return "skip"
    if cube["asset_state"] in ("closed", "rejected"):
        return "skip"
    if cube["market"] == "volatile" and confidence < 0.55:
        return "hold"
    if confidence >= 0.72 and cube["market"] in ("bullish", "neutral", "calm"):
        return "buy"
    if confidence >= 0.55:
        return "watch"
    if cube["market"] == "bearish" and cube["signal"] in ("weak", "invalid"):
        return "skip"
    return "hold"


# ---------------------------------------------------------------------------
# TradingTesseract
# ---------------------------------------------------------------------------


class TradingTesseract:
    """
    Evaluates a single asset across 5 dimensions and returns a structured
    recommendation.  Thread-safe: no shared mutable state between calls.
    """

    def evaluate(
        self,
        asset: str,
        zones_data: dict | None,
        market_status: dict | None,
        agent_log_entries: list | None,
    ) -> dict[str, Any]:
        """
        Parameters
        ----------
        asset             : ticker symbol, e.g. "AAPL"
        zones_data        : output of scan_market / get_zones (dict keyed by symbol)
        market_status     : output of get_market_status
        agent_log_entries : list of agent-log records (most recent last)

        Returns
        -------
        {
          asset: str,
          cube: { time, market, signal, layer, asset_state },
          confidence: float (0-1),
          action: "buy" | "watch" | "hold" | "skip",
          evaluated_at: ISO timestamp,
        }
        """
        zones_data        = zones_data or {}
        market_status     = market_status or {}
        agent_log_entries = agent_log_entries or []

        cube = {
            "time":        _classify_time(zones_data, market_status),
            "market":      _classify_market(market_status),
            "signal":      _classify_signal(asset, zones_data, agent_log_entries),
            "layer":       _classify_layer(agent_log_entries, asset),
            "asset_state": _classify_asset_state(asset, market_status),
        }

        confidence = _compute_confidence(cube)
        action     = _derive_action(confidence, cube)

        return {
            "asset":        asset.upper(),
            "cube":         cube,
            "confidence":   confidence,
            "action":       action,
            "evaluated_at": datetime.now(timezone.utc).isoformat(),
        }

    def evaluate_watchlist(
        self,
        watchlist: list[str],
        zones_data: dict | None,
        market_status: dict | None,
        agent_log_entries: list | None,
    ) -> list[dict]:
        """Evaluate all assets in a watchlist and return sorted by confidence desc."""
        results = [
            self.evaluate(asset, zones_data, market_status, agent_log_entries)
            for asset in watchlist
        ]
        return sorted(results, key=lambda r: r["confidence"], reverse=True)