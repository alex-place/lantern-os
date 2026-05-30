from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_public_bounty_radar_ranks_public_sources_and_boundaries() -> None:
    text = read("manifests/evidence/public-puzzle-math-bounty-radar-2026-05-30.md")
    required = [
        "ARC Prize 2026 overview",
        "https://arcprize.org/competitions/2026",
        "https://arcprize.org/competitions/2026/arc-agi-3",
        "https://arcprize.org/competitions/2026/arc-agi-2",
        "https://arcprize.org/competitions/2026/paper",
        "https://www.claymath.org/millennium-problems/",
        "https://www.jointmathematicsmeetings.org/prizes-awards/paview.cgi?parent_id=41",
        "https://www.codabench.org/competitions/16161/",
        "ARC-AGI-3 interactive agent",
        "Build the ARC-AGI-3/ARC Paper Prize starter lane first",
        "No claim is made that Lantern can win any bounty today",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []
