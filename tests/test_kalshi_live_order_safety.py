from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_live_order_script_defaults_to_dry_run_with_explicit_live_flag() -> None:
    text = read("scripts/Invoke-KalshiLiveOrder.ps1")
    # Live is an opt-in switch; the dry-run branch must short-circuit before any POST.
    assert "[switch]$Live" in text
    assert "if (-not $Live) {" in text
    assert "DRY RUN: no request sent" in text


def test_live_order_script_enforces_kill_switch_and_risk_caps() -> None:
    text = read("scripts/Invoke-KalshiLiveOrder.ps1")
    for token in [
        "Test-KillSwitch",
        "KALSHI_KILL_SWITCH",
        "LIVE-KILL-SWITCH",
        "per_order_cap_exceeded",
        "daily_trade_count_reached",
        "daily_risk_cap_exceeded",
        "LIVE ORDER BLOCKED by safety gates",
    ]:
        assert token in text, token


def test_live_order_script_reads_credentials_from_env_not_repo() -> None:
    text = read("scripts/Invoke-KalshiLiveOrder.ps1")
    assert "KALSHI_API_KEY_ID" in text
    assert "KALSHI_PRIVATE_KEY" in text
    # Defaults to the safer demo environment.
    assert '[string]$Environment = "demo"' in text


def test_kill_switch_ships_armed() -> None:
    kill = ROOT / "data" / "kalshi" / "LIVE-KILL-SWITCH"
    assert kill.exists(), "LIVE-KILL-SWITCH must ship present (live trading disarmed by default)"


def test_live_ledger_and_receipts_are_gitignored() -> None:
    gitignore = read(".gitignore")
    assert "data/kalshi/kalshi-live-ledger.jsonl" in gitignore
    assert "kalshi-live-order-receipt-" in gitignore
