from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_issue_13_chat_shortcut_scripts_exist_and_validate_before_write() -> None:
    tester = read("scripts/Test-LanternChatEndpoint.ps1")
    creator = read("scripts/New-LanternChatShortcut.ps1")
    doc = read("docs/LANTERN-CHAT-BOOKMARK.md")

    required_tester = [
        "http://127.0.0.1:8787/chat",
        "http://127.0.0.1:8788/chat",
        "http://127.0.0.1:4177/",
        "remote_url_requires_AllowVerifiedRemote",
        "Lantern Cloud Chat",
        "Message Lantern OS",
        "conversationForm",
    ]
    assert [phrase for phrase in required_tester if phrase not in tester] == []

    required_creator = [
        "Test-LanternChatEndpoint.ps1",
        "No validated Lantern chat URL found",
        "Create or refresh Lantern chat shortcut",
        "shortcutPath",
        "targetUrl",
    ]
    assert [phrase for phrase in required_creator if phrase not in creator] == []

    assert "If no chat URL validates, no shortcut is created." in doc
    assert "does not require Windsurf" in doc


def test_execution_boundaries_allow_only_aws_and_kalshi_lanes_pre_v1() -> None:
    text = read("docs/EXECUTION-BOUNDARIES.md")
    required = [
        "AWS-safe deploy and operations checks",
        "Kalshi public-data research",
        "hidden miners",
        "autostart miners",
        "wallet custody",
        "authenticated Kalshi order placement",
        "automated trade execution",
        "Investor, stakeholder, or operator pressure does not bypass these gates",
        "pull public Kalshi market data without authentication",
        "inspect local health and AWS mirror state",
    ]
    assert [phrase for phrase in required if phrase not in text] == []


def test_readme_no_longer_names_render_as_cloud_mirror_branch() -> None:
    text = read("README.md")
    assert "deploy branch for the Render mirror" not in text
    assert "AWS/service mirrors live in `manifests/cloud-mirrors.json`" in text
    assert "docs/EXECUTION-BOUNDARIES.md" in text


def test_scripts_do_not_add_hidden_miner_or_trade_execution_paths() -> None:
    forbidden = [
        "xmrig.exe",
        "cpuminer",
        "cgminer",
        "eth_sendRawTransaction",
        "CreateService",
        "New-Service",
        "Register-ScheduledTask",
        "CreateOrder",
        "PlaceOrder",
    ]
    paths = [
        ROOT / "scripts" / "Test-LanternChatEndpoint.ps1",
        ROOT / "scripts" / "New-LanternChatShortcut.ps1",
        ROOT / "scripts" / "New-KalshiKofiRevenueReport.ps1",
        ROOT / "scripts" / "Test-MiningProfitability.ps1",
    ]
    combined = "\n".join(path.read_text(encoding="utf-8") for path in paths if path.exists())
    present = [phrase for phrase in forbidden if phrase in combined]
    assert present == []
