from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_local_server_has_one_command_entrypoint() -> None:
    text = read("apps/lantern-garage/server.js")
    required = [
        "const commandSpecs = {",
        '"!one"',
        '"!converge"',
        '"!superjarvis"',
        '"!near20"',
        'entrypoint: "/api/command"',
        "scripts/Get-OneIdeStatus.ps1",
        "scripts/Invoke-LanternConvergenceLoop.ps1",
        "scripts/Invoke-SuperJarvisPerfectLoop.ps1",
        "scripts/New-KalshiNearTermPaperBlock.ps1",
        'args: ["-Passes", "1"]',
        'args: ["-WindowMinutes", "20", "-BudgetUsd", "50", "-MaxOrders", "10"]',
        'url.pathname === "/api/command" && req.method === "POST"',
        'runLanternCommand("!converge")',
        'url.pathname === "/api/actions/kalshi-near-term-paper-block"',
        "paperBlock: payload ?",
        "allocatedPaperRiskUsd",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []


def test_cloud_mirror_holds_local_commands() -> None:
    text = read("apps/lantern-garage/cloud-server.js")
    required = [
        'url.pathname === "/api/command" && req.method === "POST"',
        "aws-read-only",
        "local_command_held_on_aws_cloud",
        "AWS cloud mode will not run PowerShell or local MCP",
        "Open http://127.0.0.1:4177/",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []


def test_dashboard_uses_command_chips_and_endpoint() -> None:
    text = read("apps/lantern-garage/public/app.js")
    required = [
        '{ label: "!one", text: "!one" }',
        '{ label: "!converge", text: "!converge" }',
        '{ label: "!superjarvis", text: "!superjarvis" }',
        "async function postCommand(command, label = command)",
        'api("/api/command"',
        'postCommand("!converge", "Loop")',
        "nearTermKalshiBlock",
        "kalshiBlockList",
        "function renderKalshiBlock(result)",
        "/api/actions/kalshi-near-term-paper-block",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []


def test_command_entrypoint_doc_has_token_policy() -> None:
    text = read("docs/LANTERN-COMMAND-ENTRYPOINT.md")
    required = [
        "POST /api/command",
        "`!one`",
        "`!converge`",
        "`!superjarvis`",
        "Token Discipline",
        "prompt caching",
        "input-token cost",
        "direct invoice service",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []
