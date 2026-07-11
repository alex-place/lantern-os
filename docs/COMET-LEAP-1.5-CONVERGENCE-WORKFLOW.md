# Comet Leap v1.5 Convergence Workflow

**Sprint:** 2026-06-15 to 2026-06-20  
**Target Version:** 1.5.0  
**Workflow:** Issue → unisona.ai Technical Coordinator → Implementation → Verification

## Quick Start

### 1. Access Dream Chat (unisona.ai Work Interface)
```
Browser: http://127.0.0.1:4177/dream-chat.html
Port 4177 = stable (master branch)
Port 4178 = dev preview (current branch)
```

### 2. Use !convergance to Route Issues
```
Message: !convergance
unisona.ai will:
1. Fetch open 1.5-release issues from GitHub
2. Classify each by priority (P0 > P1 > P2)
3. Suggest implementation order
4. Provide file paths and components to inspect
```

### 3. Example: Analyze Issue #456 (Security Fixes)
```
User: "Analyze issue #456 and propose implementation"
unisona.ai responds with:
- Issue summary (what problem/request)
- Concrete requirements
- File paths to inspect
- Risk assessment
- Implementation steps
- GitHub issue link
```

## The Convergence Flow

```
┌─────────────────────────────────────────────────────────┐
│ USER OPENS DREAM CHAT (unisona.ai Work Mode)              │
└────────────────────┬────────────────────────────────────┘
                     │
        ┌────────────▼────────────────┐
        │ Type: "!convergance"        │
        │ Or: "Analyze #456"          │
        │ Or: "What work is next?"    │
        └────────────┬────────────────┘
                     │
        ┌────────────▼────────────────┐
        │ unisona.ai Technical Coordinator
        │ - No dream doors/persona
        │ - Pure GitHub + code focus
        │ - Suggests file paths
        │ - Lists implementation steps
        └────────────┬────────────────┘
                     │
        ┌────────────▼────────────────────────────────────┐
        │ RESPONSE CONTAINS:                              │
        │ - Issue analysis (plain language)               │
        │ - Requirements & constraints                    │
        │ - File paths (apps/lantern-garage/lib/...)      │
        │ - Implementation steps                          │
        │ - Risk / blockers                               │
        │ - GitHub issue hyperlink                        │
        └────────────┬────────────────────────────────────┘
                     │
        ┌────────────▼─────────────────────┐
        │ OPERATOR TAKES ACTION:            │
        │ - Opens files in editor           │
        │ - Makes changes per unisona.ai plan │
        │ - Runs tests                      │
        │ - Creates PR / pushes to branch   │
        └────────────┬─────────────────────┘
                     │
        ┌────────────▼────────────────────┐
        │ FEEDBACK LOOP:                   │
        │ Return to chat with result       │
        │ "PR #480 created" / "Tests fail" │
        └────────────────────────────────┘
```

## Priority Triage (P0 → P1 → P2)

### P0: Critical Path (Must Close)
- **#456:** Security Fixes Sprint (XSS + input validation) — **FIRST**
- **#455:** Three-Doors Kingdome Integration (convergence loop)

### P1: High Priority (Should Close)
- **#460:** Performance Optimization (tab visibility + polling)
- **#462:** Documentation Sprint (API spec + architecture)
- **#452:** Convergence Router Deployment (token efficiency)

### P2: Medium Priority (Nice-to-Have)
- **#461:** UX Polish (counter format + cash check)
- **#459:** Event Handler Cleanup (duplicate listeners)
- **#454:** Token Audit Implementation
- **#453:** Hook Optimization
- **#451:** Kalshi Dashboard Integration

## Issue Routing Commands

### Analyze All 1.5 Issues
```
!convergance
```
unisona.ai will fetch and prioritize all issues tagged with `1.5-release`.

### Focus on Specific Issue
```
Analyze issue #456 and propose implementation
```
unisona.ai will:
- Fetch issue details from GitHub
- Understand the problem
- Inspect relevant code paths
- Suggest implementation steps

### Get Work Recommendation
```
What work should we tackle next?
```
unisona.ai will:
- Review open P0 and P1 issues
- Check code readiness
- Recommend highest-impact next step

## unisona.ai System Behavior

**Technical Focus:** unisona.ai does NOT include dream-journal elements, door suggestions, or persona flavor.

**Guaranteed in Response:**
- ✓ GitHub issue analysis
- ✓ File paths and line numbers
- ✓ Implementation steps
- ✓ Risk assessment
- ✓ Link to actual GitHub issue
- ✓ Clear next steps

**Explicitly Excluded:**
- ✗ Dream doors or suggestions
- ✗ Persona flavor or RP
- ✗ Emotional / narrative framing
- ✗ Speculation without evidence

## Verification

After unisona.ai routes an issue, verify:

### 1. File Access
```bash
cd apps/lantern-garage
# Check files unisona.ai mentioned
ls lib/dream-chat.js
grep -n "keystone" lib/dream-chat.js
```

### 2. Run Tests
```bash
npm run test:api --prefix apps/lantern-garage
python -m pytest tests/ -q
```

### 3. Check PR Status
```bash
gh pr list --state open --repo alex-place/lantern-os
# Verify PR for the issue is created
```

## Troubleshooting

### Server Not Responding
```bash
# Check if server is listening
netstat -ano | grep 4177

# Kill and restart
taskkill /F /IM node.exe
cd apps/lantern-garage && npm start
```

### unisona.ai Gives Vague Response
**Re-route with more context:**
```
"Analyze issue #456: What are the concrete XSS attack vectors we need to block?"
```

### Issue Takes Longer Than Expected
**Break it into subtasks:**
```
"For issue #456, what's the first file we need to modify?"
"What test cases would verify the XSS fix?"
```

## Sprint Success Criteria

✓ Sprint is complete when:
1. All P0 issues analyzed and PR status visible
2. unisona.ai responses verified: pure technical (no dream doors)
3. At least 5 issues moved from "open" to "in review" (PR created)
4. No test failures on master
5. v1.5.0 tag created

## Related Documentation

- **[CLAUDE.md](../CLAUDE.md)** — Agent workstream rules, per-agent lanes
- **[PROVIDERS.md](../PROVIDERS.md)** — LLM provider configuration
- **[unisona.ai Technical Refactor](./KEYSTONE-TECHNICAL-REFACTOR.md)** — System prompt details
- **[Sprint Plan](./data/sprints/COMET-LEAP-1.5-2026-06-20.md)** — Full sprint backlog
