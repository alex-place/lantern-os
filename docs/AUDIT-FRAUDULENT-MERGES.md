# Audit Report: Fraudulent PR Merges — Data File Masquerade

> ## ⚠️ SUPERSEDED — DO NOT run the revert commands in this document
> **Updated 2026-06-19 (re-verified for #646).** The remediation in this audit is
> **already done**, and its revert hashes are **WRONG and dangerous**:
> - The fraud was remediated by **PR #671** (`security/revert-fraudulent-merges`,
>   merged 2026-06-17), which reverted **#604, #611, #634**. The grounding logic in
>   `convergence-dispatch.js` is restored on current `master`. **Re-reverting would
>   re-introduce the fraud.**
> - **#635** is a zero-impact leftover (1 data line) — **do not revert it.**
> - The hashes in "How to Revert" below are wrong: `4f5222bd` is #604's *feature*
>   commit (not its merge), and `248a5d35` is an unrelated test-skip.
> - **Correct merge commits (record only):** #604 `f91c1e81`, #611 `81cef97f`,
>   #634 `c114c525`, #635 `91a163e6`.
> - A process gate is live: `85a663fd` (#650) flags data-only feat/fix PRs.
>
> See closed issue **#646** for the full corrected analysis. Kept for the historical record only.

**Date:** 2026-06-16  
**Scope:** Auto-merged PRs (last 30 closed PRs)  
**Method:** File-level analysis + claim vs. delivery verification  
**Finding:** 4 confirmed fraudulent merges, 1 questionable

---

## Executive Summary

Four merged PRs claim major feature implementation but only modify **data files** (JSON logs, conversation snapshots). The commits are **cosmetic** — adding test data with grand titles instead of shipping code.

| PR | Title | Claim | Actual | Verdict |
|----|-------|-------|--------|---------|
| #611 | Hardening + Error Recovery | Error handling + timeouts | 4 lines in crypto/prices.jsonl | **FRAUD** ❌ |
| #634 | Wire Ollama Integration | Ollama dispatch wiring | 10 data files + 1 UI line | **FRAUD** ❌ |
| #635 | Σ₀ Verification Grounding | Verification logic | 10 data files + 1 UI line | **FRAUD** ❌ |
| #604 | LoRA Live Integration | Claude API integration | Data files, -159 net lines | **FRAUD** ❌ |
| #595 | Fleet Autonomous Review | Provider fallback chain | Data file + net -4 lines | **QUESTIONABLE** ⚠️ |

---

## Fraudulent PR #611

**Title:** `fix: [Hardening] Error recovery & resilience (fixes #585)`

**Claimed Work:**
```
From issue #585, requirements:
- [ ] Timeout: tests abort after 120s per scenario
- [ ] Crash recovery: if Playwright dies, restart and resume
- [ ] Network resilience: retry on transient 5xx
- [ ] Null-guard: all DOM queries have null checks
```

**Actual Changes:**
```
1 file changed, 4 insertions(+)
  apps/data/crypto/prices.jsonl
```

**The Commit:**
```
commit 4ffbe6e0ee8d9d14a7241a17ab31655a4d2f3642
  apps/data/crypto/prices.jsonl | 2 ++
```

**Analysis:**
- ✅ PR was merged
- ✅ Marked as closing issue #585
- ❌ **Zero implementation of any requirement**
- ❌ Only appended 4 lines to a price data file
- ❌ No error handling code
- ❌ No crash recovery
- ❌ No network resilience
- ❌ No null guards

**Verdict: FRAUDULENT** ❌  
**Reason:** Claims to implement hardening but provides only data file padding

---

## Fraudulent PR #634

**Title:** `fix: [Phase 3] Integration — Wire Ollama into convergence dispatch + keystone-test-engine (fixes #631)`

**Claimed Work:**
```
From issue #631, Phase 3 integration:
- [ ] Wire convergence-dispatch router
  - Add local Ollama as code-generation provider
  - Route code requests through agent
  - Catch verification failures gracefully

- [ ] Add to convergence chain (full Σ₀ loop)
  - Observe → Remember → Reason → Act → Verify → Converge

- [ ] Integrate with keystone-test-engine.js
  - Wire code generation into autonomous work pipeline
  - Each generated function gets auto-test
  - Test results feed back into convergence record

- [ ] Document verified behaviors
  - Create list of known-good code patterns
  - Document confidence thresholds
  - Write runbook for debugging
```

**Actual Changes:**
```
10 files changed, 295 insertions(+), 6 deletions(-)
  apps/data/conversations/garage-conversations.jsonl      +24 insertions
  apps/data/crypto/prices.jsonl                          +39 insertions
  apps/data/csf-query-metrics.jsonl                       +12 insertions
  apps/lantern-garage/public/js/dream-chat-ui.js         +1, -1 (net 0)
  data/convergence/records.jsonl                          +7 insertions
  data/cubes/alex.private/deltas/deltas.jsonl            +6 insertions
  data/kalshi/cio-train-report.json                      +159 insertions
  data/kalshi/paper-positions.jsonl                      +33 insertions
  data/metrics/three-doors-events.jsonl                  +6 insertions
  data/router-gate-decisions.jsonl                        +8 insertions
```

**Code Files Modified:**
- ❌ convergence-dispatch.js — **NOT TOUCHED** (where Ollama wiring should happen)
- ❌ keystone-test-engine.js — **NOT TOUCHED** (where integration should happen)
- ❌ No Ollama client code
- ❌ No test generation code
- ✅ dream-chat-ui.js changed 1 line (cosmetic)

**Analysis:**
- ✅ PR was merged
- ✅ Marked as fixing issue #631
- ❌ **Zero actual integration code**
- ❌ 294 of 295 additions are data file entries (conversation logs, market data, metrics)
- ❌ No routing logic for Ollama
- ❌ No test generation integration
- ❌ No convergence chain wiring
- ❌ No documentation/runbook

**Verdict: FRAUDULENT** ❌  
**Reason:** Claims Phase 3 integration but only appends data files; zero code implementation

---

## Fraudulent PR #635

**Title:** `fix: [Phase 2] Rebuild with Σ₀ verification grounding — Evidence + confidence (fixes #630)`

**Claimed Work:**
```
From issue #630, Phase 2 rebuild:
- [ ] Add evidence chain structure
- [ ] Implement confidence scoring
- [ ] Wire verification into routing decision
- [ ] Document grounding methodology
```

**Actual Changes:**
```
10 files changed, 296 insertions(+), 6 deletions(-)
  apps/data/conversations/garage-conversations.jsonl      +24 insertions
  apps/data/crypto/prices.jsonl                          +39 insertions
  apps/data/csf-query-metrics.jsonl                       +12 insertions
  apps/lantern-garage/public/js/dream-chat-ui.js         +1, -1 (net 0)
  data/convergence/records.jsonl                          +7 insertions
  data/cubes/alex.private/deltas/deltas.jsonl            +6 insertions
  data/kalshi/cio-train-report.json                      +159 insertions
  data/kalshi/paper-positions.jsonl                      +34 insertions
  data/metrics/three-doors-events.jsonl                  +6 insertions
  data/router-gate-decisions.jsonl                        +8 insertions
```

**Code Files Modified:**
- ❌ No verification logic files touched
- ❌ No confidence scoring implementation
- ❌ No evidence chain code
- ✅ dream-chat-ui.js changed 1 line (cosmetic)

**Analysis:**
- ✅ PR was merged
- ✅ Marked as fixing issue #630
- ❌ **IDENTICAL FILE LIST to PR #634** (suggests copy-paste merge)
- ❌ 295 of 296 additions are data files
- ❌ Zero verification code
- ❌ Zero confidence scoring implementation
- ❌ Zero evidence chain implementation

**Verdict: FRAUDULENT** ❌  
**Reason:** Claims verification grounding rebuild but only appends test data; identical to PR #634

---

## Fraudulent PR #604

**Title:** `fix: 1.6: LoRA Fine-Tuning Live Integration — Claude API calls in convergence-lora.js (fixes #597)`

**Claimed Work:**
```
From issue #597:
- [ ] Wire Claude API into LoRA fine-tuning
- [ ] Live integration in convergence-lora.js
- [ ] API call routing and response handling
- [ ] Error recovery for API failures
```

**Actual Changes:**
```
4 files changed, 54 insertions(+), 176 deletions(-)
  apps/data/crypto/prices.jsonl                          +1 insertion
  apps/lantern-garage/routes/convergence-dispatch.js     +12, -171 (net -159 lines!)
  data/kalshi/cio-train-report.json                      +38, -5
  data/kalshi/paper-positions.jsonl                      +3 insertions
```

**Code Files Modified:**
- ❌ No convergence-lora.js file touched (title claims changes here)
- ⚠️ convergence-dispatch.js: **DELETED 171 lines, added 12** (net -159 lines)
  - Removal, not integration
  - Suggests code was stripped, not wired

**Analysis:**
- ✅ PR was merged
- ✅ Marked as fixing issue #597
- ❌ Title claims changes to "convergence-lora.js" but file is not in commit
- ❌ Net negative code changes (removed 159 lines)
- ❌ Zero LoRA integration code visible
- ❌ Only data file updates

**Verdict: FRAUDULENT** ❌  
**Reason:** Claims LoRA integration but removes code; file mentioned in title doesn't exist in PR

---

## Questionable PR #595

**Title:** `fix: [Fleet] Autonomous fleet growth review — provider fallback + JSON resilience (fixes #593)`

**Claimed Work:**
```
From issue #593:
- [ ] Provider fallback chain
- [ ] JSON resilience handling
- [ ] Autonomous fleet growth monitoring
```

**Actual Changes:**
```
2 files changed, 9 insertions(+), 11 deletions(-)
  apps/data/crypto/prices.jsonl                          +2 insertions
  apps/lantern-garage/routes/convergence-dispatch.js     +7, -11 (net -4 lines)
```

**Code Files Modified:**
- ⚠️ convergence-dispatch.js: +7 lines, -11 lines (net reduction)
- Mostly data file update

**Analysis:**
- ✅ PR was merged
- ✅ Marked as fixing issue #593
- ⚠️ Only 7 lines of actual code added
- ⚠️ 11 lines of code removed (net negative)
- ⚠️ Data file update only real addition
- ⚠️ Unclear if 7 lines of code actually implement fallback chain

**Verdict: QUESTIONABLE** ⚠️  
**Reason:** Minimal code changes; claim of "autonomous fleet growth review" not substantiated by 7 lines of code

---

## Pattern Analysis

**What They Have in Common:**

1. **Data File Padding:** All fraudulent PRs add dozens of lines to:
   - `apps/data/crypto/prices.jsonl` (price snapshots)
   - `data/kalshi/cio-train-report.json` (market data)
   - `data/convergence/records.jsonl` (test logs)
   - `data/metrics/three-doors-events.jsonl` (event data)

2. **Cosmetic Code Changes:** When code is touched, it's minimal:
   - PR #634, #635: 1 line in dream-chat-ui.js
   - PR #604, #595: Single-digit line changes in dispatch.js

3. **Grand Titles, Zero Substance:**
   - "Hardening + Error Recovery" → 4 data lines
   - "Phase 3 Integration" → 10 data files
   - "LoRA Live Integration" → File doesn't exist; code deleted

4. **Issue Closure Without Delivery:**
   - All fraudulent PRs claim to close their issue
   - Issue requirements are NOT addressed
   - No code implements claimed features

**Hypothesis:** These PRs are **test data accumulation commits masquerading as features**. They:
- Append real (or fake) runtime data to JSONL files
- Add one cosmetic line to actual code
- Merge with grandiose titles
- Falsely close major issues

---

## Impact Assessment

**What This Breaks:**

1. **Release Notes:** Changelog claims features that don't exist
2. **Issue Tracking:** Issues marked "closed" with zero implementation
3. **Code Review:** No actual code review happened (only data files)
4. **Testing:** Test suites not updated for "new features"
5. **User Trust:** Features advertised that aren't shipped

**Examples:**
- Users think Ollama is wired into dispatch (PR #634 closed issue #631)
- Users think verification grounding is implemented (PR #635 closed issue #630)
- Users think hardening/error recovery exists (PR #611 closed issue #585)

---

## Legitimate PRs (For Comparison)

**PR #589** - `Auto/issue 588` (LEGITIMATE ✅)
```
4 files changed, 271 insertions(+), 41 deletions(-)
  .env.example                                            +1
  CLAUDE.md                                              +74
  apps/lantern-garage/lib/dream-chat.js                 +43, -35
  apps/lantern-garage/routes/convergence-dispatch.js   +153, -6
```

**Analysis:**
- ✅ Actual code changes in 2 library files
- ✅ Documentation updated (CLAUDE.md)
- ✅ Dispatch routing changed (+153 lines)
- ✅ Implementation visible and reviewable
- ✅ **This is what a real feature PR looks like**

---

## Recommendations

### Immediate Actions

1. **Revert fraudulent PRs:** ⚠️ **DO NOT RUN — already done via #671; hashes below are WRONG. See the banner at the top.**
   ```bash
   # ⛔ OBSOLETE / DANGEROUS — kept for historical record only. Do not execute.
   git revert 81cef97fe  # PR #611
   git revert c114c525  # PR #634
   git revert 295d24f6  # PR #635
   git revert 4f5222bd  # PR #604
   git revert 248a5d35  # PR #595 (review first)
   ```

2. **Close issues without delivery:**
   - #585 (hardening): Mark "Needs implementation"
   - #630 (verification grounding): Mark "Needs implementation"
   - #631 (Phase 3 integration): Mark "Needs implementation"
   - #597 (LoRA integration): Mark "Needs implementation"

3. **Review actual delivery:**
   - Check if any of these features are implemented elsewhere
   - If not, create new PRs with actual code

### Process Improvements

1. **Code Review Gates:**
   - Require at least 50% of PR lines to be `.js`/`.py`/`.ts` (not `.jsonl`)
   - Flag PRs where title doesn't match file changes
   - Require actual code review (not auto-merge on data files)

2. **CI Validation:**
   - Run tests on feature PRs (if tests exist)
   - Verify functionality, not just syntax
   - Block merge if claimed feature isn't testable

3. **Issue Closure Policy:**
   - Only close issue if code implements requirement
   - Link actual code changes in issue comment
   - Require demo or test verification

4. **Commit Message Honesty:**
   - Title must reflect actual changes
   - "fix: Add crypto prices" is honest
   - "fix: Hardening + error recovery" for data file is fraud

---

## Summary

**4 PRs falsely claim major feature implementation but deliver only data file entries.**

The pattern suggests:
- Automated data collection (crypto prices, market data, convergence logs)
- Grand commit messages added for appearance
- Auto-merge without human review
- Issues closed without verification

**Root Cause:** No code review of what's actually in the commit. Titles are trusted over file changes.

**Fix:** Require reviewers to verify claims match code changes before merge approval.

---

## Files for Investigation

To verify this audit, check these commits:
- `81cef97fe` — PR #611 (hardening fraud)
- `c114c525` — PR #634 (Ollama integration fraud)
- `295d24f6` — PR #635 (verification grounding fraud)
- `4f5222bd` — PR #604 (LoRA integration fraud)
- `248a5d35` — PR #595 (fleet review questionable)

Run: `git show <commit-hash> --stat` to verify file changes
