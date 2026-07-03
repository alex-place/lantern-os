---
name: job_application
status: live
version: 2.0.0
module: skills/job_application/job_application.py
depends_on:
  - web_search (tool-runner.js)
  - web_fetch (tool-runner.js)
  - generate_document (tool-runner.js)
  - create_document (tool-runner.js)
  - workspace_write (tool-runner.js)
---

# Job Application Assistant Skill

**Status: live** — all dependent tools are implemented and wired.

## What it does

A capability of the **one chat assistant** (ADR-0008: Skills chain Tools). There
is no dedicated persona, keyword route, or scripted flow in front of it: the
assistant handles job-application asks conversationally — the way a first-class
AI assistant does — and reaches for real tools as the conversation needs them:

1. **Read the posting** — `web_search` / `web_fetch` when given a role, company,
   or URL; extract required skills, qualifications, and tone.
2. **Work from what's already known** — the user's message, an attached resume,
   prior turns, and memory. Deliver feedback or a tailored draft immediately;
   mark real gaps inline ("[add phone]"); ask at most one clarifying question,
   and only when the answer genuinely changes the work. Never respond with a
   template field list.
3. **Produce documents** — `generate_document` (template=`resume` |
   `cover-letter`; **every field optional**) renders HTML/Markdown into
   `~/.keystone/workspace/`.
4. **Honest gap report** — required skills NOT found in the user's background
   are named, never silently filled (Σ₀: no fabricated experience).
5. **Human confirmation gate** — nothing is ever submitted. The operator
   reviews the workspace output and acts.

## Acceptance criteria

- [x] A resume/cover-letter ask gets substantive help in the FIRST reply (no
      field-checklist interrogation)
- [x] Attached documents are used as the background source, not re-requested
- [x] End-to-end conversation can produce a tailored resume + cover letter in
      the workspace
- [x] No autonomous submission (human must confirm and act)
- [x] No fabricated experience; gaps are visible per Σ₀ External Reality Rule

## Example asks (handled by the model, not keyword routing)

- "help me work on my resume" (with or without an attached resume)
- "help me apply for [role] at [company]"
- "write a cover letter for [job]"
- "tailor my resume for [posting URL]"

## Out of scope

- Submitting the application (intentional — human-in-the-loop)
- Storing the operator's base resume (use workspace_write directly)
- ATS scraping or form-filling (follow-up issue)
