from pathlib import Path


def test_mind_body_spirit_video_report_is_off_hold_with_publication_gates():
    report = Path('archive/reports-2026-06-04/MIND-BODY-SPIRIT-SHINE-VIDEO-CONVERGENCE.md')
    text = report.read_text(encoding='utf-8')

    required_phrases = [
        'Status: validated candidate',
        'Move the video/report work off hold',
        'Publication Gate',
        'captions',
        'three-flashes-per-second',
        'no request for comments, names, photos, location, account signup, or personal data',
        'rollback',
    ]

    missing = [phrase for phrase in required_phrases if phrase not in text]
    assert missing == []


def test_mind_body_spirit_video_report_does_not_claim_public_release_ready():
    report = Path('archive/reports-2026-06-04/MIND-BODY-SPIRIT-SHINE-VIDEO-CONVERGENCE.md')
    text = report.read_text(encoding='utf-8').lower()

    forbidden_claims = [
        'status: held',
        'status: public-release ready',
        'status: v1.0.0 ready',
    ]

    present = [phrase for phrase in forbidden_claims if phrase in text]
    assert present == []
