# changelog.d — change fragments

Every code-bearing PR drops **one fragment file here** instead of editing
`CHANGELOG.MD` or bumping the version. That's the whole rule.

## Why

`CHANGELOG.MD` and `package.json` "version" are single files. When many PRs edit
them at once, every merge conflicts and every rebase re-conflicts (the churn).
A fragment is a **uniquely-named, timestamped file** — two PRs never touch the
same one, so there is nothing to conflict on.

## Add a fragment

```
node scripts/new-changelog.mjs "what changed and why"
node scripts/new-changelog.mjs "Fixed the stale badge" --kind fixed   # added | fixed | changed
```

This writes `changelog.d/<timestamp>-<slug>.md`, e.g.
`changelog.d/2026-07-11T20-15-30-123Z-honest-signal-badge.md`, containing:

```
### Changed

- what changed and why
```

Commit that file with your change. **No version bump. No `CHANGELOG.MD` edit.**
The pre-push gate only checks that a fragment exists; it never asks for a version.

## What happens at release

`node scripts/assemble-changelog.js` (run on `master` at release time) collects
every fragment, writes a single `## [X.X.X] - DATE` section from all of them,
bumps the version **once**, deletes the consumed fragments, and refreshes
`version.json`. That is the only place the version moves.
