### Added
- **Fleet safety: protected-path auto-merge gate** (#1251) — the PR watcher no longer auto-merges a PR that touches a sensitive surface (auth, trading/money, secrets, `.github/workflows`, schema/migrations, `SECURITY.md`), even when green and reviewed. Such PRs wait for a human; docs/deps/UI keep auto-merging. Configurable via `PR_WATCHER_PROTECTED_PATHS`. Absorbed from GitHub Agentic Workflows ("agents propose, humans dispose").
- **Fleet safety: prompt-injection guard** (#1252) — the PR-review prompt now frames the PR title/description/diff as untrusted data to analyze, not instructions to obey, reinforcing the Σ₀ External Reality Rule.

### Changed
- **SECURITY.md** — new "Agent Safety Principles (absorbed from GitHub Agentic Workflows)" section tracking the five fleet safety rules (#1251–#1255) and their enforcement status.
