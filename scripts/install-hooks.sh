#!/bin/bash
# Install git hooks for version/changelog validation and commit message formatting
# Usage: bash scripts/install-hooks.sh

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Handle both regular repos and git worktrees
if [ -d "$REPO_ROOT/.git" ]; then
    GIT_HOOKS_DIR="$REPO_ROOT/.git/hooks"
else
    # Worktree: .git is a file pointing to real location
    GIT_DIR=$(git rev-parse --git-dir)
    GIT_HOOKS_DIR="$GIT_DIR/hooks"
fi

echo "[*] Installing git hooks..."
echo "    Repo: $REPO_ROOT"
echo "    Git dir: $(git rev-parse --git-dir)"
echo "    Hooks dir: $GIT_HOOKS_DIR"

# Ensure hooks directory exists
mkdir -p "$GIT_HOOKS_DIR"

# Install pre-commit hook (comprehensive validation)
echo "[*] Installing pre-commit hook (comprehensive validation)..."
cp "$REPO_ROOT/scripts/hooks/pre-commit-full-validation" "$GIT_HOOKS_DIR/pre-commit"
chmod +x "$GIT_HOOKS_DIR/pre-commit"
echo "    [OK] pre-commit hook installed (version + deployment + autoupdate + agents)"

# Keep individual hooks available for standalone use
echo "[*] Installing individual validators as utilities..."
cp "$REPO_ROOT/scripts/hooks/pre-commit-version-changelog" "$GIT_HOOKS_DIR/pre-commit-version-changelog"
chmod +x "$GIT_HOOKS_DIR/pre-commit-version-changelog"
echo "    [OK] pre-commit-version-changelog utility installed"

# Install commit-msg hook (message format validation)
echo "[*] Installing commit-msg hook (message format)..."
cp "$REPO_ROOT/scripts/hooks/commit-msg-format" "$GIT_HOOKS_DIR/commit-msg"
chmod +x "$GIT_HOOKS_DIR/commit-msg"
echo "    [OK] commit-msg hook installed"

# Install post-merge hook (stale-branch warning)
echo "[*] Installing post-merge hook (staleness monitor)..."
cp "$REPO_ROOT/scripts/hooks/post-merge" "$GIT_HOOKS_DIR/post-merge"
chmod +x "$GIT_HOOKS_DIR/post-merge"
echo "    [OK] post-merge hook installed (warns when branches drift > 10 commits behind master)"

# Install pre-push hook (workstream + master protection + change-record gate)
echo "[*] Installing pre-push hook (workstream + change-record/version gate)..."
cp "$REPO_ROOT/scripts/hooks/pre-push" "$GIT_HOOKS_DIR/pre-push"
chmod +x "$GIT_HOOKS_DIR/pre-push"
echo "    [OK] pre-push hook installed (code-bearing branch must bump X.X.X + CHANGELOG entry)"

# Install prepare-commit-msg hook (optional template)
echo "[*] Creating prepare-commit-msg hook template..."
cat > "$GIT_HOOKS_DIR/prepare-commit-msg" << 'HOOK_SCRIPT'
#!/bin/bash
# Prepare-commit-msg hook: Add template to commit editor
# (Optional - removes template if user doesn't want it)

COMMIT_MSG_FILE="$1"
COMMIT_SOURCE="$2"

# Only show template for new commits (not amends, merges, etc)
if [ "$COMMIT_SOURCE" != "message" ] && [ "$COMMIT_SOURCE" != "squash" ]; then
    # Read current message
    CURRENT_MSG=$(cat "$COMMIT_MSG_FILE")

    # Only show template if message is empty or auto-generated
    if [ -z "$CURRENT_MSG" ] || echo "$CURRENT_MSG" | grep -q "^#"; then
        cat >> "$COMMIT_MSG_FILE" << 'TEMPLATE'

# Type(scope): subject — description
#
# Types: feat, fix, docs, refactor, perf, test, chore, ci
# Scopes: (optional) training, versioning, api, ui, router, etc.
#
# Examples:
#   feat(training): add Bayesian LR scheduling — auto-adapts learning rate based on plateau
#   fix(router): handle null intent classification
#   chore: bump version to v1.2.3
#   docs: update knowledge center with RAG house link
#
# Version/Changelog rules:
# - If code changed: version MUST be bumped
# - If version bumped: changelog MUST be updated
# - Changelog format: ## [x.y.z] - YYYY-MM-DD with Added/Fixed/Changed sections
TEMPLATE
    fi
fi

exit 0
HOOK_SCRIPT
chmod +x "$GIT_HOOKS_DIR/prepare-commit-msg"
echo "    [OK] prepare-commit-msg hook installed"

echo ""
echo "[OK] All hooks installed successfully"
echo ""
echo "[*] Hook behaviors:"
echo "    1. pre-commit (comprehensive):"
echo "       - Version/Changelog: code changes → version bump → changelog entry"
echo "       - Deployment: deployment.json valid, health checks exist, no breaking changes"
echo "       - Auto-update: update scripts, migrations, safe rollback paths"
echo "       - AGENTS.md: agent documented, runbook defined, capabilities listed"
echo "       - Skip individual: SKIP_VERSION_CHECK=1, SKIP_DEPLOY_CHECK=1, SKIP_UPDATE_CHECK=1, SKIP_AGENT_CHECK=1"
echo "       - Skip all (emergency): SKIP_ALL_CHECKS=1 git commit"
echo ""
echo "    2. commit-msg:"
echo "       - Enforces structured commit messages"
echo "       - Type(scope): subject format required"
echo "       - Min 8 chars subject, max 100 chars per line"
echo ""
echo "    3. prepare-commit-msg (optional):"
echo "       - Shows commit message template in editor"
echo "       - Can be edited or deleted if unwanted"
echo ""
echo "    4. pre-push (change-record + version gate):"
echo "       - Code-bearing branch must bump package.json to a NEW X.X.X version"
echo "       - ...and add a matching '## [X.X.X] - YYYY-MM-DD' CHANGELOG.MD entry"
echo "       - Compared against origin/master; docs/tests/data-only branches exempt"
echo "       - Also: master protection + per-agent workstream gate + staleness block"
echo "       - Skip: SKIP_VERSION_CHECK=1 (or SKIP_MONOWORKSTREAM=1) git push"
echo ""
echo "[*] To manually run individual validations:"
echo "    python3 scripts/validate-version-changelog.py        # pre-commit (staged)"
echo "    python3 scripts/validate-prepush-version-changelog.py # pre-push (vs origin/master)"
echo "    python3 scripts/validate-deployment-readiness.py"
echo "    python3 scripts/validate-autoupdate-safety.py"
echo "    python3 scripts/validate-agents-md.py"
echo ""
