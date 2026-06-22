### Added
- Conflict-free changelog fragments (`changelog.d/`): concurrent autonomous PRs no
  longer collide on the single `CHANGELOG.MD` file or the `package.json` version
  line. Each branch drops a uniquely-named fragment; `scripts/assemble-changelog.js`
  folds them into `CHANGELOG.MD` and bumps the version **once** at release time.
  The pre-push and pre-commit change-record gates now accept a fragment in lieu of
  a version bump + changelog edit, so the auto-merge zipper can land independent
  PRs without serializing on a file lock.
