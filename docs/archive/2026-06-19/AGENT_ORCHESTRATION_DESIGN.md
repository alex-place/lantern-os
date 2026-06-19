# Agent Orchestration System — Design Spec

## Vision
Local Claude agents autonomously work on GitHub issues through git lanes. Dream-chat shows real work status, not discussions about work.

## Architecture

### 1. Agent Slots Configuration
**File:** `~/.claude/agent-slots.json`
```json
{
  "slots": [
    { "id": "claude", "prefix": "claude/", "maxConcurrent": 1, "model": "claude-opus-4-8" },
    { "id": "gemini", "prefix": "gemini/", "maxConcurrent": 1, "model": "gemini-pro" },
    { "id": "codex", "prefix": "codex/", "maxConcurrent": 1, "model": "codex" },
    { "id": "devin", "prefix": "devin/", "maxConcurrent": 1, "model": "devin" }
  ],
  "queuePath": "data/agent-work-queue",
  "maxRetries": 3,
  "heartbeatInterval": 30000,
  "workTimeout": 1800000
}
```

### 2. Work Queue System
**Location:** `data/agent-work-queue/`
- `pending.jsonl` — GitHub issues waiting for assignment
- `assigned.jsonl` — Currently being worked on
- `completed.jsonl` — Finished with results

**Queue Entry Format:**
```json
{
  "id": "issue-335",
  "issueNumber": 335,
  "title": "Phase 2: Stage Routing & Loop Tracking",
  "description": "...",
  "priority": 1,
  "assignedTo": "claude",
  "assignedAt": "2026-06-13T00:00:00Z",
  "status": "in_progress",
  "branch": "claude/issue-335",
  "targetDate": "2026-06-15",
  "retries": 0
}
```

### 3. Agent Worker Loop
Each agent lane runs:
1. **Poll Queue** (every 30s)
   - Check pending.jsonl for work
   - If available: lock and move to assigned.jsonl
   
2. **Prepare Worktree**
   - Create isolated git worktree
   - Checkout to branch (claude/issue-335)
   
3. **Execute Work**
   - Spawn Claude Code with issue context
   - Agent reads files, makes changes, commits
   - Runs tests if available
   
4. **Complete or Retry**
   - If success: PR created, moved to completed.jsonl
   - If failure: retry up to maxRetries, then mark failed

### 4. Dream-Chat Integration
**Endpoint:** `POST /api/dream/status/agents`
Returns:
```json
{
  "agents": [
    {
      "id": "claude",
      "status": "working",
      "currentIssue": 335,
      "progress": "60%",
      "branch": "claude/issue-335",
      "timeLeft": "15min"
    },
    {
      "id": "gemini", 
      "status": "idle",
      "nextAvailable": 335
    }
  ],
  "queue": {
    "pending": 8,
    "inProgress": 2,
    "completed": 5
  }
}
```

**Dream-Chat Response Format:**
When user asks "!convergence check" or "what's being worked on":
```
Claude lane: Issue #335 (Stage Routing) — 60% done, ETA 15min
Gemini lane: Ready for next issue
Codex lane: Idle
Queue status: 8 pending, 2 in progress, 5 completed this session
```

## Implementation Phases

### Phase 1: Queue System
- Create queue directory structure
- JSONL queue reader/writer
- Queue locking mechanism

### Phase 2: Agent Slot Manager
- Load/validate slots.json
- Heartbeat health checks
- Retry logic

### Phase 3: Work Dispatcher
- Poll pending queue
- Assign to available lanes
- Create worktree + branch

### Phase 4: Dream-Chat Bridge
- Status endpoint
- Integration with !convergence
- Real-time progress updates

### Phase 5: Agent Worker Loop
- Spawn and manage agent processes
- Handle completion/failure
- Create PRs automatically

## Key Features

1. **Monoworkstream Compliance**
   - Each agent gets its own branch prefix
   - One issue per agent at a time
   - Automatic branch naming (claude/issue-335)

2. **Self-Healing**
   - Retry failed work up to 3 times
   - Heartbeat monitoring
   - Stale work detection

3. **Real-Time Status**
   - Dream-chat shows actual work progress
   - Not text analysis, not discussions
   - Live queue monitoring

4. **Scalable**
   - Add agent lanes by editing slots.json
   - Automatic load balancing
   - Priority queue for high-value work

## Success Criteria

- [ ] User asks "what work needs to be done"
- [ ] Dream-chat responds with real agent status (not discussion)
- [ ] Agents autonomously work through GitHub issues
- [ ] No manual Claude Code invocation needed for issue work
- [ ] Each completed issue = 1 PR per lane
