#!/bin/bash
# Auto-version on push: update version.json with real-time build info
# Called from pre-push hook or CI

set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Generate version.json with real-time timestamp
VERSION=$(node -e "console.log(require('./package.json').version)")
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
COMMIT=$(git rev-parse --short HEAD)
BUILD_ID="${VERSION}+${NOW:0:10}.${NOW:11:8//:}"

mkdir -p .

cat > version.json <<EOF
{
  "version": "$VERSION",
  "buildId": "$BUILD_ID",
  "timestamp": "$NOW",
  "branch": "$BRANCH",
  "commit": "$COMMIT"
}
EOF

echo "✓ Version: $VERSION"
echo "✓ Build ID: $BUILD_ID"
echo "✓ Branch: $BRANCH"
echo "✓ Commit: $COMMIT"

# If not in CI, stage and commit
if [ -z "$CI" ]; then
  git add version.json
  git commit --amend --no-edit 2>/dev/null || true
fi
