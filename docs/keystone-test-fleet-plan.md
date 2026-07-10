# unisona.ai Autonomous Test Fleet — Full Buildout Plan

**Status**: Ready to implement  
**Phases**: 6 (Setup → Engine → Scoring → Filing → Observability → Optimization)  
**Est. effort**: 20 PRs, ~2–3 weeks (solo)  
**Integration**: Streams via `/api/dream/autonomous-work` (#527 A1 pattern)  
**Sigma-0 grounding**: Every finding has [claim, evidence, confidence, source]

---

## Architecture Overview

```
unisona.ai (agent) 
  ↓ (chat: "test the app")
/api/dream/autonomous-work with task_type: "keystone-test"
  ├─ KeystoneTestEngine (Playwright automation)
  │  ├─ Scenario: home-load, dream-chat-init, form-tests, etc.
  │  └─ Output: Finding[] { screenshot, console-error, network-timing }
  │
  ├─ KeystoneAnalyzer (confidence scoring)
  │  ├─ Heuristic model: High(0.8–1.0) / Medium(0.5–0.79) / Low(0.2–0.49)
  │  └─ Dedup & cluster findings
  │
  └─ IssueFilr (GitHub automation)
     ├─ Generate markdown from ScoredFinding[]
     ├─ Approval gate: "Approve filing? [y/n]"
     └─ File to GitHub with labels [keystone-autonomous], [sigma0-grounded]

SSE stream (dream-chat.html live log):
  { "step": "surveyor_started", ... }
  { "step": "scenario_complete", ... }
  { "step": "analyzer_complete", "findings_scored": [...] }
  { "step": "approval_gate", "summary": "2 bugs, 1 UX" }
  { "step": "issue_filed", "url": "..." }
  { "step": "run_complete", "convergence_record": {...} }

Persistent log:
  data/keystone-test-runs.jsonl (one record per run, append-only)
```

---

## Issue List & PR Mapping

### PHASE 0: Setup & Scaffolding (3 issues)

| # | Title | PR branch | Est. scope |
|---|-------|-----------|-----------|
| 601 | [EPIC] unisona.ai Autonomous Test Fleet | (epic, no PR) | — |
| 602 | [Infra] Create keystone-test-engine.js scaffold | `claude/602-keystone-test-engine-scaffold` | 100 LOC |
| 603 | [Infra] Create keystone-analyzer.js confidence scorer | `claude/603-keystone-analyzer-scaffold` | 80 LOC |
| 604 | [Routes] Create /api/keystone/test-run endpoint | `claude/604-keystone-test-route` | 50 LOC |

### PHASE 1: Core Playwright Test Engine (4 issues)

| # | Title | PR branch | Est. scope |
|---|-------|-----------|-----------|
| 605 | [Core] Playwright: Navigate & screenshot scenarios | `claude/605-keystone-scenarios-home-chat` | 200 LOC |
| 606 | [Core] Playwright: Form & interaction tests | `claude/606-keystone-form-tests` | 250 LOC |
| 607 | [Core] Playwright: Responsiveness & dark mode | `claude/607-keystone-responsive-tests` | 180 LOC |
| 608 | [Core] Playwright: Console & network monitoring | `claude/608-keystone-observability` | 120 LOC |

### PHASE 2: Finding Classification & Confidence Scoring (3 issues)

| # | Title | PR branch | Est. scope |
|---|-------|-----------|-----------|
| 609 | [Scoring] Implement heuristic confidence model | `claude/609-keystone-confidence-heuristic` | 150 LOC |
| 610 | [Scoring] Cluster & deduplicate findings | `claude/610-keystone-dedup` | 100 LOC |
| 611 | [Scoring] Auto-categorize issue type | `claude/611-keystone-categorize` | 80 LOC |

### PHASE 3: GitHub Issue Filing (3 issues)

| # | Title | PR branch | Est. scope |
|---|-------|-----------|-----------|
| 612 | [Filing] Wire GitHub API client | `claude/612-keystone-gh-client` | 120 LOC |
| 613 | [Filing] Generate issue markdown from findings | `claude/613-keystone-issue-template` | 140 LOC |
| 614 | [Filing] Batch file issues with approval gate | `claude/614-keystone-approval-gate` | 110 LOC |

### PHASE 4: Convergence Records & Observability (3 issues)

| # | Title | PR branch | Est. scope |
|---|-------|-----------|-----------|
| 615 | [Records] Append convergence record for each test run | `claude/615-keystone-convergence-record` | 80 LOC |
| 616 | [Streaming] Wire keystone-test-engine into /api/dream/autonomous-work | `claude/616-keystone-streaming-integration` | 200 LOC |
| 617 | [UI] Add unisona.ai test panel to dream-chat.html | `claude/617-keystone-test-panel-ui` | 300 LOC |

### PHASE 5: Integration & Auto-Scheduling (3 issues)

| # | Title | PR branch | Est. scope |
|---|-------|-----------|-----------|
| 618 | [Integration] Wire unisona.ai persona to trigger test runs | `claude/618-keystone-persona-routing` | 100 LOC |
| 619 | [Scheduling] Auto-schedule daily test runs at startup | `claude/619-keystone-daily-schedule` | 80 LOC |
| 620 | [Hardening] Error recovery & resilience | `claude/620-keystone-resilience` | 120 LOC |

### PHASE 6: Optimization & Validation (3 issues)

| # | Title | PR branch | Est. scope |
|---|-------|-----------|-----------|
| 621 | [Perf] Parallelize scenario execution | `claude/621-keystone-parallelization` | 100 LOC |
| 622 | [Validation] Add self-test: run test harness on test harness | `claude/622-keystone-self-test` | 150 LOC |
| 623 | [Docs] Update CLAUDE.md with unisona.ai Testing Charter | `claude/623-keystone-docs` | 50 LOC |

---

## Key Files to Create/Modify

### New Files
- `apps/lantern-garage/lib/keystone-test-engine.js` — Playwright automation
- `apps/lantern-garage/lib/keystone-analyzer.js` — Finding scoring
- `apps/lantern-garage/lib/gh-issue-filer.js` — GitHub API wrapper
- `apps/lantern-garage/routes/keystone-autonomous.js` — SSE streaming endpoint
- `apps/lantern-garage/public/js/keystone-test-panel.js` — UI logic
- `data/keystone-test-runs.jsonl` — Append-only convergence record

### Modified Files
- `apps/lantern-garage/public/dream-chat.html` — Add test panel
- `apps/lanterns-garage/lib/dream-chat.js` — Route "test" messages to unisona.ai
- `apps/lantern-garage/server.js` — Wire routes
- `CLAUDE.md` — Add unisona.ai Testing Charter section
- `.env.example` — Add KEYSTONE_AUTO_TEST=true, GITHUB_TEST_ISSUES_LABEL

---

## Execution Strategy

**Monoworkstream**: All PRs use `claude/` branch prefix. Open them serially (one at a time per the monoworkstream rule), testing as you go.

**Review pattern**: Each PR should have:
- Test coverage (basic happy-path test in `npm run test:chat` or Playwright smoke test)
- Convergence record demonstrating the phase completed
- No features beyond the current phase (no premature integration)

**Integration checkpoint**: After Phase 3 (#614), you should be able to file a test issue to GitHub. Stop and verify.

**Daily validation**: After Phase 5, unisona.ai test runs automatically at 03:00 UTC. Watch logs, refine findings.

---

## Sigma-0 Grounding (Non-Negotiable)

Every Finding must include:
```typescript
interface Finding {
  claim: string;                        // e.g., "XSS in image gallery onclick"
  evidence: string[];                   // ["screenshot.png", "console trace", "HTML snippet"]
  sources: { scenario: string; step: number }[];  // reproducible locator
  confidence: number;                   // 0–1
  reproduced: boolean;                  // Did we see it twice+?
}
```

**Filing threshold**: Only file if confidence >= 0.6 (Medium+). Low-confidence findings go into `data/keystone-insights.jsonl` for manual review later.

---

## Success Criteria

- [ ] Phase 0: Scaffolding compiles, routes exist
- [ ] Phase 1: All 8 scenarios run, capture findings
- [ ] Phase 2: Findings score with confidence >= 0.5 on high-priority bugs
- [ ] Phase 3: File a test issue (manual approval), verify on GitHub
- [ ] Phase 4: SSE stream visible in dream-chat.html, convergence record appended
- [ ] Phase 5: "test the app" in dream-chat triggers run automatically
- [ ] Phase 6: Parallel execution < 5s wall-clock, self-test passes

---

## Known Constraints & Trade-offs

1. **Playwright vs. Puppeteer**: Using Playwright for better multi-browser support (Chrome, Firefox, WebKit). Adds @playwright/test dependency.
2. **Confidence model v0**: Heuristic rules only (no ML). Next iteration can add learned weights.
3. **No GUI for finding review yet**: Approval gate is command-line only (will be dream-chat.html panel in #617).
4. **Daily schedule is naive**: Uses setInterval, will be cron-job-based in v1.1.
5. **Screenshots in issues**: Base64-encoded in markdown (larger PRs, but no external image hosting needed).

---

## Related Issues & Epics

- **#527** (EPIC): Honest Autonomous Chat — umbrella for autonomous-work observability
- **#509** (CLOSED): Sigma-0 gaps — all 5 priority gaps closed
- **#451** (CLOSED): Kalshi Dashboard — trades testing integration (reference for data flow)

---

**Next step**: Create GitHub issues 601–623 and start Phase 0 PRs.
