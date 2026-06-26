"""
job_application.py — Job Application Assistant Skill (ADR-0008 §Decision 2).

This Skill chains web_search + web_fetch → analyze → create_document
to produce a tailored resume + cover letter in the user workspace.

NO autonomous submission. The operator reviews workspace output and
submits manually. This is intentional per ADR-0008 "no autonomous
submission" constraint.

Callable from:
  - MCP tool dispatch (see src/mcp_server/server.py)
  - Python directly: run_job_application_skill(params)
"""
import re
import json
import textwrap
from dataclasses import dataclass, field, asdict
from datetime import date
from pathlib import Path

# Lazy imports for tool dependencies — avoids hard requirement on Node.js
# being present in the Python runtime. The Node tool-runner handles actual
# web_search/web_fetch/create_document execution; this module orchestrates
# the workflow and can be unit-tested without a live server.


def _extract_requirements(posting_text: str) -> dict:
    """
    Lightweight keyword extraction from a job posting.
    Returns {skills: [...], qualifications: [...], tone: str}.
    Evidence: heuristic; no LLM call here (keeps this pure Python, testable).
    """
    text = posting_text.lower()

    # Common skill signals
    tech_skills = re.findall(
        r'\b(python|javascript|typescript|react|node\.?js|sql|aws|gcp|azure|'
        r'docker|kubernetes|git|ci/cd|machine learning|llm|api|rest|graphql|'
        r'java|go|rust|c\+\+|ruby|rails|django|flask|fastapi)\b',
        text
    )
    soft_skills = re.findall(
        r'\b(communication|collaboration|leadership|problem.solving|'
        r'analytical|detail.oriented|self.starter|cross.functional|'
        r'agile|scrum|stakeholder)\b',
        text
    )

    # Qualification signals
    years_req = re.findall(r'(\d+)\+?\s*years?\s*(?:of\s+)?(?:experience|exp)', text)
    degree_req = re.findall(r"\b(bachelor'?s?|master'?s?|phd|bs|ms|ba|ma)\b", text)

    # Tone detection (formal vs startup)
    tone = "startup" if any(w in text for w in ["fast-paced", "startup", "scrappy", "hustle"]) else "professional"

    return {
        "tech_skills": list(dict.fromkeys(tech_skills))[:12],
        "soft_skills": list(dict.fromkeys(soft_skills))[:6],
        "years_required": years_req[0] if years_req else None,
        "degree_required": degree_req[0] if degree_req else None,
        "tone": tone,
    }


def _slug(text: str, max_len: int = 30) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:max_len]


def build_application_package(
    posting_text: str,
    posting_url: str,
    operator_name: str,
    operator_email: str,
    role: str,
    company: str,
    base_experience: list = None,
    base_skills: list = None,
    extra_context: str = "",
) -> dict:
    """
    Build a job application package (resume + cover letter fields).
    Returns a dict ready for create_document calls.

    This is the pure-Python core of the skill — no I/O, fully testable.
    """
    reqs = _extract_requirements(posting_text)
    today = date.today().isoformat()
    slug = f"{_slug(role)}-{_slug(company)}-{today}"
    output_dir = f"applications/{slug}"

    # Merge operator skills with posting requirements for the summary
    matched_skills = base_skills or []
    if reqs["tech_skills"]:
        # Highlight skills from the posting the operator has
        matched_skills = list(dict.fromkeys(matched_skills + reqs["tech_skills"]))

    resume_fields = {
        "name": operator_name,
        "email": operator_email,
        "summary": (
            f"Experienced professional applying for the {role} role at {company}. "
            f"Strong background in {', '.join(matched_skills[:4]) if matched_skills else 'the required domain'}. "
            + (extra_context or "")
        ).strip(),
        "experience": base_experience or [],
        "skills": matched_skills[:16],
    }

    cover_letter_fields = {
        "name": operator_name,
        "email": operator_email,
        "company": company,
        "role": role,
        "body_paragraphs": [
            (
                f"I am excited to apply for the {role} position at {company}. "
                f"The role's emphasis on "
                + (", ".join(reqs["tech_skills"][:3]) if reqs["tech_skills"] else "the required skills")
                + " aligns directly with my background."
            ),
            (
                "Throughout my career I have built expertise in "
                + (", ".join(matched_skills[:4]) if matched_skills else "the key areas required")
                + ". I am confident I can contribute meaningfully from day one."
            ),
        ],
        "closing": (
            f"I look forward to discussing how my background can help {company} achieve its goals. "
            "Thank you for your time and consideration."
        ),
    }

    return {
        "slug": slug,
        "output_dir": output_dir,
        "resume_path": f"{output_dir}/resume.md",
        "cover_letter_path": f"{output_dir}/cover-letter.md",
        "resume_fields": resume_fields,
        "cover_letter_fields": cover_letter_fields,
        "requirements_extracted": reqs,
        "evidence": {
            "posting_url": posting_url,
            "confidence": 0.7,
            "source": "web_fetch + heuristic extraction",
        },
    }


def run_job_application_skill(params: dict) -> dict:
    """
    Orchestrate the full skill workflow.

    params keys:
      role, company, posting_url (optional), posting_text (optional),
      operator_name, operator_email,
      base_experience (list), base_skills (list), extra_context (str)

    Returns:
      { ok, resume_path, cover_letter_path, workspace_dir, evidence, ... }

    NOTE: This function does NOT call web_search/web_fetch directly — those
    are Node.js tools. In MCP dispatch the server calls those tools first and
    passes posting_text here. This keeps the skill testable in pure Python.
    """
    role = params.get("role", "the position")
    company = params.get("company", "the company")
    posting_url = params.get("posting_url", "")
    posting_text = params.get("posting_text", "") or ""
    operator_name = params.get("operator_name", "Operator")
    operator_email = params.get("operator_email", "")
    base_experience = params.get("base_experience", [])
    base_skills = params.get("base_skills", [])
    extra_context = params.get("extra_context", "")

    try:
        pkg = build_application_package(
            posting_text=posting_text,
            posting_url=posting_url,
            operator_name=operator_name,
            operator_email=operator_email,
            role=role,
            company=company,
            base_experience=base_experience,
            base_skills=base_skills,
            extra_context=extra_context,
        )
        return {
            "ok": True,
            "resume_path": pkg["resume_path"],
            "cover_letter_path": pkg["cover_letter_path"],
            "workspace_dir": pkg["output_dir"],
            "resume_fields": pkg["resume_fields"],
            "cover_letter_fields": pkg["cover_letter_fields"],
            "requirements_extracted": pkg["requirements_extracted"],
            "evidence": pkg["evidence"],
            "next_steps": [
                f"Review resume at workspace:{pkg['resume_path']}",
                f"Review cover letter at workspace:{pkg['cover_letter_path']}",
                "Edit fields as needed, then submit manually",
                "NO automated submission — human confirmation required",
            ],
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── Analysis / tailoring public API (#1098) ─────────────────────────────────────
#
# These are the pure-Python, testable entry points used by tests/ and by the
# MCP/Node tool-runner. They sit alongside build_application_package above:
# analyze_job_posting() reads a posting, tailor_highlights() matches it against
# the operator's background, and build_application_summary() renders a human
# review summary. No I/O, no LLM call — heuristic extraction only.

_TECH_RE = re.compile(
    r'\b(python|javascript|typescript|react|node\.?js|sql|postgresql|postgres|'
    r'redis|mongodb|aws|gcp|azure|docker|kubernetes|git|ci/cd|machine learning|'
    r'llm|apis?|rest|graphql|java|go|rust|c\+\+|ruby|rails|django|flask|fastapi)\b',
    re.I,
)

_SIGNAL_WORDS = [
    "fast-paced", "remote", "hybrid", "on-site", "equity", "startup",
    "scrappy", "hustle", "mentor", "growth", "ownership",
]


@dataclass
class JobPostingAnalysis:
    """Structured view of a job posting (heuristic extraction)."""
    role: str = ""
    company: str = ""
    required_skills: list = field(default_factory=list)
    preferred_skills: list = field(default_factory=list)
    key_responsibilities: list = field(default_factory=list)
    signals: list = field(default_factory=list)
    raw_text_length: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class TailoringResult:
    """Result of matching an operator's background against a posting."""
    matched_skills: list = field(default_factory=list)
    gap_skills: list = field(default_factory=list)
    tailored_bullets: list = field(default_factory=list)
    cover_letter_opening: str = ""
    confidence: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


def _bullets_under(text: str, header_pattern: str) -> list:
    """Collect bullet lines under a "Header:" line until the next section."""
    out = []
    collecting = False
    for line in text.splitlines():
        s = line.strip()
        if not collecting:
            if re.search(header_pattern, s, re.I) and s.endswith(":"):
                collecting = True
            continue
        if not s:
            continue
        if s.endswith(":"):  # next section header
            break
        if s.startswith(("-", "*", "•")):
            out.append(s.lstrip("-*• ").strip())
        else:  # non-bullet prose ends the section
            break
    return out


def _tech_tokens(text: str) -> list:
    return list(dict.fromkeys(m.group(0) for m in _TECH_RE.finditer(text)))


def analyze_job_posting(posting_text: str) -> JobPostingAnalysis:
    """
    Extract role, company, skills, responsibilities, and culture signals from a
    raw job posting. Pure heuristic — no LLM. Empty input yields an empty
    analysis (role == "", required_skills == []).
    """
    text = posting_text or ""
    if not text.strip():
        return JobPostingAnalysis(raw_text_length=len(text))

    lines = [l.strip() for l in text.splitlines() if l.strip()]
    role, company = "", ""
    if lines:
        m = re.match(r"(.+?)\s+at\s+(.+)", lines[0], re.I)
        if m:
            role = m.group(1).strip()
            company = m.group(2).strip()
        else:
            role = lines[0]

    required_block = " ".join(_bullets_under(text, r"required|requirements|must.?have")) \
        or text  # fall back to whole posting if no explicit section
    preferred_block = " ".join(_bullets_under(text, r"preferred|nice.?to.?have|bonus"))

    required_skills = _tech_tokens(required_block)
    preferred_skills = [s for s in _tech_tokens(preferred_block) if s not in required_skills]

    responsibilities = _bullets_under(text, r"responsibilities|what you.?ll do|the role")

    low = text.lower()
    signals = [w for w in _SIGNAL_WORDS if w in low]

    return JobPostingAnalysis(
        role=role,
        company=company,
        required_skills=required_skills,
        preferred_skills=preferred_skills,
        key_responsibilities=responsibilities,
        signals=signals,
        raw_text_length=len(text),
    )


def tailor_highlights(analysis: JobPostingAnalysis, background: dict) -> TailoringResult:
    """
    Match the operator's background against an analyzed posting. Returns matched
    skills (subset of the operator's skills), gap skills (required but absent),
    experience bullets relevant to the posting, a cover-letter opening, and a
    confidence fraction = (required skills the operator has) / (required skills).
    """
    background = background or {}
    user_skills = background.get("skills", []) or []
    user_lower = {s.lower(): s for s in user_skills}

    required = analysis.required_skills or []
    req_unique, seen = [], set()
    for s in required + (analysis.preferred_skills or []):
        sl = s.lower()
        if sl not in seen:
            seen.add(sl)
            req_unique.append(s)

    matched, gaps = [], []
    for s in req_unique:
        if s.lower() in user_lower:
            matched.append(user_lower[s.lower()])
        else:
            gaps.append(s)

    # tailored bullets: experience bullets that mention a relevant skill
    relevant = {s.lower() for s in req_unique} | set(user_lower.keys())
    tailored_bullets = []
    for exp in background.get("experience", []) or []:
        for b in exp.get("bullets", []) or []:
            bl = b.lower()
            if any(skill in bl for skill in relevant):
                tailored_bullets.append(b)

    req_lower = {s.lower() for s in required}
    have = len(req_lower & set(user_lower.keys()))
    confidence = round(have / len(req_lower), 3) if req_lower else 0.0
    confidence = max(0.0, min(1.0, confidence))

    company = analysis.company or "your company"
    role = analysis.role or "this role"
    opening = (
        f"Dear {company} hiring team, I am excited to apply for the {role} "
        f"position at {company}."
    )

    return TailoringResult(
        matched_skills=matched,
        gap_skills=gaps,
        tailored_bullets=tailored_bullets,
        cover_letter_opening=opening,
        confidence=confidence,
    )


def build_application_summary(
    candidate_name: str,
    analysis: JobPostingAnalysis,
    tailoring: TailoringResult,
) -> str:
    """Render a human-readable review summary of the tailored application."""
    pct = round(tailoring.confidence * 100)
    lines = [
        f"Application summary for {candidate_name}",
        f"Role: {analysis.role or 'unknown'} at {analysis.company or 'unknown'}",
        f"Match confidence: {pct}%",
        f"Matched skills: {', '.join(tailoring.matched_skills) or 'none'}",
    ]
    if tailoring.gap_skills:
        lines.append(
            "Gaps (skills required but not mentioned in your background): "
            + ", ".join(tailoring.gap_skills)
        )
    lines.append(
        "Next step: call generate_document to produce the tailored resume + "
        "cover letter, then review and submit manually."
    )
    return "\n".join(lines)


# ── Quick self-test ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    result = run_job_application_skill({
        "role": "Senior Software Engineer",
        "company": "Acme Corp",
        "posting_url": "https://example.com/jobs/123",
        "posting_text": (
            "We are looking for a Senior Software Engineer with 5+ years of experience "
            "in Python and TypeScript. Bachelor's degree preferred. Fast-paced startup environment. "
            "Strong communication and collaboration skills required."
        ),
        "operator_name": "Jane Smith",
        "operator_email": "jane@example.com",
        "base_skills": ["Python", "TypeScript", "React", "SQL"],
        "base_experience": [
            {"title": "Software Engineer", "company": "Previous Co", "dates": "2022–2026",
             "bullets": ["Built REST APIs", "Led frontend migration to React"]}
        ],
    })
    print(json.dumps(result, indent=2))
