import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_paper_trade_ticket_script_blocks_live_execution() -> None:
    text = read("scripts/New-KalshiPaperTradeTickets.ps1")
    required = [
        "Live trading is blocked",
        "paper_only_requires_human_approval",
        "authenticated_trading_blocked_pre_v1",
        "independent_probability_missing",
        "fee_and_slippage_model_missing",
        "$candidateRows = @($watchlist) + @($hftQueue)",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []


def test_kalshi_trade_gate_records_authenticated_order_boundary() -> None:
    text = read("manifests/evidence/kalshi-api-docs-and-trade-gate-2026-05-29.md")
    required = [
        "3de0d78d-c02d-4a14-9368-75f5c762d4c1",
        "e6fcc338-7e5e-4e4f-8f9a-a8d1c65357ff",
        "32f6f40a-81ac-444b-b60d-89af58358822",
        "9dfa1a44-9b07-4909-a3b5-aa1004067374",
        "Authenticated requests require API key id, timestamp, and RSA-PSS signature",
        "live authenticated orders from chat",
        "paper-trade tickets for human review",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []


def test_paper_trade_ticket_json_is_review_queue_only() -> None:
    data = json.loads(read("data/kalshi/kalshi-paper-trade-tickets-latest.json"))
    assert data["schema"] == "lantern.kalshi.paper_trade_tickets.v1"
    assert data["liveTradingStatus"] == "blocked"
    assert data["ticketCount"] <= 8
    assert "No authenticated Kalshi request" in data["boundary"]
    for ticket in data["tickets"]:
        assert ticket["action"] == "paper_buy_limit"
        assert ticket["status"] == "paper_only_requires_human_approval"
        assert ticket["visibleActivityUsd"] >= 5.0
        assert ticket["outcomeConfidence"] == "not_estimated"
        assert "human_approval_missing" in ticket["blockers"]
