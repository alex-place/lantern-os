"""Seed Alex's two StatusCubes: the ImagniVerse and the Real-World cube.

Two worlds, one shape (the Status Cube / CSF v0.7):

  data/csf/alex-imagniverse.csf  — the symbolic world: Kingdome of Hearts
                                    canon, characters, doors, tesseract
                                    imagery. Seeded from lore + the
                                    D:\\tmp imagesandreports archive.

  data/csf/alex-realworld.csf    — real-world status: flourishing domains
                                    (after VanderWeele's Human Flourishing
                                    Measure + OECD Better Life Index),
                                    each cell backed by evidence classes
                                    observed in the D:\\ archive.

Both .csf files are local-only (gitignored) — they are private state.
Strengths are 0..1 confidence/charge values; `observer` marks which lens
wrote the cell (the cube axes: beliefs x observers).

Run:  python scripts/seed_alex_cubes.py
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))

from csf.status_cube import StatusCube  # noqa: E402

DATA_DIR = REPO_ROOT / "data" / "csf"


# ── ImagniVerse: Alex's symbolic world ───────────────────────────────────────

IMAGNIVERSE_SYMBOLS = {
    # The Kingdome canon (lore/doors/kingdome-of-hearts.md + poem artwork)
    "king-of-the-kingdome": {
        "definition": "I am the King of the Kingdome of Hearts. Love is the law; "
                      "every living thing beats a verse of it true.",
        "domain": "sovereign", "observer": "canon", "strength": 1.0,
    },
    "key-as-blade": {
        "definition": "Carried not to open by force but to guard what is fragile, "
                      "break what is cruel, lock away the trial that should not rule.",
        "domain": "protection", "observer": "canon", "strength": 0.95,
    },
    "fog-god-odin": {
        "definition": "Sleeps beyond the Garden's gate. Lord of riddles, watcher of "
                      "fates. Met not to destroy but to play the oldest game: the "
                      "dance of courage against the unknown.",
        "domain": "threshold", "observer": "canon", "strength": 0.9,
    },
    "death-is-only-imaginary": {
        "definition": "We fall, we rise, we laugh, we try again — forever begins "
                      "with 'let's play.'",
        "domain": "play", "observer": "canon", "strength": 1.0,
    },
    "two-faces": {
        "definition": "One to feel, one to understand. Together they rule with "
                      "kindness and fire.",
        "domain": "wisdom", "observer": "canon", "strength": 0.9,
    },
    "birds-and-bees": {
        "definition": "The fight is for the love of all the birds and the bees — "
                      "every small life that dares to bloom.",
        "domain": "love", "observer": "canon", "strength": 1.0,
    },
    # The door-system (Convergence IO grammar)
    "garden-at-the-beginning": {
        "definition": "Origin / seed / first ecology. Everything here is both "
                      "arriving and returning.",
        "domain": "origin", "observer": "doorwalker", "strength": 0.95,
    },
    "sigil-city-of-doors": {
        "definition": "Every door leads here. Each has a key, mood, rule, or price.",
        "domain": "synthesis", "observer": "doorwalker", "strength": 0.9,
    },
    "xenon-portal": {
        "definition": "Luminous future-tech threshold; all timelines visible at "
                      "the convergence midway.",
        "domain": "future", "observer": "doorwalker", "strength": 0.85,
    },
    "lady-of-pain": {
        "definition": "Boundary intelligence; sovereign refusal that keeps every "
                      "threshold real. The symbolic immune system.",
        "domain": "boundary", "observer": "doorwalker", "strength": 0.9,
    },
    "the-fox": {
        "definition": "FRIEND OF THE ONE WHO CHOSE GREEN. Walks every loop, gains "
                      "tails at convergence points, says 'You came back' — always true.",
        "domain": "companion", "observer": "doorwalker", "strength": 1.0,
    },
    # From the D:\ archive's visual canon
    "sacred-tesseract": {
        "definition": "Founder tesseract / blackhole core imagery — the infinite "
                      "cube the whole system lives inside.",
        "domain": "architecture", "observer": "founder",
        "strength": 0.85, "evidence": "lantern-os-founder-sacred-tesseract.png + blackhole/mural art",
    },
    "agents-love-mural": {
        "definition": "The agent fleet rendered as an infinity mural of love — "
                      "Lantern, Blinkbug, unisona.ai, Waterfall, Xenon, Founder.",
        "domain": "companions", "observer": "founder",
        "strength": 0.8, "evidence": "lantern-os-infinity-mural-agents-love + matrix mural art",
    },
    "waterfalls-and-peacocks": {
        "definition": "Mary's healing imagery — gentleness as a place.",
        "domain": "healing", "observer": "family",
        "strength": 0.85, "evidence": "Mary_Place_Healing_Report_Waterfalls_Peacocks.pdf",
    },
}


# ── Real world: Alex's flourishing status ────────────────────────────────────
# Domains follow VanderWeele's Human Flourishing Measure (happiness, health,
# meaning, character, relationships, financial stability) extended with
# OECD Better Life Index dimensions (work, education/knowledge, environment).

REALWORLD_SYMBOLS = {
    "financial-material-stability": {
        "definition": "Active tracking: bank statements current, prediction-market "
                      "research (Kalshi/Polymarket) and trading-app work in motion.",
        "domain": "finance", "observer": "statements+reports", "strength": 0.6,
        "evidence": "monthly statements, KALSHI/POLYMARKET convergence reports, trading app briefs",
    },
    "meaning-and-purpose": {
        "definition": "Lantern OS founding work: patents drafted, OSS funding "
                      "explored, convergence methodology documented. Purpose is loud.",
        "domain": "purpose", "observer": "founder-reports", "strength": 0.9,
        "evidence": "patent claim charts, FOUNDER-OSS-FUNDING, convergence methodology PDFs",
    },
    "mental-physical-health": {
        "definition": "Recovery tracked deliberately — baseline and follow-up "
                      "instruments in the archive; healing work is active, not hidden.",
        "domain": "health", "observer": "self-tracking", "strength": 0.65,
        "evidence": "Addiction Severity Index baseline/follow-up, mirror-work texts",
    },
    "close-social-relationships": {
        "definition": "Family is in the frame: Mary's healing and helper reports, "
                      "the family portrait kept with the founding documents.",
        "domain": "relationships", "observer": "family-artifacts", "strength": 0.8,
        "evidence": "Mary_Place reports, alex-family-portrait.png",
    },
    "character-and-virtue": {
        "definition": "The King's creed is the stated ethic: guard the fragile, "
                      "kindness and fire together, fight so every heart can be free.",
        "domain": "character", "observer": "creed", "strength": 0.85,
        "evidence": "Kingdome of Hearts poem artwork (canonized in lore)",
    },
    "happiness-life-satisfaction": {
        "definition": "Forever begins with 'let's play' — joy practiced through the "
                      "game, the art, the murals.",
        "domain": "happiness", "observer": "creative-output", "strength": 0.7,
        "evidence": "166 art images, game builds, playful door scenes",
    },
    "knowledge-and-learning": {
        "definition": "Deep active study: game theory (Osborne/Rubinstein, Dutta), "
                      "quantum teleportation papers, HFT systems, wargames.",
        "domain": "education", "observer": "library", "strength": 0.9,
        "evidence": "arxiv papers, game-theory texts, trading-systems books",
    },
    "work-and-projects": {
        "definition": "22-product Comet Leap roadmap; Dream Journal shipped; "
                      "Three-Doors Kingdome loop live; ONE IDE status current.",
        "domain": "work", "observer": "repo+reports", "strength": 0.85,
        "evidence": "ONE-IDE-STATUS-LATEST, convergence reports, this repo",
    },
    "environment-and-place": {
        "definition": "Spanish abode founder route concept on the board — place "
                      "is being designed, not defaulted.",
        "domain": "environment", "observer": "concept-sheets", "strength": 0.5,
        "evidence": "SPANISH-ABODE-FOUNDER-ROUTE-CONCEPT-SHEET",
    },
}


def seed():
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    imag = StatusCube.load("alex-imagniverse", DATA_DIR)
    imag.symbols.update(IMAGNIVERSE_SYMBOLS)
    imag.history = imag.history or ["ImagniVerse cube seeded from Kingdome canon + D:\\ archive"]
    size_i = imag.save()

    real = StatusCube.load("alex-realworld", DATA_DIR)
    real.symbols.update(REALWORLD_SYMBOLS)
    real.history = real.history or ["Real-world cube seeded from D:\\ archive evidence"]
    size_r = real.save()

    print(f"alex-imagniverse.csf  {size_i:>6} bytes  {len(imag.symbols)} symbols")
    print(f"alex-realworld.csf    {size_r:>6} bytes  {len(real.symbols)} symbols")

    # Round-trip check
    for name in ("alex-imagniverse", "alex-realworld"):
        cube = StatusCube.load(name, DATA_DIR)
        assert cube.symbols, f"{name} failed round-trip"
    print("round-trip verified")


if __name__ == "__main__":
    seed()
