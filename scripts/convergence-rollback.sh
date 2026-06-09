#!/usr/bin/env bash
# convergence-rollback.sh
# Tag the last known good commit based on convergence receipts.
# Usage: ./scripts/convergence-rollback.sh [--dry-run] [repo_root]

set -euo pipefail

DRY_RUN=false
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    *) REPO_ROOT="$1"; shift ;;
  esac
done

EVIDENCE_DIR="$REPO_ROOT/manifests/evidence"

if [[ ! -d "$EVIDENCE_DIR" ]]; then
  echo "Warning: Evidence directory not found: $EVIDENCE_DIR" >&2
  exit 1
fi

# Find most recent promotion-ready receipt
LATEST_RECEIPT=$(find "$EVIDENCE_DIR" -name 'convergence-*.json' -type f -printf '%T@ %p\n' 2>/dev/null | \
  sort -n -r | head -1 | cut -d' ' -f2-)

if [[ -z "$LATEST_RECEIPT" ]]; then
  echo "No convergence receipts found." >&2
  exit 1
fi

# Check if promotion_ready
PROMO_READY=$(python3 -c "
import json, sys
try:
    d = json.load(open('$LATEST_RECEIPT'))
    print(d.get('promotion_ready', False))
except Exception:
    print('False')
" 2>/dev/null)

if [[ "$PROMO_READY" != "True" ]]; then
  echo "Latest receipt is not promotion-ready ($PROMO_READY)." >&2
  echo "Receipt: $LATEST_RECEIPT" >&2
  exit 1
fi

# Approximate commit from receipt mtime
RECEIPT_MTIME=$(stat -c '%Y' "$LATEST_RECEIPT" 2>/dev/null || stat -f '%m' "$LATEST_RECEIPT")
FORMATTED_TIME=$(date -d "@$RECEIPT_MTIME" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -r "$RECEIPT_MTIME" '+%Y-%m-%d %H:%M:%S')

SHA=$(git -C "$REPO_ROOT" log --oneline --no-decorate -1 --before="$FORMATTED_TIME" 2>/dev/null | awk '{print $1}')

if [[ -z "$SHA" ]]; then
  echo "Could not determine commit for receipt time." >&2
  exit 1
fi

TAG_NAME="convergence-good-$SHA"

echo "Convergence Rollback"
echo "Repo: $REPO_ROOT"
echo "Receipt: $(basename "$LATEST_RECEIPT")"
echo "Good commit: $SHA"
echo "Tag: $TAG_NAME"

if [[ "$DRY_RUN" == true ]]; then
  echo "[DRY RUN] Would tag $SHA as $TAG_NAME"
else
  git -C "$REPO_ROOT" tag -f "$TAG_NAME" "$SHA"
  echo "Tagged $SHA as $TAG_NAME"
  echo ""
  echo "Rollback commands:"
  echo "  git log --oneline ${TAG_NAME}~5..${TAG_NAME}"
  echo "  git checkout -b rollback-${SHA} ${TAG_NAME}"
  echo "  git reset --hard ${TAG_NAME}"
fi
