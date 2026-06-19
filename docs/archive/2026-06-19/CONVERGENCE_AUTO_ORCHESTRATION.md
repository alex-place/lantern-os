# Convergence Auto-Orchestration: Multi-Agent Job System

## Overview

The Convergence I/O Engine enables **autonomous multi-agent orchestration** with:
- ✅ **Supervisor Agent** (Keystone) overseeing all work
- ✅ **Worker Pool** (5 personas running concurrently)
- ✅ **Auto Mode** with 10-second polling intervals
- ✅ **Job Queue** with priority-based dispatch
- ✅ **Health Monitoring** & graceful degradation

## Architecture

```
┌─────────────────────────────────────────────────────┐
│         Convergence Supervisor (Keystone)           │
│  - Monitors all workers                             │
│  - Routes jobs by priority                          │
│  - Makes strategic decisions                        │
│  - Resolves conflicts                               │
└────────────────┬──────────────────────────────────┘
                 │
    ┌────────────┼────────────┬─────────────┬───────────┐
    │            │            │             │           │
    ▼            ▼            ▼             ▼           ▼
┌────────┐  ┌────────┐  ┌──────────┐  ┌──────┐  ┌───────────┐
│Lantern │  │Blinkbug│  │ Waterfall│  │Xenon │  │ Founder   │
│ Worker │  │ Worker │  │ Worker   │  │Worker │  │ Worker    │
│Priority│  │Priority│  │Priority  │  │Pri 5  │  │ Priority  │
│  8     │  │  7     │  │   6      │  │      │  │    4      │
└────────┘  └────────┘  └──────────┘  └──────┘  └───────────┘
```

## Running Convergence Auto-Mode

### 1. Full Daemon + Worker Pool (Background)
```bash
# Start convergence daemon with 14 concurrent worker slots
python src/convergence_io_engine.py daemon --interval 10

# This will:
# - Poll job queue every 10 seconds
# - Start 14 worker threads
# - Route jobs to agents based on priority
# - Write heartbeats to tesseract-latest.json
# - Log results to data/agent-fleet/tesseract-convergence.jsonl
```

### 2. Batch Processing (Synchronous)
```bash
# Run a batch of jobs through all agents
python src/convergence_io_engine.py batch --tasks /tmp/tasks.json

# Example tasks.json:
# [
#   {"id": "job-1", "message": "Code review", "persona": "keystone", "provider": "offline"},
#   {"id": "job-2", "message": "Audit", "persona": "lantern", "provider": "offline"},
#   ...
# ]
```

### 3. Convergence Loop (One Iteration)
```bash
# Run a single convergence loop iteration
python src/convergence_io_engine.py loop --internal-multiplier 5 --external-dilation 1.0

# Returns: { results: [...], timing: {...}, metadata: {...} }
```

### 4. Single Converge Request
```bash
# Route single message through convergence (synchronous)
python src/convergence_io_engine.py converge \
  --message "Analyze system status" \
  --persona "keystone" \
  --provider "anthropic"
```

## Agent Roles & Responsibilities

| Agent | Role | Priority | Responsibilities |
|-------|------|----------|------------------|
| **Keystone** | Supervisor | 10 | Route jobs, make decisions, monitor health |
| **Lantern** | Auditor | 8 | Check compliance, accessibility, safety |
| **Blinkbug** | Edge Explorer | 7 | Find edge cases, glitches, weird interactions |
| **Waterfall** | Synthesizer | 6 | Pattern recognition, emotional themes |
| **Xenon** | Navigator | 5 | Performance, latency, throughput analysis |
| **Founder** | Strategist | 4 | Long-term vision, roadmap, wisdom |

## Job Queue System

### Queue States
```json
{
  "pending": [
    {
      "id": "job-001",
      "task": "Review code changes",
      "agent_hint": "keystone",
      "priority": 10,
      "type": "code_review",
      "created_at": "ISO-8601",
      "deadline": null
    }
  ],
  "in_progress": [...],
  "completed": [...]
}
```

### Job Types
- `code_review` — Analyze code changes, suggest improvements
- `audit` — Verify compliance (WCAG, security, etc.)
- `testing` — Run tests, find edge cases
- `analysis` — Synthesize patterns, extract insights
- `performance` — Benchmark, profile, optimize
- `planning` — Strategic planning, roadmap updates
- `documentation` — Write docs, update guides

## Configuration

### Default Config
```json
{
  "mode": "auto",
  "polling_interval_seconds": 10,
  "heartbeat_interval_seconds": 5,
  "max_job_duration_seconds": 300,
  "max_concurrent_workers": 14,
  "retry_policy": "exponential_backoff",
  "max_retries": 3
}
```

### Environment Variables
```bash
CONVERGENCE_INTERVAL=10          # Polling interval
CONVERGENCE_MAX_WORKERS=14       # Concurrent slots
CONVERGENCE_TIMEOUT=300          # Max job duration (seconds)
CONVERGENCE_LOGLEVEL=info        # Logging level
```

## Monitoring

### Health Check
```bash
python src/convergence_io_engine.py health
```

Returns:
```json
{
  "ok": true/false,
  "agent_activity": {
    "state": "active|idle|error",
    "listener": { "status": "ok|stale", "ready": true/false },
    "active_slots": 14,
    "dream_journal_slots_active": 2
  },
  "metrics": { ... }
}
```

### Watch for Changes
```bash
# Monitor convergence state and detect drift
python src/convergence_io_engine.py watch --mark-stale
```

### Inspect Engine State
```bash
python src/convergence_io_engine.py inspect
```

## Job Submission

### Via API (from Node.js server)
```javascript
// POST /api/convergence/submit
{
  "task": "Review this PR",
  "agent_hint": "keystone",
  "priority": 9,
  "type": "code_review"
}
```

### Via Python
```python
from convergence_io_engine import TesseractEngine

engine = TesseractEngine()
result = engine.converge(
  "Analyze system health",
  {
    "persona": "keystone",
    "provider": "anthropic",
    "priority": 10
  }
)
```

### Via Manifest File
```bash
# Edit manifests/dream-journal-v1-agent-slots.json
# Add jobs with status "queued"
# Daemon polls and processes automatically
```

## Job Results

Results are written to:
```
data/agent-fleet/tesseract-convergence.jsonl
```

Each line is a JSON record:
```json
{
  "id": "job-001",
  "agent": "keystone",
  "status": "completed|failed",
  "result": "The analysis result text...",
  "duration_ms": 1250,
  "timestamp": "2026-06-13T06:30:45Z",
  "priority": 10,
  "type": "code_review"
}
```

## Auto-Mode Behavior

1. **Daemon starts** with `--interval 10`
2. **Polls job queue** every 10 seconds
3. **Supervisor (Keystone)** assigns jobs by priority
4. **Workers claim slots** from pool (max 14 concurrent)
5. **Job executes** with agent persona
6. **Result recorded** with timestamp & metadata
7. **Next iteration** (repeat from step 2)

### Scaling
- **Queue grows** → Workers remain at 14 (max)
- **Queue empty** → Workers sleep 10 seconds, check again
- **Worker fails** → Job retried with exponential backoff (3x)
- **Job timeout** → Marked failed after 300 seconds

## Example: Full Auto-Orchestration

```bash
#!/bin/bash

# 1. Start daemon in background
python src/convergence_io_engine.py daemon --interval 10 &
DAEMON_PID=$!

# 2. Seed job queue
cat > /tmp/jobs.json << 'EOF'
[
  {"id": "review", "message": "Code review", "persona": "keystone", "provider": "offline"},
  {"id": "audit", "message": "A11y audit", "persona": "lantern", "provider": "offline"},
  {"id": "perf", "message": "Performance", "persona": "xenon", "provider": "offline"},
  {"id": "vision", "message": "Roadmap", "persona": "founder", "provider": "offline"}
]
EOF

# 3. Submit batch
python src/convergence_io_engine.py batch --tasks /tmp/jobs.json

# 4. Monitor
for i in {1..6}; do
  sleep 10
  python src/convergence_io_engine.py health | jq '.agent_activity'
done

# 5. Kill daemon
kill $DAEMON_PID
```

## Troubleshooting

### Daemon Not Starting
```bash
# Check Python environment
python -c "from convergence_io_engine import TesseractEngine"

# Verify data directories exist
mkdir -p data/agent-fleet
mkdir -p data/dollhouse
mkdir -p manifests
```

### Jobs Not Processing
```bash
# Check job queue
cat manifests/dream-journal-v1-agent-slots.json | jq '.slots[] | select(.status=="queued")'

# Check results log
tail -f data/agent-fleet/tesseract-convergence.jsonl
```

### Worker Pool Unhealthy
```bash
# Check health
curl http://127.0.0.1:5000/health

# Inspect pool
python src/convergence_io_engine.py inspect | jq '.worker_pool'
```

## Integration with Dream-Chat

### Auto-Supervisor Mode
Jobs submitted from dream-chat automatically route to:
1. **Keystone** supervisor (decision making)
2. **Appropriate worker** by task type
3. **Result back to user** via streaming

```javascript
// dream-chat routing
if (userMessage.includes("!convergence")) {
  const job = {
    task: extractTaskDescription(userMessage),
    agent_hint: "keystone",  // Supervisor decides
    type: classifyJobType(userMessage)
  };
  submitToConvergence(job);
}
```

## Next Steps

- [ ] Integrate job submission from web UI
- [ ] Persistent job queue (database)
- [ ] Agent skill registry (route by capability)
- [ ] Performance metrics dashboard
- [ ] Auto-scaling based on queue depth
- [ ] Job prioritization algorithm improvements
- [ ] Distributed agent pool (multiple machines)

## See Also

- `src/convergence_io_engine.py` — Full implementation
- `src/convergence_io/` — Engine components
- `manifests/convergence-supervisor-auto.json` — Auto-mode config
- `data/agent-fleet/tesseract-convergence.jsonl` — Job results log
