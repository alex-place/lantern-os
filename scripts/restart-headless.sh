#!/usr/bin/env bash
# Lantern OS Headless Restart Script (Linux/macOS)
# Usage: ./scripts/restart-headless.sh
# Restarts all Lantern OS services in Docker containers.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "=== Lantern OS Headless Restart ==="

# 1. Check Docker
if ! command -v docker &>/dev/null; then
    echo "ERROR: Docker not found. Install Docker first."
    exit 1
fi
if ! docker compose version &>/dev/null; then
    echo "ERROR: docker compose not available."
    exit 1
fi

# 2. Ensure data directories exist
mkdir -p "$PROJECT_ROOT/data/archives" \
         "$PROJECT_ROOT/data/logs" \
         "$PROJECT_ROOT/assets/incoming"

# 3. Pull/build images and restart
echo "Building and starting services..."
cd "$PROJECT_ROOT"
docker compose -f docker-compose.headless.yml down --remove-orphans 2>/dev/null || true
docker compose -f docker-compose.headless.yml up -d --build

# 4. Health check
echo "Health checks..."
SERVICES=(lantern-csf lantern-cadd lantern-proxy)
MAX_WAIT=30
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
    ALL_HEALTHY=true
    for svc in "${SERVICES[@]}"; do
        STATUS=$(docker inspect --format='{{.State.Status}}' "$svc" 2>/dev/null || echo "missing")
        if [ "$STATUS" != "running" ]; then
            ALL_HEALTHY=false
        fi
    done
    if [ "$ALL_HEALTHY" = true ]; then
        break
    fi
    sleep 1
    WAITED=$((WAITED + 1))
done

# 5. Report
echo ""
echo "=== Status ==="
docker compose -f docker-compose.headless.yml ps

echo ""
echo "=== Endpoints ==="
echo "  Health: http://localhost/health"
echo "  CSF:    http://localhost/csf/"

echo ""
echo "=== Logs ==="
echo "  docker compose -f docker-compose.headless.yml logs -f"
echo ""
echo "Restart complete. No dashboards. No GUIs. Just APIs."
