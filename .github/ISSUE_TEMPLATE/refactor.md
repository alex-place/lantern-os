---
name: Refactor / Cleanup
description: Track codebase restructuring, bloat trimming, or debt paydown
title: "[REFACTOR] "
labels: ["refactor", "context-window"]
---

## Refactor Request

**Target:** Which file, module, or pattern needs work?

**Current blob size (if applicable):** Run `cloc` or paste line count.

**Goal:** What should the structure look like after?

**Risk:** Could this break an API, a door, or a provider route?

**Acceptance Criteria:**
- [ ] Module extracted into `lib/`
- [ ] `server.js` imports the module
- [ ] Server starts without error
- [ ] Relevant endpoint tested manually or via script
- [ ] No regression in `/api/health`, `/api/dream/chat`, or `/api/agent/health`

**Context Window Impact:**
- Before: ___ lines in `server.js`
- After: ___ lines in `server.js`
