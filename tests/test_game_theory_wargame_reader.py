from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_game_theory_wargame_reader_records_sources_hashes_and_page_count() -> None:
    text = read("manifests/evidence/game-theory-wargame-reader-2026-05-29.md")
    required = [
        "OsborneRubinsteinMasterpiece.pdf",
        "Prajit-K.-Dutta-Strategies-and-Games_-Theory-and-Practice-The-MIT-Press-1999.pdf",
        "Complete-Wargames-Handbook-Dunnigan.pdf",
        "AD1038115.pdf",
        "martin_j-_osborne-an_introduction_to_game_theory-oxford_university_press_usa2003.pdf",
        "70733E532FFBCD7A010F5C9FC041DDB07EAB56F9CAACD860E2AD4578FCCD22C8",
        "9FC8B1618747F3579F0959CB35D938352B29E65273576753C092C0474B9A9AE6",
        "49624486B7B26DF25BDE8C1BF362118B798B24081FF4C30B35FFD4E5DBF0C78E",
        "2B4D7BF6EE3B208A5E3A302E2B287259F018805DE55B58D7C7EB6D4B433B4204",
        "D5C9774E7D45F971CB2E20D90004F8A2A0DA95A5DBB93227B7D58092D6DD2A0D",
        "Total local source pages: 1758",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []


def test_game_theory_wargame_reader_keeps_rights_and_trade_boundaries() -> None:
    text = read("manifests/evidence/game-theory-wargame-reader-2026-05-29.md")
    required = [
        "summary-only",
        "does not copy book text",
        "game_theory_strategy_reference",
        "wargame_simulation_reference",
        "hft_spread_game_model_reference",
        "live trading edge exists",
        "autonomous HFT should execute without human approval",
        "operational military guidance",
        "Build a small paper-trading simulator",
    ]
    missing = [phrase for phrase in required if phrase not in text]
    assert missing == []
