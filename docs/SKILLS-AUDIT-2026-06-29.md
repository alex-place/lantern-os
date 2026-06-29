# Skills Audit — 2026-06-29 (Σ₀ scope-discipline pass)

**Owner:** Alex Place · **Driver:** Σ₀ council / tonight's grade card (SCOPE axis, graded D+)
**Method:** every `skills/*/SKILL.md` classified against the one-loop gate (Observe→Remember→Reason→Act→Verify→Converge) and the "is it actually implemented?" test, per [BACKLOG-REVIEW-STANDARDS.md](BACKLOG-REVIEW-STANDARDS.md) §4.

> **North Star:** every skill must strengthen one loop stage and have real backing, or it is sprawl. A `SKILL.md` with no implementation is a design contract, not a capability — and must say so.

## Decisions

### Deleted (7) — design-only relics, no backing code, fail the one-loop gate
Removed this pass (`git rm`). Branding / agile-process / shareholder fluff with no implementation, superseded or never built:

| Skill | Why deleted |
|---|---|
| `arc-reactor-confidence` | Branding ("Tony Garage readiness"); confidence scoring already lives in convergence records. |
| `archive-commons-batch` | Aspirational ingest contract; no intake code. |
| `clean-storm-agile` | A 12-step agile *process doc* — not a system capability. |
| `comet-leap-agile` | Agile-sprint/report artifact; process, not loop. |
| `dream-journal-brand-cadd` | Brand/art-direction contract; no assets, no code. |
| `lantern-custom-report-lib` | Report-style design doc; no implemented library. |
| `foundry-shareholder` | Shareholder-evidence consolidation; not a loop stage. (Note: `manifests/foundry-shareholder-repos.md` is separate and still referenced by CI — untouched.) |

No code imports these; remaining references are in regenerated RAG/manifest artifacts and `docs/CODEMAP.md`, which refresh on their next build.

### Built out (1) — the genuinely missing core contract
| Skill | What |
|---|---|
| `convergence` *(new)* | The Converge stage as a skill — grounded synthesis + Convergence Records, backing the now-externally-grounded `!convergance` command (this session's Part A). The loop's own stage had no skill contract; now it does. |

### Kept — live & loop-aligned (5)
| Skill | Loop stage | Backing |
|---|---|---|
| `dream_journal` | Remember | `src/dream_journal/` |
| `lucid_dreaming` | Act | `skills/lucid_dreaming/mild_wbtb_protocol.py` |
| `job_application` | Act | `skills/job_application/job_application.py` |
| `lantern-rag-dollhouse` | Remember | `skills/lantern-rag-dollhouse/assets/` (pdfs, images) |
| `comet-leap-print-wcag` | Act | `scripts/Build-PerfectArtPdf.ps1` |

### Kept but documented as design-only / flagged for a scope decision (4)
These remain but are **not** live capabilities; each `SKILL.md` should state that plainly (status banner):

| Skill | Status | Disposition |
|---|---|---|
| `bayesian-world-model` | Design-only, foundational | Σ₀-aligned (evidence ledger, confidence updates) but unimplemented. Keep as a **proposed contract**; the real substrate today is `data/convergence/records.jsonl`. Implement or fold into convergence — don't leave it ambiguous. |
| `convergence-mathematical-foundations` | Theory reference | Pure epistemology/FEP theory, not an executable skill. Reclassify as a **reference doc**, not a capability. |
| `human-flourishing-frameworks` | Partial | Refs `routes/flourishing.js` (partial). Flag to the subsystem-register ADR (#1557) — keep only if the flourishing feed is a kept surface. |
| `super-jarvis-lantern-os` | Design-only orchestration | The "one skill that does everything" — superseded by the Convergence Core as the real orchestrator. Keep as a routing **design doc** or retire; do not treat as live. |

### Scope-questionable — route to the Discord/games fate decision (#1560), not the skills surface
| Item | Note |
|---|---|
| `three-doors-game` | LIVE (`three_doors_game.py`) but it's a **game** — non-loop. Don't delete a shipped feature unilaterally; belongs to [SCOPE-4 #1560]. |
| `operator_lore` | Code/data module (`__init__.py` + `operator_csf.json`), no `SKILL.md`. Lore/persona data — review under the same scope decision. |
| `archive_curator`, `voice_curator` | **Name collision — both are real, but not folder-skills.** The *canonical* skills (per SKILLS.md) are real lantern-garage capabilities with no `skills/*/SKILL.md` folder: `archive_curator` = docs/RAG/knowledge curation (**Remember**, `lib/rag-house.js` + `routes/rag.js`), `voice_curator` = TTS (**Act**, wired in the chat UI/routes). Separately, `src/discord_lounge_bot/{archive_curator,voice_curator}.py` are **different** modules that stream Internet Archive / Sinatra audio in Discord voice channels — entertainment that belongs to the Discord-fate decision (#1560). Don't conflate them; consider renaming the Discord modules to avoid the collision. |

## Follow-ups
- [ ] **Refresh CLAUDE.md's skill list** — its "Only these five skills have real implementations" line (dream_journal, lucid_dreaming, archive_curator, voice_curator, job_application) is *real but stale*: it predates `convergence` (now live) and omits `lantern-rag-dollhouse` / `comet-leap-print-wcag`. Update the count/list. *(Needs founder sign-off — CLAUDE.md is canonical.)*
- [ ] Add a one-line status banner ("⚠ Design-only — not implemented") to the 4 design-only `SKILL.md`s.
- [ ] Fold `bayesian-world-model` into `convergence` or implement it against `data/convergence/records.jsonl`.
- [ ] Decide `three-doors-game` / `operator_lore` / Discord curators under [SCOPE-4 #1560].
