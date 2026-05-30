import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_kalshi_kofi_script_uses_public_data_and_no_execution_boundary() -> None:
    text = read("scripts/New-KalshiKofiRevenueReport.ps1")
    required = [
        "https://external-api.kalshi.com/trade-api/v2/markets?status=open",
        'homepage = "https://kalshi.com/"',
        "liquidity_spread_watchlist_v0",
        "[int]$MinMidCents = 20",
        "excludedBelowMinValueMarkets",
        "grossProfitRange",
        'outcomeConfidence = "not_estimated"',
        "actionableTradeCount = 0",
        "manualReviewBudgetUsd = 19",
        "No Kalshi order was placed",
        "no pooled capital",
        "https://ko-fi.com/alexplace",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []


def test_kalshi_kofi_report_has_watchlist_revenue_and_risk_boundaries() -> None:
    text = read("reports/KALSHI-KOFI-WATCHLIST-REVENUE-REPORT.md")
    required = [
        "Kalshi + Ko-fi Watchlist Revenue Report",
        "no trades executed",
        "Executable trade recommendations | 0",
        "`$19` Manual Review Gate",
        "not ready to make actionable trades",
        "Kalshi public homepage",
        "Right Now Answer",
        "Executable trades to make right now: **0**",
        "they do not prove edge",
        "Excluded below 20-cent midpoint",
        "Gross P/L",
        "Data Conf.",
        "Profit range is gross per contract",
        "Top Watchlist",
        "Ko-fi Revenue Lane",
        "No trade signals",
        "https://ko-fi.com/alexplace",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []


def test_kalshi_watchlist_json_is_bounded_snapshot() -> None:
    data = json.loads(read("data/kalshi/kalshi-watchlist-latest.json"))
    assert data["model"] == "liquidity_spread_watchlist_v0"
    assert data["totalOpenMarketsPulled"] > 0
    assert data["actionableTradeCount"] == 0
    assert data["watchlistCount"] <= 20
    assert data["tradeReadiness"] == "not_ready_for_actionable_trades_research_only"
    assert data["manualReviewBudgetUsd"] == 19
    assert data["minMidCents"] == 20
    assert data["excludedBelowMinValueMarkets"] >= 0
    assert "No authenticated trading" in data["boundary"]
    assert data["homepage"] == "https://kalshi.com/"
    assert data["koFi"] == "https://ko-fi.com/alexplace"
    for row in data["watchlist"]:
        assert row["yesMid"] >= 0.20
        assert row["grossProfitRange"]
        assert row["maxLossPerContract"] is not None
        assert row["grossProfitIfYes"] is not None
        assert row["dataConfidenceScore"] <= 70
        assert row["outcomeConfidence"] == "not_estimated"
