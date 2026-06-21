---
author: Alex Place
created: 2026-06-05
updated: 2026-06-20
---

# Dream Journal API - Complete Endpoint Reference

## Base URL

**Local (Development):**
```
http://127.0.0.1:4177
```

**Public (Production via Cloudflare Tunnel):**
```
https://lantern-os.net
```

---

## Root Endpoint

### GET /
Returns service information and available endpoints.

**Request:**
```bash
curl http://127.0.0.1:4177/
```

**Response (200 OK):**
```json
{
  "service": "dream-journal",
  "status": "ready",
  "endpoints": [
    "/health",
    "/dreams/log",
    "/dreams/recent",
    "/dreams/mirror-prompt",
    "/dreams/stats",
    "/dreams/agent/mirror"
  ]
}
```

---

## Health & Status

### GET /health
Service health check. Used by Docker health checks and load balancers.

**Request:**
```bash
curl http://127.0.0.1:4177/health
```

**Response (200 OK):**
```json
{
  "status": "healthy",
  "service": "dream-journal"
}
```

**Use Cases:**
- Docker health checks (every 30s)
- Kubernetes liveness probes
- Load balancer health monitoring
- Service availability checks

---

## Dream Operations

### POST /dreams/log
Log a new dream to the journal.

**Request:**
```bash
curl -X POST http://127.0.0.1:4177/api/dream/chat \
  -H "Content-Type: application/json" \
  -d '{
    "content": "I was flying through clouds with strange music playing",
    "lucidity": 0.7,
    "emotions": ["wonder", "peace"],
    "tags": ["flight", "music", "sky"],
    "linked_goals": ["lantern-revenue"]
  }'
```

**Request Body Parameters:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | Yes | Dream narrative/description |
| `lucidity` | float | No | Lucidity score 0.0-1.0 (default: 0.5) |
| `emotions` | array | No | List of emotions experienced |
| `tags` | array | No | Symbolic tags/themes |
| `linked_goals` | array | No | Associated goals |
| `sfi_impact` | object | No | Meaning/Purpose/Character impact scores |

**Response (201 Created):**
```json
{
  "id": "dream_20260602_153757",
  "message": "Dream logged successfully"
}
```

**Error Response (400 Bad Request):**
```json
{
  "error": "Missing 'content' field"
}
```

**Performance:**
- Average: 51.62ms
- P95: 52.27ms
- Memory impact: +0.07MB per dream

---

### GET /dreams/recent
Retrieve recent dreams from the journal.

**Request:**
```bash
curl "http://127.0.0.1:4177/dreams/recent?limit=10"
```

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 10 | Number of recent dreams to retrieve (1-100) |

**Response (200 OK):**
```json
{
  "dreams": [
    {
      "id": "dream_20260602_153757",
      "timestamp": "2026-06-02T15:37:57.941015",
      "content": "Flying through clouds with music playing",
      "lucidity": 0.7,
      "emotions": ["wonder", "peace"],
      "tags": ["flight", "music", "sky"],
      "linked_goals": ["lantern-revenue"],
      "sfi_impact": {
        "meaning": 0,
        "purpose": 0,
        "character": 0
      }
    }
  ]
}
```

**Examples:**
```bash
# Get last 5 dreams
curl "http://127.0.0.1:4177/dreams/recent?limit=5"

# Get last 20 dreams
curl "http://127.0.0.1:4177/dreams/recent?limit=20"

# Get all dreams (no limit)
curl "http://127.0.0.1:4177/dreams/recent?limit=1000"
```

**Performance:**
- Average: 77.33ms
- P95: 195.49ms
- Scales linearly with dream count

---

### GET /dreams/<dream_id>
Retrieve a specific dream by ID.

**Request:**
```bash
curl "http://127.0.0.1:4177/dreams/dream_20260602_153757"
```

**Response (200 OK):**
```json
{
  "id": "dream_20260602_153757",
  "timestamp": "2026-06-02T15:37:57.941015",
  "content": "Flying through clouds with music playing",
  "lucidity": 0.7,
  "emotions": ["wonder", "peace"],
  "tags": ["flight", "music", "sky"],
  "linked_goals": ["lantern-revenue"],
  "sfi_impact": {
    "meaning": 0,
    "purpose": 0,
    "character": 0
  }
}
```

**Error Response (404 Not Found):**
```json
{
  "error": "Dream not found"
}
```

---

### POST /dreams/mirror-prompt
Generate an LLM interpretation prompt for a dream.

**Request:**
```bash
curl -X POST http://127.0.0.1:4177/dreams/mirror-prompt \
  -H "Content-Type: application/json" \
  -d '{
    "dream_id": "dream_20260602_153757"
  }'
```

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `dream_id` | string | Yes | ID of dream to interpret |

**Response (200 OK):**
```json
{
  "dream_id": "dream_20260602_153757",
  "prompt": "Interpret this dream with focus on personal growth and waking-life connection:\n\n**Dream Content:** Flying through clouds with music playing\n\n**Lucidity Score:** 0.7/1.0\n**Emotions:** wonder, peace\n**Tags/Symbols:** flight, music, sky\n**Linked Goals:** lantern-revenue\n\nPlease provide:\n1. Symbolic interpretation of key elements\n2. Connection to waking-life goals or challenges\n3. One actionable insight for personal development\n4. Lucidity-building practice suggestions (if applicable)\n\nUse concise, grounded analysis.",
  "model_suggestion": "Use with Claude, Grok, or local LLM"
}
```

**Usage with Claude/Grok:**
```bash
# Get prompt
PROMPT=$(curl -s -X POST http://127.0.0.1:4177/dreams/mirror-prompt \
  -H "Content-Type: application/json" \
  -d '{"dream_id": "dream_20260602_153757"}' | jq -r '.prompt')

# Send to Claude API
curl https://api.anthropic.com/v1/messages \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"claude-3-sonnet-20240229\", \"max_tokens\": 1024, \"messages\": [{\"role\": \"user\", \"content\": \"$PROMPT\"}]}"
```

**Performance:**
- Average: 32.65ms
- P95: 93.84ms

---

### GET /dreams/stats
Get statistics about the dream journal.

**Request:**
```bash
curl http://127.0.0.1:4177/dreams/stats
```

**Response (200 OK):**
```json
{
  "total_dreams": 51,
  "avg_lucidity": 0.72,
  "earliest": "2026-06-02T15:37:57.941015",
  "latest": "2026-06-02T20:05:06.123456"
}
```

**Use Cases:**
- Track lucidity trends over time
- Monitor dream frequency
- Integration with Bayesian World Model
- Progress tracking for lucid dreaming practice

**Performance:**
- Average: 21.58ms
- P95: 41.30ms

---

## Agent Endpoints

### POST /dreams/agent/mirror
Agent-runtime endpoint for local dream mirroring (requires Ollama/local agent).

**Request:**
```bash
curl -X POST http://127.0.0.1:4177/dreams/agent/mirror \
  -H "Content-Type: application/json" \
  -d '{
    "content": "I was flying through clouds with strange music playing"
  }'
```

**Request Body Options:**

Option 1 - Direct content:
```json
{
  "content": "Dream narrative here"
}
```

Option 2 - From dream ID:
```json
{
  "dream_id": "dream_20260602_153757"
}
```

Option 3 - Alternative field:
```json
{
  "text": "Dream narrative here"
}
```

**Response (200 OK - Agent Available):**
```json
{
  "reply": "Mirrored interpretation from agent",
  "source": "ollama/ollama:latest",
  "agent_runtime": "available",
  "held": false,
  "fallacies": ["confirmation_bias"],
  "recent_count": 5
}
```

**Response (503 Service Unavailable - Agent Held):**
```json
{
  "error": "Dream agent not available",
  "held": true
}
```

**Note:** Returns 503 if Ollama or local agent not available. Safe fallback - doesn't mock response.

---

## Complete Usage Examples

### Example 1: Log and Retrieve Dream

```bash
# 1. Log a dream
DREAM_ID=$(curl -s -X POST http://127.0.0.1:4177/dreams/log \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Exploring a crystal cave with bioluminescent creatures",
    "lucidity": 0.8,
    "emotions": ["wonder", "awe"],
    "tags": ["cave", "light", "creatures"],
    "linked_goals": ["personal-growth"]
  }' | jq -r '.id')

echo "Logged dream: $DREAM_ID"

# 2. Retrieve it
curl "http://127.0.0.1:4177/dreams/$DREAM_ID" | jq .

# 3. Get recent dreams
curl "http://127.0.0.1:4177/dreams/recent?limit=5" | jq .
```

### Example 2: Generate Interpretation

```bash
# 1. Get a recent dream
DREAM=$(curl -s "http://127.0.0.1:4177/dreams/recent?limit=1" | jq '.dreams[0]')

DREAM_ID=$(echo $DREAM | jq -r '.id')

# 2. Generate prompt
PROMPT=$(curl -s -X POST http://127.0.0.1:4177/dreams/mirror-prompt \
  -H "Content-Type: application/json" \
  -d "{\"dream_id\": \"$DREAM_ID\"}" | jq -r '.prompt')

# 3. Send to LLM
echo "$PROMPT"
```

### Example 3: Monitor Dream Progress

```bash
# Run every hour to track lucidity trends
curl http://127.0.0.1:4177/dreams/stats | jq '{
  total: .total_dreams,
  avg_lucidity: .avg_lucidity,
  date: now | strftime("%Y-%m-%d %H:%M:%S")
}'
```

### Example 4: Python Integration

```python
import requests
import json

BASE_URL = "http://127.0.0.1:4177"

# Log dream
dream_data = {
    "content": "Flying through digital landscapes",
    "lucidity": 0.75,
    "emotions": ["exhilaration", "curiosity"],
    "tags": ["flight", "digital"],
    "linked_goals": ["ai-mastery"]
}

response = requests.post(f"{BASE_URL}/dreams/log", json=dream_data)
dream_id = response.json()["id"]
print(f"Logged: {dream_id}")

# Get recent
response = requests.get(f"{BASE_URL}/dreams/recent?limit=10")
dreams = response.json()["dreams"]
print(f"Retrieved {len(dreams)} dreams")

# Get stats
response = requests.get(f"{BASE_URL}/dreams/stats")
stats = response.json()
print(f"Total: {stats['total_dreams']}, Avg Lucidity: {stats['avg_lucidity']}")

# Generate prompt
response = requests.post(f"{BASE_URL}/dreams/mirror-prompt", json={"dream_id": dream_id})
prompt = response.json()["prompt"]
print(f"Prompt:\n{prompt}")
```

---

## Error Handling

### Common Error Responses

**400 Bad Request - Missing Field:**
```json
{
  "error": "Missing 'content' field"
}
```

**404 Not Found:**
```json
{
  "error": "Dream not found"
}
```

**503 Service Unavailable (Agent):**
```json
{
  "error": "Dream agent not available",
  "held": true
}
```

---

## Performance Summary

| Endpoint | Method | Avg Time | P95 | Throughput |
|----------|--------|----------|-----|-----------|
| `/health` | GET | 12.66ms | 31.02ms | 79.2 req/s |
| `/dreams/log` | POST | 51.62ms | 52.27ms | 19.4 req/s |
| `/dreams/recent` | GET | 77.33ms | 195.49ms | 12.9 req/s |
| `/dreams/mirror-prompt` | POST | 32.65ms | 93.84ms | 30.6 req/s |
| `/dreams/stats` | GET | 21.58ms | 41.30ms | 46.3 req/s |
| `/dreams/agent/mirror` | POST | N/A (3rd-party) | N/A | Varies |

---

## Data Persistence

**Storage Format:** JSONL (JSON Lines)
**Location:** `/app/data/dreams/dreams_YYYY-MM.jsonl`
**Strategy:** Append-only, monthly files
**Persistence:** Docker volume `lantern-os_lantern-logs`

---

## Docker Container

**Image:** `lantern-os-dream-journal:latest`
**Port:** 5000 (exposed)
**Memory:** 22.31 MB (idle)
**Health Check:** GET /health (30s interval)

---

## Integration Points

### Agents
- Dream Logger Agent: `/dreams/log`
- Dream Analyzer Agent: `/dreams/mirror-prompt`
- Dream Retriever Agent: `/dreams/recent`
- Statistics Monitor: `/dreams/stats`
- Local Dreamer Agent: `/dreams/agent/mirror`

### External LLMs
- Claude: Use `/dreams/mirror-prompt` output
- Grok: Use `/dreams/mirror-prompt` output
- Ollama: Use `/dreams/agent/mirror` endpoint

### Skills
- `lucid_dreaming`: Consume `/dreams/stats` for trends
- `bayesian-world-model`: Consume `/dreams/stats` for evidence
- `dream_journal`: Core skill, all endpoints

---

## Rate Limiting

None configured (localhost). For production:
- Recommend 100 req/s per IP
- Health checks excluded from limits
- Agent endpoints soft-limited to 50 req/s

---

## Authentication

None (localhost only). For production:
- Add API key header validation
- Or use OAuth2/JWT tokens

---

## Swagger/OpenAPI

Currently documented via this guide. Future: Generate OpenAPI spec from Flask annotations.

