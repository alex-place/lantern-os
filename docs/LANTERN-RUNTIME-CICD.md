---
author: Alex Place
created: 2026-05-29
updated: 2026-06-20
---

# Lantern Runtime & CI/CD

## Purpose

This document covers the local and cloud runtime behavior, deployment gates, and CI/CD validation for Keystone OS Garage.

## Runtime Modes

### Local Runtime

**Command:** `npm run start:local` or `node server.js`

**Binding:** `127.0.0.1` (localhost only)

**Port:** `4177` (default) or `process.env.PORT`

**Access:** Browser on the same machine (Windows developer machine)

**Capabilities:** Full local access—all PowerShell actions, local file write, conversation history, dreamer journal append, flat RAG house generation.

**Use case:** Operator workstation, local dashboard, convergence loop triggering, operator notes, file preview.

---

### Cloud Runtime

**Command:** `npm run start:cloud` or `node cloud-server.js`

**Binding:** `0.0.0.0` (all interfaces)

**Port:** `8080` (always; set via `PORT` env var)

**Access:** Internet-facing (AWS ECS Fargate, Netlify, or other cloud platform)

**Capabilities:** Read-only surface + bounded write gates (chat, command, selected actions).

**Security headers:** X-Content-Type-Options, Referrer-Policy, X-Frame-Options, Permissions-Policy

**Use case:** Cloud deployment via AWS ECS Fargate, public dashboard mirror, remote monitoring, MCP bridge endpoint.

---

## Deployment Targets

### AWS ECS Fargate

**Configuration:**
- Docker image: `lantern-garage:latest` (built from `apps/lantern-garage/Dockerfile`)
- Container port: `8080`
- Memory: 512 MB (minimum recommended)
- CPU: 256 units (0.25 vCPU)
- Startup command: `npm run start:cloud`

**Health check:** `GET /api/health` → `{ ok: true }`

**Logs:** CloudWatch (aws logs group `/ecs/lantern-garage`)

**IAM role:** Minimal (CloudWatch logs only; no S3, Secrets Manager, or parameter access)

---

### Netlify Static Surface

**URL:** `https://lantern-os-cloud.netlify.app`

**Purpose:** Static dashboard mirror (HTML/CSS/JS only; no backend API)

**Fallback:** If cloud API unreachable, static mirror remains operational.

---

## CI/CD Workflow

### Static Surface CI

**File:** `.github/workflows/static-surface-ci.yml`

**Triggers:** Push to `master`, pull request to `master`, manual dispatch

**Jobs:**

1. **repo-surface** — Verify required files exist:
   - `surfaces/shareholder-index/index.html`
   - `surfaces/shareholder-index/styles.css`
   - README.md, AGENTS.md, docs/CONVERGENCE-LOOP.md

2. **manifests** — Check required manifest files:
   - `manifests/FOUNDRY-MATRIX-RAG-DOLLHOUSE.md`
   - `manifests/foundry-shareholder-repos.md`
   - `manifests/open-issues.md`
   - `dual-boot/SONS-PC-READINESS.md`

3. **html-links** — Validate all `href` links in shareholder-index resolve to real paths

4. **python-tests** — Run pytest suite:
   - Install: `pytest`, `pytest-asyncio`, `discord.py>=2.3.2`, `dpytest`
   - Command: `python -m pytest tests -q`

5. **workflow-shape** — Verify CI structure is correct

6. **summary** — Gate: all lanes must pass before merge

### AWS deploy gate

**Condition:** Triggered on successful CI completion, pull request merged to `master`

**Steps:**
1. Build Docker image from `apps/lantern-garage/Dockerfile`
2. Push to AWS ECR
3. Update ECS service with new image
4. Run smoke test: `curl https://<ecs-endpoint>/api/health`
5. Log results

**Rollback:** If health check fails after 30 seconds, roll back to previous image.

---

## Safety Rails

### Show the state. Say the limit. Self-correct before acting.

**Principle:** Every operator action is logged, bounded, and requires explicit confirmation.

**Examples:**
- `npm run start:local` checks port availability before binding
- Cloud runtime rejects write methods outside allowlist
- Operator notes append to JSONL (never overwrite)
- Conversation history is read-only until operator explicitly sends a message

### A door is a protocol boundary

**Principle:** Each endpoint is a protocol boundary. Requests and responses are validated and logged.

**Examples:**
- `/api/chat` accepts JSON, returns JSON with MCP routing info
- `/api/actions/local-controls` is cloud-forbidden (PowerShell not available)
- `/api/command` is cloud-rate-limited (max 5 per minute)

### Advisory, source-backed, operator-reviewed, and challengeable

**Principle:** No autonomous action without operator decision. All suggestions must be source-linked and challengeable. Evidence-driven recommendations are advisory, source-backed, operator-reviewed, and challengeable.

**Examples:**
- Flat RAG house is advisory (suggests next topics, not autonomous)
- Operator queue shows all pending tasks with priority and owner
- Conversation history is editable (operator can correct or redact)
- MCP tool invocation requires explicit operator choice

---

## Localhost-only Lantern chat surface

**Purpose:** The localhost-only Lantern chat surface (`http://127.0.0.1:4177`) is the primary control surface and must remain localhost-only.

**Why:** Prevents accidental remote execution, maintains operator veto, ensures all network traffic is loggable and inspectable.

**Exception:** Cloud mirror at `https://lantern-os-cloud.netlify.app` is read-only and cannot trigger local actions.

---

## Runtime Validation

### Local

```bash
npm run start:local
# Should output: "Lantern Garage running on port 4177"
# Should be accessible at http://127.0.0.1:4177
# Should have /api/health returning { ok: true, service: "lantern-garage" }
```

### Cloud

```bash
PORT=8080 npm run start:cloud
# Should output: "Lantern Garage (Cloud) running on port 8080"
# Should bind to 0.0.0.0:8080
# GET /api/health should return { ok: true, service: "lantern-garage-cloud" }
# POST to /api/conversati ons should be rejected with 403 cloud_read_only_method_not_allowed
```

### Syntax Check

```bash
npm run check
# Should validate both server.js and cloud-server.js with node --check
# Should exit with code 0 if both are syntactically valid
```

---

## Monitoring & Observability

**Health endpoint:** `GET /api/health`

**Status endpoint:** `GET /api/status` (includes wallet, arc reactor, readiness state)

**Logs:** Both runtimes output to stdout (captured by Docker/container platform)

**Do not re-add `render.yaml`**: The Render.com deployment config was retired in favor of AWS ECS Fargate. Do not restore it.

