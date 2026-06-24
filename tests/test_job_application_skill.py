"""
Tests for the job_application skill — #1098

Run: python -m pytest tests/test_job_application_skill.py -q --tb=short
"""
import pytest

from skills.job_application.job_application import (
    analyze_job_posting,
    tailor_highlights,
    build_application_summary,
    JobPostingAnalysis,
    TailoringResult,
)

SAMPLE_POSTING = """
Senior Software Engineer at Acme Corp

We are looking for a Senior Software Engineer to join our fast-paced startup.

Responsibilities:
- Design and build scalable backend services using Python and Node.js
- Collaborate with the frontend team on REST APIs
- Mentor junior engineers

Required:
- 3+ years Python experience
- Experience with PostgreSQL and Redis
- Strong communication skills

Preferred:
- Experience with Docker and Kubernetes
- Knowledge of machine learning pipelines

We offer equity and a remote work environment.
"""

MINIMAL_POSTING = "Software Engineer needed at Startup Inc."

SAMPLE_BACKGROUND = {
    "name": "Jane Smith",
    "email": "jane@example.com",
    "skills": ["Python", "Node.js", "PostgreSQL", "Docker", "REST APIs"],
    "experience": [
        {
            "title": "Backend Engineer",
            "company": "OldCo",
            "dates": "2022–2026",
            "bullets": [
                "Built scalable Python microservices handling 10k req/s",
                "Designed PostgreSQL schemas for multi-tenant SaaS",
                "Implemented REST APIs consumed by mobile clients",
            ],
        }
    ],
}


# ── analyze_job_posting ───────────────────────────────────────────────────────

def test_analyze_returns_dataclass():
    result = analyze_job_posting(SAMPLE_POSTING)
    assert isinstance(result, JobPostingAnalysis)


def test_analyze_extracts_company():
    result = analyze_job_posting(SAMPLE_POSTING)
    assert "Acme" in result.company


def test_analyze_extracts_required_skills():
    result = analyze_job_posting(SAMPLE_POSTING)
    assert any("python" in s.lower() for s in result.required_skills)


def test_analyze_extracts_responsibilities():
    result = analyze_job_posting(SAMPLE_POSTING)
    assert len(result.key_responsibilities) > 0
    assert any("mentor" in r.lower() or "backend" in r.lower() or "scalable" in r.lower() or "apis" in r.lower()
               for r in result.key_responsibilities)


def test_analyze_extracts_signals():
    result = analyze_job_posting(SAMPLE_POSTING)
    # posting mentions "fast-paced", "remote", "equity"
    signal_text = " ".join(result.signals).lower()
    assert "fast" in signal_text or "remote" in signal_text or "equity" in signal_text


def test_analyze_records_raw_text_length():
    result = analyze_job_posting(SAMPLE_POSTING)
    assert result.raw_text_length > 0


def test_analyze_empty_text_returns_empty():
    result = analyze_job_posting("")
    assert result.role == ""
    assert result.required_skills == []


def test_analyze_minimal_text_does_not_crash():
    result = analyze_job_posting(MINIMAL_POSTING)
    assert isinstance(result, JobPostingAnalysis)


def test_analyze_to_dict():
    result = analyze_job_posting(SAMPLE_POSTING)
    d = result.to_dict()
    assert "company" in d and "required_skills" in d and "signals" in d


# ── tailor_highlights ─────────────────────────────────────────────────────────

def test_tailor_returns_dataclass():
    analysis = analyze_job_posting(SAMPLE_POSTING)
    result = tailor_highlights(analysis, SAMPLE_BACKGROUND)
    assert isinstance(result, TailoringResult)


def test_tailor_matched_skills_are_subset_of_user_skills():
    analysis = analyze_job_posting(SAMPLE_POSTING)
    result = tailor_highlights(analysis, SAMPLE_BACKGROUND)
    user_lower = {s.lower() for s in SAMPLE_BACKGROUND["skills"]}
    for skill in result.matched_skills:
        assert skill.lower() in user_lower


def test_tailor_confidence_is_fraction():
    analysis = analyze_job_posting(SAMPLE_POSTING)
    result = tailor_highlights(analysis, SAMPLE_BACKGROUND)
    assert 0.0 <= result.confidence <= 1.0


def test_tailor_picks_up_matching_bullet():
    analysis = analyze_job_posting(SAMPLE_POSTING)
    result = tailor_highlights(analysis, SAMPLE_BACKGROUND)
    # User has python bullets, posting requires python — at least one should appear
    assert len(result.tailored_bullets) > 0


def test_tailor_cover_letter_opening_mentions_company():
    analysis = analyze_job_posting(SAMPLE_POSTING)
    result = tailor_highlights(analysis, SAMPLE_BACKGROUND)
    # company extracted as "Acme Corp" or similar
    assert "Acme" in result.cover_letter_opening or "company" in result.cover_letter_opening.lower()


def test_tailor_gap_skills_not_in_user_skills():
    analysis = analyze_job_posting(SAMPLE_POSTING)
    background_no_redis = {**SAMPLE_BACKGROUND, "skills": ["Python"]}
    result = tailor_highlights(analysis, background_no_redis)
    user_lower = {s.lower() for s in background_no_redis["skills"]}
    for gap in result.gap_skills:
        assert gap.lower() not in user_lower


def test_tailor_empty_background_does_not_crash():
    analysis = analyze_job_posting(SAMPLE_POSTING)
    result = tailor_highlights(analysis, {})
    assert isinstance(result, TailoringResult)


def test_tailor_to_dict():
    analysis = analyze_job_posting(SAMPLE_POSTING)
    result = tailor_highlights(analysis, SAMPLE_BACKGROUND)
    d = result.to_dict()
    assert "tailored_bullets" in d and "confidence" in d and "gap_skills" in d


# ── build_application_summary ─────────────────────────────────────────────────

def test_summary_contains_candidate_name():
    analysis = analyze_job_posting(SAMPLE_POSTING)
    tailoring = tailor_highlights(analysis, SAMPLE_BACKGROUND)
    summary = build_application_summary("Jane Smith", analysis, tailoring)
    assert "Jane Smith" in summary


def test_summary_contains_confidence_percent():
    analysis = analyze_job_posting(SAMPLE_POSTING)
    tailoring = tailor_highlights(analysis, SAMPLE_BACKGROUND)
    summary = build_application_summary("Jane Smith", analysis, tailoring)
    assert "%" in summary


def test_summary_contains_generate_document_hint():
    analysis = analyze_job_posting(SAMPLE_POSTING)
    tailoring = tailor_highlights(analysis, SAMPLE_BACKGROUND)
    summary = build_application_summary("Jane Smith", analysis, tailoring)
    assert "generate_document" in summary


def test_summary_flags_gaps():
    # Use a background that has a gap
    analysis = analyze_job_posting(SAMPLE_POSTING)
    background_gap = {**SAMPLE_BACKGROUND, "skills": ["Python"]}
    tailoring = tailor_highlights(analysis, background_gap)
    summary = build_application_summary("Jane Smith", analysis, tailoring)
    # Gap section should appear when there are gaps
    if tailoring.gap_skills:
        assert "not mentioned" in summary.lower() or "gap" in summary.lower()
