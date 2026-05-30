import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_near_term_paper_block_script_blocks_live_and_filters_window() -> None:
    text = read("scripts/New-KalshiNearTermPaperBlock.ps1")
    required = [
        "[int]$WindowMinutes = 20",
        "[int]$MinLimitCents = 1",
        "Live trading is blocked from this script",
        "Get-SoonestFutureTime",
        "paper_buy_limit_maker",
        "near_term_paper_only_no_live_execution",
        "Only markets with a future known/expiry time inside the next window were eligible.",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []


def test_near_term_paper_block_json_is_paper_only() -> None:
    data = json.loads(read("data/kalshi/kalshi-near-term-paper-block-latest.json"))
    assert data["schema"] == "lantern.kalshi.near_term_paper_block.v1"
    assert data["windowMinutes"] == 20
    assert data["liveTradingStatus"] == "blocked"
    assert data["realMoneyUsd"] == 0
    assert data["budgetPolicy"]["liveSpendUsd"] == 0
    assert data["budgetPolicy"]["allocatedPaperRiskUsd"] <= data["budgetPolicy"]["maxDailyPaperLossUsd"]
    assert data["paperOrderCount"] <= 10
    for order in data["orders"]:
        assert order["action"] == "paper_buy_limit_maker"
        assert order["orderStatus"] == "paper_open_unfilled"
        assert order["liveOrderStatus"] == "not_submitted"
        assert order["realMoneyUsd"] == 0
        assert order["paperLimitCents"] >= 1
        assert order["paperMaxLossUsd"] >= 0.01
        assert order["minutesToKnown"] <= 20
        assert order["outcomeConfidence"] == "not_estimated"


def test_near_term_receipt_records_no_real_order() -> None:
    text = read("manifests/evidence/kalshi-near-term-paper-block-receipt-2026-05-30.md")
    required = [
        "Kalshi Near-Term Paper Block Receipt",
        "near-term paper block executed locally",
        "No authenticated Kalshi request was made",
        "No real order was submitted",
        "Window minutes",
        "Real money spent",
        "data/kalshi/kalshi-near-term-paper-block-latest.json",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []
