from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_one_ide_doc_names_canonical_surfaces_and_hff_anchors() -> None:
    text = read("docs/LANTERN-ONE-IDE-WORKSTREAM-CONTROL.md")
    required = [
        "Lantern One IDE",
        "C:\\tmp\\lantern-os",
        "C:\\Users\\alexp\\Documents\\gm-agent-orchestrator",
        "C:\\Users\\alexp\\Documents\\agent-worktrees",
        "POST /api/command",
        "BETTER product lane",
        "Show the state. Say the limit. Self-correct before acting.",
        "A door is a protocol boundary",
        "observe -> record -> compare -> propose -> human approve -> apply -> verify -> repeat",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []


def test_one_ide_status_probe_is_read_only_and_checks_drift_surfaces() -> None:
    text = read("scripts/Get-OneIdeStatus.ps1")
    required = [
        "read_only_preflight",
        "git -C $Path status --short --branch",
        "config\\local-services.json",
        "manifests\\cloud-mirrors.json",
        "manifests\\validation\\MCP-CONNECTOR-LATEST.json",
        "dirtyCount = 0",
        "do_not_reset_clean_sync_or_dispatch_dirty_worktrees",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []

    blocked = ["git reset", "git clean", "start_agent", "sync_repository", "Move-Item"]
    present = [phrase for phrase in blocked if phrase in text]
    assert present == []


def test_one_ide_latest_receipt_records_hold_and_artifacts() -> None:
    text = read("manifests/ONE-IDE-STATUS-LATEST.md")
    required = [
        "Lantern One IDE Status Receipt",
        "read-only preflight",
        "MCP connector",
        "ready_tools_visible",
        "Hold mutation",
        "manifests/validation/ONE-IDE-STATUS-LATEST.json",
        "reports/KALSHI-KOFI-WATCHLIST-REVENUE-REPORT.md",
        "executable trade recommendations at 0",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []
