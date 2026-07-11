# unisona.ai Autonomous Test Fleet — Summary & Quick Start

**Date**: 2026-06-16  
**Status**: Issues created, ready for Phase 0 implementation  
**Total Issues**: 1 EPIC + 23 sub-issues (6 phases)  
**Estimated delivery**: 2–3 weeks (solo developer)

---

## What We Built

A **complete GitHub issue roadmap** for an autonomous testing agent (unisona.ai) that:

1. **Runs browser automation** (Playwright) against dream-chat.html, home, trader dashboard
2. **Detects bugs** (crashes, missing elements, console errors, security issues)
3. **Scores findings** with Sigma-0 rigor (confidence + evidence + sources)
4. **Files issues** to GitHub automatically with approval gate
5. **Streams all steps** via SSE (fully observable, per #527 A1 pattern)
6. **Persists results** in convergence records (append-only JSONL)
7. **Integrates with unisona.ai persona** in dream-chat.html ("test the app")
8. **Auto-runs daily** at startup (03:00 UTC)

---

## Issue Map

| Phase | Issues | Branch Prefix | Est. LOC | Description |
|-------|--------|---------------|---------|-------------|
| **0** | #567–569 | `claude/60[2-4]` | 230 | Scaffolding: engines, routes |
| **1** | #570–573 | `claude/60[5-8]` | 750 | Playwright: scenarios, responsiveness, monitoring |
| **2** | #574–576 | `claude/60[9-11]` | 330 | Confidence scoring, dedup, categorization |
| **3** | #577–579 | `claude/61[2-4]` | 370 | GitHub API, markdown generation, approval gate |
| **4** | #580–582 | `claude/61[5-7]` | 580 | Convergence records, SSE streaming, UI panel |
| **5** | #583–585 | `claude/61[8-20]` | 300 | Persona routing, daily scheduling, resilience |
| **6** | #586–588 | `claude/62[1-23]` | 300 | Parallelization, self-test, documentation |
| **EPIC** | #566 | (links all) | — | Master tracking issue |

**Total**: ~2,860 LOC across 23 PRs

---

## Quick Links

- **[Full Buildout Plan](keystone-test-fleet-plan.md)** — Detailed specs for all 23 issues
- **[EPIC Issue #566](https://github.com/alex-place/lantern-os/issues/566)** — Master tracking
- **[Phase 0 Issues](https://github.com/alex-place/lantern-os/issues?q=is%3Aopen+label%3Aagent-task+number%3A567+OR+number%3A568+OR+number%3A569)** — Start here

---

## Execution Plan

### Week 1: Foundations (Phases 0–2)

```
Day 1–2: Phase 0 (scaffolding)
  - Create KeystoneTestEngine class
  - Create KeystoneAnalyzer class
  - Wire /api/keystone/test-run route
  
Day 3–4: Phase 1 (scenarios)
  - Implement 8 Playwright scenarios
  - Capture screenshots + console errors
  - Test with local server running
  
Day 5: Phase 2 (scoring)
  - Heuristic confidence model
  - Dedup similar findings
  - Auto-categorize by type
```

### Week 2: Integration (Phases 3–4)

```
Day 6–7: Phase 3 (filing)
  - Wire GitHub API
  - Generate issue markdown
  - Approval gate (user confirmation before filing)
  
Day 8–9: Phase 4 (observability)
  - Convergence records (JSONL)
  - SSE streaming into /api/dream/autonomous-work
  - Test panel in dream-chat.html
```

### Week 3: Polish (Phases 5–6)

```
Day 10: Phase 5 (integration)
  - unisona.ai persona routes "test" messages
  - Daily cron scheduler
  - Error recovery & resilience
  
Day 11–12: Phase 6 (optimization)
  - Parallel scenario execution
  - Self-test harness
  - Documentation update (CLAUDE.md)
```

---

## Sigma-0 Grounding (Non-Negotiable)

Every Finding must have:

```typescript
interface Finding {
  claim: string;                          // "XSS in image gallery onclick"
  evidence: string[];                     // ["screenshot.png", "console trace"]
  sources: { scenario: string; step: number }[];
  confidence: number;                     // 0–1
  reproduced: boolean;                    // Seen 2+ times?
}
```

**Filing threshold**: confidence >= 0.6 (Medium+) only.  
Low-confidence findings go to `data/keystone-insights.jsonl` for manual review.

---

## Key Files to Create

| File | Purpose | Est. LOC |
|------|---------|---------|
| `apps/lantern-garage/lib/keystone-test-engine.js` | Playwright automation core | 400 |
| `apps/lantern-garage/lib/keystone-analyzer.js` | Finding scoring + dedup | 200 |
| `apps/lantern-garage/lib/gh-issue-filer.js` | GitHub API wrapper | 150 |
| `apps/lantern-garage/routes/keystone-autonomous.js` | SSE streaming endpoint | 200 |
| `apps/lantern-garage/public/js/keystone-test-panel.js` | Dream-chat UI logic | 300 |
| `data/keystone-test-runs.jsonl` | Append-only convergence log | — |
| `docs/keystone-test-fleet-plan.md` | Full specifications | — |

---

## Success Criteria

Each phase has acceptance criteria in its GitHub issue. High-level:

- [ ] **Phase 0**: Scaffolding compiles, routes exist
- [ ] **Phase 1**: 8 scenarios run, capture findings
- [ ] **Phase 2**: Findings score with confidence, sorted by type
- [ ] **Phase 3**: Can file a test issue to GitHub (with approval)
- [ ] **Phase 4**: SSE stream visible in dream-chat.html, convergence record appended
- [ ] **Phase 5**: "test the app" in dream-chat triggers run, daily auto-run active
- [ ] **Phase 6**: Parallel execution < 5s, self-test passes

---

## Constraints & Trade-offs

1. **Playwright vs. Puppeteer**: Playwright chosen for multi-browser support. Adds @playwright/test dependency.
2. **Confidence model v0**: Heuristic rules only (no ML). Can improve later.
3. **No GUI for finding review**: Approval gate is CLI only (#617 adds dream-chat.html panel).
4. **Daily schedule naive**: Uses setInterval, will be cron-based in v1.1.
5. **Screenshots in issues**: Base64-encoded in markdown (larger PRs, no external hosting).

---

## Related Work

- **#527** (EPIC): Honest Autonomous Chat — streaming infrastructure that powers this
- **#509** (CLOSED): Sigma-0 gaps — all research validated
- **#451** (CLOSED): Kalshi Dashboard — reference for observability patterns

---

## Next Steps

1. **Read the plan**: [keystone-test-fleet-plan.md](keystone-test-fleet-plan.md)
2. **Create a branch**: `git checkout -b claude/602-keystone-test-engine-scaffold origin/master`
3. **Start Phase 0**: Create `apps/lantern-garage/lib/keystone-test-engine.js` scaffold
4. **Open PR**: Link to #566 (EPIC) and #567 (issue 602)
5. **Test locally**: `npm start` + run scenarios manually
6. **Iterate**: Each phase builds on the previous; test as you go

---

**Questions?** Check the full [keystone-test-fleet-plan.md](keystone-test-fleet-plan.md) for detailed specs on every issue.

**Ready to start?** Issue #567 (keystone-test-engine scaffold) is your entry point.
