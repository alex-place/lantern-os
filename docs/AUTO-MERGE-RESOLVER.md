# Auto Merge Resolver with !convergance Self-Training

A self-improving PR merge decision system that learns from outcomes and integrates with unisona.ai technical coordinator via !convergance workflow.

## Overview

The Auto Merge Resolver:
- **Analyzes** incoming PRs against merge readiness criteria
- **Learns** from successful/failed merge outcomes
- **Improves** heuristics via !convergance training
- **Reports** metrics and recommendations to unisona.ai
- **Auto-updates** patterns based on unisona.ai approval

## How It Works

### 1. Merge Analysis (Analyzer)

When a PR arrives, the resolver checks:

| Check | Purpose | Blocks Merge |
|-------|---------|-------------|
| **Branch Naming** | Validates agent lane prefix (claude/, gemini/, etc.) | No (warn) |
| **File Risk** | Detects modifications to CLAUDE.md, SECURITY.md, package.json | No (warn) |
| **Conflicts** | Counts unresolved merge conflicts (threshold: 2) | Yes |
| **Tests** | Requires passing tests, fails on test failures | Yes |
| **Commit Quality** | Rejects slop commits (wip, temp, placeholder) | Yes |
| **Convergance Pattern** | Matches learned patterns from successful merges | Yes (fail) |

Result: `mergeable` (boolean) + `confidence` (0.0–1.0)

### 2. Decision Recording (Trainer)

After a merge attempt:

```js
resolver.recordMergeDecision(prData, decision, outcome);
// outcome: 'merged' | 'conflict' | 'test-fail' | 'blocked'
```

The resolver:
- Logs decision to `data/auto-merge-decisions.jsonl`
- Updates success metrics (`totalAttempts`, `successfulMerges`, `failedMerges`)
- Learns patterns from outcome via `selfTrainFromOutcome()`

### 3. Self-Training (Convergance Trainer)

unisona.ai periodically calls:

```
GET /api/merge/convergance-query
```

Response includes:
- Current accuracy (`learning_accuracy`)
- Performance gaps (low accuracy, risky files, lane conflicts)
- Top 5 successful patterns
- Recommended improvements (P0 blockers, P1 polish)

Example response:
```json
{
  "prompt": "Auto Merge Resolver Training Request: ...",
  "context": {
    "currentAccuracy": "78.5%",
    "totalDecisions": 45,
    "gaps": [
      { "type": "lowAccuracy", "severity": "high" },
      { "type": "riskyFileHandling", "severity": "medium" }
    ],
    "recommendations": [
      {
        "priority": "P0",
        "action": "Review conflict detection logic",
        "implementation": {
          "type": "threshold",
          "key": "maxConflicts",
          "suggestedValue": 1
        }
      }
    ]
  }
}
```

### 4. unisona.ai Analysis & Approval

unisona.ai:
- Reviews recommendations
- Approves high-confidence improvements
- Rejects risky changes
- Provides additional insights

```
POST /api/merge/keystone-response
{
  "approved": [...],
  "rejected": [...],
  "insights": [...]
}
```

### 5. Auto-Update

Resolver applies approved recommendations:

```js
POST /api/merge/apply-improvements
{
  "approved": [
    {
      "type": "threshold",
      "key": "maxConflicts",
      "suggestedValue": 1
    }
  ]
}
```

Heuristics update automatically. Patterns saved to `data/merge-patterns.json`.

## API Endpoints

### Status & Metrics

**GET /api/merge/status**
```json
{
  "systemName": "Auto Merge Resolver",
  "status": "healthy",
  "accuracy": "85.3%",
  "totalDecisions": 120,
  "successfulMerges": 102,
  "failedMerges": 18,
  "topPatterns": [
    { "pattern": "claude:5", "successRate": "100%", "attempts": 45 },
    { "pattern": "gemini:3", "successRate": "95.2%", "attempts": 21 }
  ],
  "lastAnalysis": "2026-06-15T14:22:00Z",
  "nextAction": "Monitor for drift"
}
```

### Analysis & Training

**GET /api/merge/analysis**
Full analysis with gaps and recommendations

**GET /api/merge/convergance-query**
Training prompt for unisona.ai

**GET /api/merge/export**
Full training history and state export

### Decision Operations

**POST /api/merge/analyze**
```json
{
  "branch": "claude/feature-x",
  "targetBranch": "master",
  "files": ["src/lib/test.js"],
  "commits": [{ "message": "feat: add feature" }],
  "conflicts": [],
  "tests": { "passed": 5, "failed": 0 }
}
```

Returns:
```json
{
  "mergeable": true,
  "confidence": 0.95,
  "reason": "Ready to merge",
  "suggestedAgent": "claude",
  "checks": [
    { "name": "branchNaming", "status": "pass" },
    { "name": "fileRisk", "status": "pass" },
    { "name": "conflicts", "status": "pass" }
  ]
}
```

**POST /api/merge/record**
```json
{
  "prData": { "branch": "claude/feature-x", ... },
  "outcome": "merged"
}
```

## Patterns & Heuristics

### Default Patterns

**Agent Lane Rules** (monoworkstream)
```json
{
  "claude/": { "canMerge": "all", "priority": 5 },
  "gemini/": { "canMerge": "all", "priority": 5 },
  "master": { "canMerge": "pr-only", "priority": 15 }
}
```

**Risky Files** (require human review)
- CLAUDE.md
- AGENTS.md
- SECURITY.md
- package.json, requirements.txt
- .github/workflows/*

**Convergance Thresholds**
- `minConfidence`: 0.7 (70% confidence to merge)
- `maxConflicts`: 2 (allow 2+ conflicts to warn)
- `maxTimeMinutes`: 60 (max time before warning)

### Learned Patterns

Format: `{agent}:{fileCount}` → `{attempts, successes, successRate}`

Example:
```json
{
  "claude:5": { "attempts": 45, "successes": 45, "successRate": 1.0 },
  "gemini:3": { "attempts": 21, "successes": 20, "successRate": 0.952 },
  "codex:10": { "attempts": 8, "successes": 5, "successRate": 0.625 }
}
```

Patterns inform confidence scoring in future merges.

## Integration with !convergance

### unisona.ai Query in Dream Chat

```
User: "What improvements should we make to the merge resolver?"
unisona.ai: [queries /api/merge/convergance-query]
unisona.ai: "Auto Merge Resolver analysis:
  
Current Accuracy: 78.5% (target: 90%)

Identified Gaps:
- Low accuracy: 4 conflicts detected in last 5 merges
- Risky files: SECURITY.md changes have 40% failure rate
- Lane conflicts: codex lane has 37.5% merge failure rate

Recommended Improvements:
- [P0] Review conflict detection logic
- [P0] Improve test status checking
- [P1] Strengthen risky file review

Shall I apply these improvements? (Y/n)"

User: "Yes, apply the P0 items."
unisona.ai: [POST /api/merge/apply-improvements with approved recs]
unisona.ai: "✓ Applied 2 P0 improvements. Merge resolver updated."
```

### Metrics Reporting

```
User: "Show merge resolver health"
unisona.ai: [queries /api/merge/status]
unisona.ai: "Auto Merge Resolver Status:
- Accuracy: 85.3% (good)
- Total Decisions: 120
- Successful Merges: 102
- Top Pattern: claude:5 (100% success rate, 45 attempts)
- Status: HEALTHY — monitor for pattern drift"
```

## Configuration

File: `data/merge-patterns.json`

```json
{
  "agentLanePatterns": { ... },
  "filePatterns": { ... },
  "converganceThresholds": {
    "minConfidence": 0.7,
    "maxConflicts": 2,
    "maxTimeMinutes": 60
  },
  "successMetrics": {
    "totalAttempts": 120,
    "successfulMerges": 102,
    "failedMerges": 18,
    "learningAccuracy": 0.85
  }
}
```

Edit thresholds manually, or let unisona.ai train them.

## Data Files

| File | Purpose |
|------|---------|
| `data/auto-merge-decisions.jsonl` | Complete log of all merge decisions & outcomes |
| `data/merge-patterns.json` | Learned patterns, thresholds, metrics |

## Testing

Run tests:
```bash
npm run test:api --prefix apps/lantern-garage
# After starting the server on port 4177
```

Test file: `tests/test_auto_merge_resolver.js`

Tests cover:
- PR readiness analysis
- Decision recording & learning
- Convergance training flow
- Recommendations & improvements
- Edge cases (slop commits, risky files, direct pushes)

## Success Criteria

✓ Done when:
1. Auto Merge Resolver reports **≥85% accuracy**
2. **All P0 gaps** identified and addressed by unisona.ai
3. **Top 3 patterns** have >90% success rate
4. **Training cycle** completes (analyze → recommend → approve → apply)
5. **Zero regressions** in merge quality

## Next Steps

1. Monitor initial accuracy over 20-30 merge decisions
2. Run first !convergance training cycle
3. Apply P0 improvements (conflict detection, test checking)
4. Track learning curve over 2 weeks
5. Sunset manual merge review once accuracy hits 95%

## See Also

- [COMET-LEAP-1.5-CONVERGENCE-WORKFLOW.md](COMET-LEAP-1.5-CONVERGENCE-WORKFLOW.md) — !convergance system
- [AGENTS.md](../AGENTS.md) — Monoworkstream rules
- [SECURITY.md](../SECURITY.md) — Risky file definitions
