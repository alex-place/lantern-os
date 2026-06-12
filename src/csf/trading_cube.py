"""
TradingCube — 5-dimension Market Tesseract (Trading Phase 4, issue #325)

Evaluates each watchlist asset along five dimensions and produces a
confidence + action recommendation for the dashboard's Signal Panel.

Dimensions:
  time        realtime | intraday | session | eod
  market      bullish | bearish | neutral | volatile | calm
  signal      weak | moderate | strong | invalid
  layer       scanner | riley | mft | risk | claude | execution
  asset_state watching | active | in_trade | closed | rejected

NOTE: This is a SEPARATE module from src/csf/status_cube.py, which backs
the live Three Doors game. Do not import or extend StatusCube here.
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


# ── Dimension classifiers ────────────────────────────────────────────────────

def _classify_time(market_status: dict) -> str:
    """Classify the current time dimension from market_status."""
    if not market_status:
        return "eod"
    if market_status.get("pre_market"):
        return "realtime"
    if market_status.get("market_open") or market_status.get("is_open"):
        hour = time.localtime().tm_hour
        return "realtime" if hour < 10 else "intraday" if hour < 15 else "session"
    return "eod"


def _classify_market(market_status: dict) -> str:
    """Derive broad market regime from market_status."""
    if not market_status:
        return "neutral"
    vix = float(market_status.get("vix", 0) or 0)
    spy_trend = str(market_status.get("spy_trend", "")).lower()
    if vix >= 30:
        return "volatile"
    if vix <= 14:
        if "bull" in spy_trend or spy_trend == "up":
            return "bullish"
        if "bear" in spy_trend or spy_trend == "down":
            return "bearish"
        return "calm"
    if "bull" in spy_trend or spy_trend == "up":
        return "bullish"
    if "bear" in spy_trend or spy_trend == "down":
        return "bearish"
    return "neutral"


def _classify_signal(zones_data: dict, asset: str, agent_log: list) -> str:
    """Derive signal strength for a specific asset from zones and agent log."""
    asset_upper = asset.upper()

    # Count recent strong signals from agent log
    strong = 0
    moderate = 0
    for entry in (agent_log or []):
        body = str(entry.get("body", "") or entry.get("action", "") or "").lower()
        sym = str(entry.get("symbol", "") or "").upper()
        if sym and sym != asset_upper:
            continue
        if any(w in body for w in ("breakout", "confirmed", "strong", "buy", "sell")):
            strong += 1
        elif any(w in body for w in ("signal", "watch", "moderate", "spike")):
            moderate += 1

    if strong >= 2:
        return "strong"
    if strong >= 1 or moderate >= 2:
        return "moderate"
    if moderate >= 1:
        return "weak"

    # Fall back to zone proximity
    asset_zones = (zones_data or {}).get(asset_upper, {})
    if asset_zones:
        return "moderate"
    return "weak"


def _classify_layer(agent_log: list) -> str:
    """Identify which agent layer generated the most recent signal."""
    layer_order = ["execution", "claude", "risk", "mft", "riley", "scanner"]
    if not agent_log:
        return "scanner"
    # Most recent entry determines the active layer
    last = agent_log[-1] if agent_log else {}
    agent = str(last.get("agent", "") or last.get("type", "") or "").lower()
    for layer in layer_order:
        if layer in agent:
            return layer
    return "scanner"


def _classify_asset_state(asset: str, positions: list) -> str:
    """Determine asset_state from current positions."""
    asset_upper = asset.upper()
    for pos in (positions or []):
        sym = str(pos.get("symbol", "") or "").upper()
        if sym == asset_upper:
            qty = float(pos.get("qty", 0) or pos.get("quantity", 0) or 0)
            if qty > 0:
                return "in_trade"
            return "closed"
    return "watching"


# ── Confidence + action derivation ──────────────────────────────────────────

_SIGNAL_WEIGHT = {"strong": 0.4, "moderate": 0.2, "weak": 0.05, "invalid": 0.0}
_MARKET_WEIGHT = {"bullish": 0.3, "calm": 0.2, "neutral": 0.1, "volatile": 0.0, "bearish": -0.1}
_TIME_WEIGHT   = {"realtime": 0.2, "intraday": 0.15, "session": 0.1, "eod": 0.0}
_STATE_WEIGHT  = {"active": 0.1, "watching": 0.05, "in_trade": 0.0, "closed": 0.0, "rejected": -0.1}


def _derive_confidence(cube: dict) -> float:
    score = 0.1  # base
    score += _SIGNAL_WEIGHT.get(cube["signal"], 0)
    score += _MARKET_WEIGHT.get(cube["market"], 0)
    score += _TIME_WEIGHT.get(cube["time"], 0)
    score += _STATE_WEIGHT.get(cube["asset_state"], 0)
    return round(min(max(score, 0.0), 1.0), 3)


def _derive_action(cube: dict, confidence: float) -> str:
    if cube["asset_state"] == "rejected":
        return "skip"
    if cube["signal"] == "invalid" or cube["market"] == "volatile":
        return "hold"
    if confidence >= 0.7 and cube["signal"] == "strong":
        return "buy" if cube["market"] in ("bullish", "calm") else "sell"
    if confidence >= 0.5 and cube["signal"] in ("strong", "moderate"):
        return "watch"
    if cube["asset_state"] == "in_trade" and confidence < 0.3:
        return "review"
    return "hold"


# ── Public API ───────────────────────────────────────────────────────────────

@dataclass
class CubeResult:
    asset: str
    cube: Dict[str, str]
    confidence: float
    action: str
    evaluated_at: str = field(default_factory=lambda: __import__("datetime").datetime.utcnow().isoformat() + "Z")

    def to_dict(self) -> dict:
        return asdict(self)


def evaluate(
    asset: str,
    zones_data: Optional[dict] = None,
    market_status: Optional[dict] = None,
    agent_log: Optional[list] = None,
    positions: Optional[list] = None,
) -> CubeResult:
    """
    Evaluate a single asset through the 5-dimension Market Tesseract.

    Args:
        asset:         Ticker symbol, e.g. "SPY"
        zones_data:    Dict of {SYMBOL: {support:..., resistance:...}} from AI Trader
        market_status: Market status dict (vix, spy_trend, market_open, etc.)
        agent_log:     List of recent agent-log entries
        positions:     List of current position objects

    Returns:
        CubeResult with .cube (5 dims), .confidence (0–1), .action string
    """
    zones_data    = zones_data    or {}
    market_status = market_status or {}
    agent_log     = agent_log     or []
    positions     = positions     or []

    cube = {
        "time":        _classify_time(market_status),
        "market":      _classify_market(market_status),
        "signal":      _classify_signal(zones_data, asset, agent_log),
        "layer":       _classify_layer(agent_log),
        "asset_state": _classify_asset_state(asset, positions),
    }

    confidence = _derive_confidence(cube)
    action     = _derive_action(cube, confidence)

    return CubeResult(asset=asset.upper(), cube=cube, confidence=confidence, action=action)


def evaluate_watchlist(
    assets: list,
    zones_data: Optional[dict] = None,
    market_status: Optional[dict] = None,
    agent_log: Optional[list] = None,
    positions: Optional[list] = None,
) -> List[CubeResult]:
    """Evaluate every asset in the watchlist, sorted by confidence descending."""
    results = [
        evaluate(a, zones_data, market_status, agent_log, positions)
        for a in assets
    ]
    return sorted(results, key=lambda r: r.confidence, reverse=True)
