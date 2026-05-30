from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_convergence_loop_reports_source_git_failures_without_crashing() -> None:
    text = read("scripts/Invoke-LanternConvergenceLoop.ps1")
    required = [
        "$gitStatusError = $null",
        "safe.directory=$repo",
        "core.excludesFile=",
        "safe_directory_read_only_retry",
        "SOURCE-GIT-STATUS-FAILED",
        "git_status_failed",
        "Fix git safe-directory/ownership or inspect manually before source repo mutation.",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []
