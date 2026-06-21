---
author: Alex Place
created: 2026-06-07
updated: 2026-06-20
---

# Privacy Governance — Keystone OS

## Core Rule
**Do not showcase private/personal data as marketing proof.**

Privacy, legality, source rights, repo safety, and user safety take precedence over speed and convenience.

## Prohibited in All Public Contexts
- ❌ Raw dream logs or journal entries
- ❌ Private family context or personal memories
- ❌ Payment details, reimbursement records, financial data
- ❌ Personal addresses, phone numbers, identifying info
- ❌ Raw CSF dumps or unredacted memory exports
- ❌ Private Discord logs, chat history, or messages
- ❌ Internal repo screenshots or debug output
- ❌ Real people's names, likeness, or experiences turned into "lore"
- ❌ Courtney reimbursement material or other personal records
- ❌ Any data that identifies or traces back to real individuals

## Approved for Examples & Demos
- ✅ Fictional sample dreams (invented scenarios)
- ✅ Opt-in tester examples with names removed
- ✅ Sanitized architectural diagrams
- ✅ Redacted CSF format specifications
- ✅ Anonymized Three Doors patterns
- ✅ Generic provider routing examples
- ✅ Open-source tool citations

## Data Handling Rules
1. **Separation of concerns:** Keep public demos separate from internal test data
2. **Opt-in only:** Use real examples only from users who explicitly consent
3. **Sanitization:** Remove all PII, timestamps, relationships, and location data
4. **Legality:** Respect copyright, licensing, and data protection laws
5. **Source attribution:** Always credit ideas, data sources, and prior work
6. **Rollback path:** If private data leaks, have a documented take-down plan

## Implementation
- All example data lives in `examples/sanitized/` (not `data/`, `tests/`, or `archive/`)
- Sample dreams use fictional characters (Aria, Blake, Sam) never tied to real people
- CSF examples show structure only, never real memory trees
- Dream Journal demos use reset-on-close state, never persist test data to repo
- Google Drive contains the real data; repos contain only sanitized references

## For Claude Code Sessions
When demoing or discussing Keystone OS:
1. Reference architecture, not content
2. Show Three Doors structure, not actual door names or sequences
3. Discuss PCSF receipt format, not real provider/capacity logs
4. Mention CSF tiers abstractly, not actual memories
5. Never paste raw JSON, logs, or dreams from real runs

## Enforcement
- Pre-commit hooks reject commits with patterns like `"user": "alex"` or `"email":`
- CI blocks PRs that add real data to public branches
- Manual review before any public marketing or demo
- Monthly audit of `data/`, `examples/`, and `archive/` for accidental leaks

---

**Updated:** 2026-06-08 · **Priority:** Critical
