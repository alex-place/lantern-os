---
author: Alex Place
created: 2026-06-05
updated: 2026-06-20
---

# Keystone OS Dream Journal - Lightweight Deployment

## Quick Start (Dream Journal Only)

You now have a **lean, 229MB Docker image** for the Dream Journal skill. This replaces the massive 1.8GB+ unified container and eliminates PostgreSQL, Redis, and Audit API overhead.

### Start the Service

```powershell
# From lantern-os/ directory
docker-compose -f docker-compose.dream-journal.yml up -d
```

Service will run on `http://127.0.0.1:4177` (local) or `https://lantern-os.net` (public via Cloudflare Tunnel) with health check at `/health`.

---

## API Endpoints

### Log a Dream
```bash
curl -X POST http://127.0.0.1:4177/api/dream/chat \
  -H "Content-Type: application/json" \
  -d '{
    "content": "I was flying over a river with strange colors...",
    "lucidity": 0.65,
    "emotions": ["awe", "curiosity"],
    "tags": ["river", "flight", "surreal"],
    "linked_goals": ["lantern-revenue"]
  }'
```

### Get Recent Dreams
```bash
curl http://127.0.0.1:4177/api/dream/recent?limit=10
```

### Generate Mirror Prompt (for interpretation)
```bash
curl -X POST http://127.0.0.1:4177/api/dream/mirror-prompt \
  -H "Content-Type: application/json" \
  -d '{"dream_id": "dream_20260601_150000"}'
```

### View Statistics
```bash
curl http://127.0.0.1:4177/api/dream/stats
```

### Health Check
```bash
curl http://127.0.0.1:4177/health
```

---

## Resource Impact

| Metric | Old (Unified) | New (Dream Journal) |
|--------|---------------|-------------------|
| Image Size | 1.8GB | 229MB |
| Services | 5 (API, DB, Cache, Audit, Bot) | 1 (Journal API) |
| Memory (idle) | ~300MB | ~45MB |
| Startup Time | 30-45s | 2-3s |

---

## Cleanup Unused Docker Resources

Run the cleanup script to reclaim ~50GB from old containers and build cache:

```powershell
.\cleanup-docker.ps1
```

This removes:
- All exited containers
- Unused images (keeps only slim image)
- Build cache
- Dangling volumes

**Result:** Frees up 50+ GB of disk space.

---

## Storage

- Dreams stored in: `/app/data/dreams/dreams_YYYY-MM.jsonl` (append-only, one per month)
- Volume mounted to: `lantern-logs` (Docker volume)
- Data persists across restarts

---

## Next Steps

1. **Add more dream features:** Integrate with `lucid_dreaming` skill or `bayesian-world-model` for analysis
2. **Scale interpretation:** Feed mirror prompts to Grok, Claude, or local LLM via API
3. **Extend API:** Add endpoints for dream search, filtering by tags/emotions, or export
4. **Multi-user:** Extend to support per-user namespacing if needed

---

## Restart / Stop

```powershell
# Stop the service
docker-compose -f docker-compose.dream-journal.yml down

# Restart
docker-compose -f docker-compose.dream-journal.yml up -d

# View logs
docker-compose -f docker-compose.dream-journal.yml logs -f
```

---

## Debugging

### Chat Diagnostics
Inside the Dream Chat interface:
- Press **D** or click the **📊 button** (bottom-right) to toggle the analytics panel
- Type **!debug** in the chat input to toggle it without sending a message
- The panel shows session stats, latency, errors, fallbacks, and provider/agent state

### Service Won't Start
If the service won't start:

```powershell
# Check logs
docker logs lantern-dream-journal

# Verify container is running
docker ps | Select-String dream

# Exec into container
docker exec -it lantern-dream-journal /bin/sh
```
