# Monoworkstream: One Open PR Per Agent Lane

## The Rule

**Each agent gets ONE open PR lane at a time.**

```
CORRECT: Agent opens PR #1 → PR #1 merges → Agent opens PR #2
WRONG:   Agent opens PR #1 → Agent opens PR #2 (blocked until #1 merges)
```

This is a hard rule enforced by Git hooks, GitHub Actions CI, and the auto-merge resolver.

---

## Why This Matters

### Problem It Solves

Without monoworkstream:
- Multiple PRs from same agent modify overlapping files → merge conflicts
- CI feedback becomes unclear (which PR caused the failure?)
- Auto-merge system can't decide which PR to merge first
- Manual intervention needed to resolve cascading conflicts

With monoworkstream:
- One PR per lane → no overlapping conflicts
- CI feedback applies to exactly one change
- Auto-merge can confidently merge when ready
- Faster iteration: merge → test feedback → next PR

### Real Example: The Crisis (2026-06-16)

5 PRs (#621, #625, #626, #627, #633) opened sequentially without waiting for merges:
- All branched from old master
- All modified same files (crypto prices, conversations, etc.)
- All had "CONFLICTING" status
- Zero could merge until oldest was fixed
- Manual rebasing + merge required

**Solution:** Monoworkstream rule + CI enforcement prevents this.

---

## Agent Lanes

Each agent prefix gets its own lane. Only one open PR per lane:

| Lane | Agent Prefix | Example Branch |
|------|--------------|-----------------|
| Claude | `claude/` | `claude/home-redesign`, `claude/fix-bug-123` |
| Gemini | `gemini/` | `gemini/add-feature`, `gemini/refactor` |
| Codex | `codex/` | `codex/new-endpoint`, `codex/optimize` |
| Devin | `devin/` | `devin/integration`, `devin/fix` |
| Grok | `grok/` | `grok/feature`, `grok/patch` |
| OpenAI | `openai/` | `openai/update`, `openai/enhancement` |
| Auto (Issues) | `auto/` | `auto/issue-505`, `auto/issue-506` |
| Human | everything else | `hotfix/x`, `main-fix`, `feature-xyz` |

**Multiple lanes can be open simultaneously** (one Claude PR + one Gemini PR = OK).  
**Multiple PRs in the same lane** (two Claude PRs open) = **BLOCKED**.

---

## Workflow: Do This

### Step 1: Check existing PRs in your lane

```bash
# See all open PRs from your lane
gh pr list --state open --search "head:claude/"

# If any exist, wait for them to merge before opening a new one
```

### Step 2: Create branch from master

```bash
git fetch origin master
git checkout -b claude/feature-name origin/master
```

### Step 3: Make changes, commit, push

```bash
# ... edit files ...
git commit -m "fix: Brief description (fixes #505)

Detailed explanation.

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"

git push -u origin claude/feature-name
```

### Step 4: Open PR

```bash
gh pr create --title "fix: Brief description (fixes #505)" \
  --body "Fixes #505"
```

### Step 5: Wait for CI, then auto-merge

- GitHub Actions runs monoworkstream gate (checks no other PRs from your lane)
- If you're the only PR in your lane, gates pass
- All other CI checks run (tests, lint, type checks)
- When all checks pass → **auto-merge with squash + branch deletion**

### Step 6: Next PR

Once your PR merges:
```bash
git fetch origin master
git checkout -b claude/next-feature origin/master
# ... repeat from Step 3 ...
```

---

## Workflow: Don't Do This

### ❌ Opening Multiple PRs Without Waiting

```bash
# BAD: Opens two Claude PRs
git checkout -b claude/feature-1 origin/master
# ... make changes, commit, push, open PR ...

git checkout -b claude/feature-2 origin/master
# ... make changes, commit, push, open PR ...
# CI BLOCKS THIS PR ❌ Monoworkstream violation
```

### ❌ Pushing to a Branch with an Open PR

```bash
# BAD: Your PR #123 is already open with changes
# Now you make more changes and push again
git push origin claude/feature-name
# This is OK (same branch, same PR)
```

Actually, pushing to a branch with an open PR is **fine** — it just updates that PR. The rule is about **separate PRs in the same lane**, not separate commits.

### ❌ Ignoring CI Feedback

```bash
# Your PR fails monoworkstream gate
# CI output: "Another PR from 'claude/' lane is already open: #123"
# Don't ignore this — wait for #123 to merge first
```

---

## Enforcement: How It Works

### Local (Pre-Commit Hook)

**File:** `scripts/Install-MonoworkstreamHooks.ps1`

Installed git hook warns you before committing:

```
⚠️  Warning: Branch 'claude/feature-2' already has an open PR (#123)
   Consider waiting for that PR to merge before opening a new one
```

This is **a warning, not a blocker** (you can override with `SKIP_MONOWORKSTREAM=1`).

### CI (GitHub Actions Gate)

**File:** `.github/workflows/pr-gates.yml`

Runs on every PR and **blocks merge** if violated:

```
❌ Monoworkstream violation — an agent lane has more than one open PR targeting master:
   lane claude: 2 PR(s)
   #123: fix: Feature A [claude/feature-1]
   #124: fix: Feature B [claude/feature-2]

Each agent prefix may keep only one open PR.
Merge or close the others before opening a new one in the same lane.
```

You cannot merge until the other PR from your lane closes or merges.

### Auto-Merge System

**File:** `apps/lantern-garage/lib/auto-merge-resolver.js`

Resolver checks monoworkstream in `checkConvergancePattern()`:

```javascript
if (hasOpenPR && targetBranch === 'master') {
  return {
    name: 'convergancePattern',
    status: 'fail',
    confidence: 0,
    detail: `${agent} lane already has open PR (monoworkstream rule)`,
  };
}
```

Even if all other checks pass, merge is blocked if lane already has an open PR.

---

## Common Scenarios

### Scenario 1: Your PR is ready, but another Claude PR is older

```
PR #100 (claude/feature-a) — 1 day old, all tests passing
PR #101 (claude/feature-b) — 1 hour old, all tests passing

Question: Which merges first?
Answer: PR #100 (older = higher priority in queue)
```

**The PR watcher** (`apps/lantern-garage/lib/pr-watcher.js`) merges oldest first. Don't open newer PRs until older ones merge.

### Scenario 2: You need to rebase your PR

```bash
# Your PR has merge conflicts with new changes in master
git fetch origin master
git rebase origin/master claude/feature-name

# Resolve conflicts...
git add .
git rebase --continue

# Force-push updated branch (updates existing PR)
git push -f origin claude/feature-name

# Same PR #123 gets updated, no monoworkstream violation
```

### Scenario 3: Another agent's PR is blocking master

```
PR #100 (gemini/feature-x) — Open and blocking master
PR #101 (claude/feature-y) — Your PR, waiting to be reviewed

Question: Can your PR merge?
Answer: No, not until #100 merges (only one per lane rule)
```

Each lane is independent. Wait for other lanes to clear if they're older.

### Scenario 4: Your PR failed CI, need to fix

```bash
# PR #123 (claude/feature) failed tests
git checkout claude/feature
# ... fix the bug ...
git commit -m "fix: Address test failure"
git push origin claude/feature

# CI re-runs, same PR #123, no monoworkstream issue
```

Pushing to an existing PR **doesn't** violate monoworkstream. Only opening a **second PR** from the same lane does.

---

## Exemptions

### Branches That Bypass Monoworkstream

| Branch | Reason | Merge Method |
|--------|--------|--------------|
| `master` | Long-lived | Direct push (requires `OVERRIDE_MERGE=1`) |
| `gh-pages` | Deploy branch | GitHub Action only |
| `dev` | Development | Open to multiple PRs |

These don't follow monoworkstream rules because they're not agent lanes.

---

## Recovery: If You Violate The Rule

### You Opened a Second PR by Mistake

```bash
# You have PR #123 open (claude/feature-1)
# You accidentally opened PR #124 (claude/feature-2)

# Option A: Close the newer PR and wait
gh pr close 124
# Wait for PR #123 to merge, then reopen #124

# Option B: Rebase #124 onto #123's branch (if related)
git fetch origin
git checkout claude/feature-2
git rebase claude/feature-1
git push -f origin claude/feature-2
# Update PR #124's description to reference PR #123

# Option C: Force PR #124 closed and re-open after #123 merges
gh pr close 124
# Once #123 merges:
git fetch origin master
git checkout -b claude/feature-2 origin/master
gh pr create ...
```

### CI Blocked Your PR

```
❌ CI Error: Monoworkstream gate failed
   Another PR from 'claude/' lane is already open: #123

# Wait for PR #123 to merge
# Check status:
gh pr view 123 --json mergeable,statusCheckRollup

# Once #123 merges, re-run CI on your PR
gh pr comment 125 --body "@github-actions rerun"
# Or push an update to your branch (triggers CI)
git commit --allow-empty -m "Trigger CI"
git push origin claude/feature
```

---

## Best Practices

### ✅ Do This

- **Plan ahead:** Know what you want to implement before opening a PR
- **Keep PRs small:** One logical change per PR = faster review + merge
- **Wait for feedback:** CI feedback teaches you what to fix next
- **Check before opening:** `gh pr list --state open --search "head:your-prefix/"`
- **Close old branches:** Delete old branches to keep the lane clear

### ❌ Don't Do This

- **Open PRs speculatively:** "I'll open 3 PRs and see which one goes first" = monoworkstream violation
- **Batch unrelated changes:** "Let me add auth + database + UI in one PR" = slower feedback
- **Push to master directly:** Always use PR, even for hotfixes (use `OVERRIDE_MERGE=1` if absolutely needed)
- **Ignore CI failures:** Fix the issue, don't open a new PR instead

---

## Troubleshooting

### Q: I opened PR #2, but CI says monoworkstream violation. What do I do?

**A:** You already have PR #1 open in your lane. Wait for PR #1 to merge, then PR #2 will automatically merge (assuming CI passes).

### Q: Can multiple agents have open PRs at the same time?

**A:** **Yes.** The rule is one PR **per lane**, not one PR total. Claude + Gemini + Codex can all have PRs open simultaneously.

### Q: I want to force-push changes to my existing PR. Is that OK?

**A:** **Yes.** Pushing to an existing branch **doesn't** violate monoworkstream. Only opening a **second PR** from the same lane does.

### Q: Can I use a different branch naming convention?

**A:** **No.** Branch names must match the agent prefix pattern:
- `claude/...` for Claude
- `gemini/...` for Gemini
- `auto/issue-XXX` for issues
- etc.

See [AGENTS.md](../AGENTS.md) for the full list.

### Q: I have PR #1 open (old, just waiting). Can I open PR #2 while #1 is waiting for review?

**A:** **No.** Close or merge #1 first. If #1 has been waiting >7 days, comment on it or close it if it's no longer relevant.

### Q: What if both my PR and a Gemini PR are blocked? Who goes first?

**A:** The **older PR** goes first (by creation time). PR watcher merges in queue order.

### Q: Can I bypass monoworkstream with an env var?

**A:** **For local commits:** `SKIP_MONOWORKSTREAM=1 git commit ...` (local warning only, CI still enforces).  
**For CI:** No. CI gate cannot be bypassed. The rule is enforced at merge time.

---

## Links

- **[AGENTS.md](../AGENTS.md)** — Full agent lane assignments
- **[CLAUDE.md](../CLAUDE.md)** — Agent-specific guidance
- **[.github/workflows/pr-gates.yml](../.github/workflows/pr-gates.yml)** — CI enforcement
- **[scripts/Install-MonoworkstreamHooks.ps1](../scripts/Install-MonoworkstreamHooks.ps1)** — Local hook setup
- **GitHub Issue #636** — Auto-merge crisis (example of violation)
- **GitHub Issue #638** — Monoworkstream enforcement implementation

---

## Summary

| What | When | Result |
|------|------|--------|
| Open PR in empty lane | Anytime | ✅ Merges when CI passes |
| Open 2nd PR in same lane | Blocked | ❌ CI fails until 1st PR merges |
| Push to existing PR | Anytime | ✅ Updates same PR, no violation |
| Rebase onto master | Anytime | ✅ OK (resolves conflicts) |
| Wait for older PR to merge | Always | ✅ Your PR merges next |

**One PR per lane, per agent. Simple.**
