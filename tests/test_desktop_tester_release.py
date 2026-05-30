from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_desktop_tester_doc_answers_download_request() -> None:
    text = read("docs/LANTERN-DESKTOP-TESTER.md")
    required = [
        "You got something for me to download and test?",
        "https://github.com/alex-place/lantern-os/releases/latest",
        "Lantern-OS-Free-Setup.exe",
        "Lantern-OS-Founder-20-Setup.exe",
        "https://ko-fi.com/alexplace",
        "artifacts/lantern-desktop-tester-latest.zip",
        "Node.js 20 or newer",
        ".\\Start-LanternDesktopTester.ps1",
        "http://127.0.0.1:4177",
        "not equity, not securities, not a token",
        "game-theory-wargame-reader-2026-05-29.md",
        "custom HFT/spread simulation",
        "Old static pages such as Tony Garage, Shareholder Index, Agent Fleet, and",
        "Do not enter secrets",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []


def test_desktop_tester_package_script_excludes_secrets_and_builds_zip() -> None:
    text = read("scripts/New-LanternDesktopTesterPackage.ps1")
    required = [
        "lantern-desktop-tester-latest.zip",
        "https://github.com/alex-place/lantern-os/releases/latest",
        "Lantern-OS-Free-Setup.exe",
        "Lantern-OS-Founder-20-Setup.exe",
        "Start-LanternDesktopTester.ps1",
        "docs\\wiki\\WINDOWS-TESTER-INSTALL.md",
        "Node.js 20+ is required",
        "Compress-Archive",
        "excludes secrets",
        "node_modules",
        "credentials",
        "conversation logs",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []


def test_dashboard_links_desktop_tester_doc_and_zip() -> None:
    html = read("apps/lantern-garage/public/index.html")
    required = [
        "Desktop Tester",
        "/view?path=docs/LANTERN-DESKTOP-TESTER.md",
        "/repo/artifacts/lantern-desktop-tester-latest.zip",
        "Download ZIP",
    ]
    missing = [phrase for phrase in required if phrase not in html]
    assert missing == []


def test_windows_tester_wiki_has_free_paid_and_release_boundaries() -> None:
    text = read("docs/wiki/WINDOWS-TESTER-INSTALL.md")
    required = [
        "https://github.com/alex-place/lantern-os/releases/latest",
        "Lantern-OS-Free-Setup.exe",
        "Lantern-OS-Founder-20-Setup.exe",
        "lantern-desktop-tester-latest.zip",
        "https://ko-fi.com/alexplace",
        "not equity, not",
        "game-theory/wargame card",
        "What Not To Enter",
        "AWS keys",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []


def test_readme_points_gage_to_release_and_wiki() -> None:
    text = read("README.md")
    required = [
        "https://github.com/alex-place/lantern-os/releases/latest",
        "Lantern-OS-Free-Setup.exe",
        "Lantern-OS-Founder-20-Setup.exe",
        "docs/wiki/WINDOWS-TESTER-INSTALL.md",
        "Do not claim an `.exe` is",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []
