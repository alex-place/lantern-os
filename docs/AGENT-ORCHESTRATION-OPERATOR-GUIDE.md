# Agent Orchestration — Operator Guide

Lantern OS ships a 5-phase autonomous agent orchestration system. This guide covers operation, monitoring, and troubleshooting.

---

## Architecture

```
GitHub Issues
     ↓
Queue Manager (data/agent-work-queue/)
     ↓
Work Dispatcher (picks idle slot, creates worktree)
     ↓
Agent Worker Loop (spawns claude CLI, commits, opens PR)
     ↓
/api/dream/status/agents  ←→  dream-chat !convergence
```

| Phase | Module | Purpose |
|-------|--------|---------|
| 1 | `src/queue-manager.js` | JSONL-style queue: pending → assigned → completed/failed |
| 2 | `src/agent-slot-manager.js` | Slot lifecycle, heartbeat, retry logic |
| 3 | `src/work-dispatcher.js` | Poll queue, claim slot, create isolated git worktree |
| 4 | `apps/lantern-garage/routes/agent-status.js` | `GET /api/dream/status/agents` live status |
| 5 | `src/agent-worker-loop.js` | Spawn agent, commit, push, open PR, complete entry |

---

## Slot Configuration

Edit `~/.claude/agent-slots.json`:

```json
{
  "version": "1.0",
  "slots": [
    {
      "id": "claude-1",
      "lane": "claude/",
      "label": "Claude Primary",
      "max_retries": 3,
      "heartbeat_interval_ms": 30000,
      "idle_timeout_ms": 300000,
      "enabled": true
    }
  ]
}
```

Each `lane` prefix maps to a git branch prefix (`claude/`, `gemini/`, `human/`). The monoworkstream gate ensures one open PR per lane at a time.

---

## Adding Work to the Queue

```js
const QueueManager = require('./src/queue-manager');
const q = new QueueManager('./data/agent-work-queue');

await q.enqueueWork({
  issueNumber: 361,
  title: 'Agent Orchestration Master: System Integration',
  lane: 'claude/',
});
```

Or from the convergence loop — it auto-seeds the queue from open GitHub issues on each run.

---

## Running the Worker Loop

```js
const { runLoop } = require('./src/agent-worker-loop');

// Process all pending work on the claude lane
const receipts = await runLoop('claude/', { keepWorktree: false });
console.log(`Processed ${receipts.length} issues`);
```

Each receipt contains:
- `entry` — the queue entry
- `steps` — per-step results (agent, commit, push, pr)
- `pr_url` — GitHub PR URL if created
- `ok` — overall success flag

---

## Monitoring

### Dream Chat

Type `!convergence` in dream-chat to see live agent fleet status:

```
claude lane: Issue #361 (Agent Orchestration Master) — working 4m
Queue: 2 pending · 1 working · 5 completed · 63% done
Next up:
  #369 Full Journal Archive
  #335 Stage Routing & Loop Tracking
```

### REST API

```
GET /api/dream/status/agents
```

Returns:
```json
{
  "text": "claude lane: Ready for work\nQueue: 2 pending · 0 working · 5 completed · 71% done",
  "slots": [...],
  "queue": { "pending": 2, "working": 0, "completed": 5, "total": 7, "pct": 71, "next": [...] }
}
```

### Ops Dashboard

Open `/ops.html` → **Agent Status** tab for live slot cards, queue stats, and work table.

---

## Monoworkstream Compliance

The monoworkstream gate (`scripts/hooks/pre-push`) ensures one open PR per agent lane. The worker loop respects this by:

1. Checking `gh pr list --repo alex-place/lantern-os --head <lane>/*` before dispatching
2. Only claiming work when the lane has no open PR

To bypass for testing: `SKIP_MONOWORKSTREAM=1 git push`

---

## Error Recovery

| Scenario | Behaviour |
|----------|-----------|
| Agent fails (exit ≠ 0) | Entry moves to `failed/`, slot resets to idle |
| Slot silent >5 min | `cleanupStale()` fails entry, resets slot |
| `claude` CLI not found | Worker skips agent step, logs warning, marks entry failed |
| Git push rejected | PR step skipped; entry completed with partial receipt |
| Max retries (3) exhausted | Slot moves to `failed` state; `resetSlot()` to recover |

To reset a failed slot:

```js
const AgentSlotManager = require('./src/agent-slot-manager');
const sm = new AgentSlotManager();
sm.resetSlot('claude-1');
```

---

## Tests

```bash
node tests/test_queue_manager.js        # 6 tests
node tests/test_agent_slot_manager.js   # 7 tests
node tests/test_work_dispatcher.js      # 13 tests
node tests/test_agent_status_route.js   # 16 tests
node tests/test_agent_worker_loop.js    # 10 tests
```

All 52 tests should pass on a clean checkout.

---

## Troubleshooting

**Queue shows pending work but nothing dispatches**
- Check `~/.claude/agent-slots.json` — all slots may be `enabled: false`
- Check slot status: `sm.getAllStatus()` — slots may be stuck in `working`
- Run `sm.cleanupStale()` to recover stale slots

**Agent spawned but no commits appear**
- Verify `claude` CLI is installed: `where claude` (Windows) / `which claude` (Linux)
- Check `AGENT_TIMEOUT_MS` env var (default 300000ms / 5 min)
- Worker loop logs step results in receipt — check `receipt.steps`

**PR gate blocks merges**
- Convergence gate is a warning, not a hard block (as of #375)
- Run `node scripts/convergence-manager.js` locally to see issues
