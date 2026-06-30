### Fixed
- **Auto-merge no longer wedged by deploy-preview infra** — the PR-watcher
  (`apps/lantern-garage/lib/pr-watcher.js`) now ignores Netlify/Vercel
  deploy-preview checks (`netlify/<site>/deploy-preview`, `Header rules - …`,
  `Pages changed - …`, `Redirect rules - …`, generic `*deploy-preview*`/`Vercel`)
  when deciding whether a PR is mergeable. These checks run **only on PRs**, so the
  existing base-branch self-heal (`_baseFailingChecks`, which scans `master`) could
  never neutralise them — a single Netlify "Deploy failed" outage therefore failed
  every PR identically and blocked the entire auto-merge zipper. They are deploy
  infra, not a code-quality gate, so a failed preview deploy must not gate a merge.
  Matched by pattern (the names carry a per-site slug); override with
  `PR_WATCHER_MERGE_IGNORE_PATTERNS`. Real, non-preview failures (e.g. the Debug
  statement check) still block. Improves the **Converge** stage. (+7 unit tests)
