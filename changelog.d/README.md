# changelog.d/ — conflict-free changelog fragments

Concurrent autonomous PRs used to collide on two single-file locks: the one
`"version"` line in `package.json` and the top of `CHANGELOG.MD`. Both are edited
by every code branch, so the auto-merge zipper could land only one PR before the
rest turned `CONFLICTING`.

This directory removes that lock. Instead of editing `CHANGELOG.MD`, each branch
drops **its own uniquely-named fragment file here**. Two branches never touch the
same file, so they never conflict. At release time `scripts/assemble-changelog.js`
folds every fragment into `CHANGELOG.MD` under a single new version and deletes
the consumed fragments.

## How to add a change record

Create one file per PR. Any unique name works; the convention is
`<issue-or-slug>.md`, optionally prefixed with a category so the assembler can
group it:

```
changelog.d/931-coder-training-loop.md
changelog.d/fix-rag-fallback.md
```

The file body is just the changelog bullets — **no `## [version]` header**, the
version is assigned at assembly time:

```md
### Fixed
- `_convergence_rag` now logs a fallback event instead of silently degrading (#919).
```

A leading `### Section` (Added / Fixed / Changed / Verify / Tests / Cleanup / …)
is optional; bullets with no section land under `### Changed`.

## Filename → category (optional)

If the filename starts with one of these prefixes followed by `-`, bullets with
no explicit `###` section inherit that category:

| Prefix     | Section        |
|------------|----------------|
| `feat-`    | `### Added`    |
| `fix-`     | `### Fixed`    |
| `change-`  | `### Changed`  |
| `verify-`  | `### Verify`   |
| `test-`    | `### Tests`    |
| `cleanup-` | `### Cleanup`  |

## Releasing

On `master`, fold all fragments into `CHANGELOG.MD` and bump the version once:

```
node scripts/assemble-changelog.js            # patch bump (default)
node scripts/assemble-changelog.js minor
```

Files named `README.md`, `.gitkeep`, or starting with `_` are ignored.
