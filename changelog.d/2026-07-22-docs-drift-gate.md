### Added

- ci(#2811): **docs-drift gate** — the mirror of the sprawl tripwire for *removed/renamed* surfaces. `scripts/check-docs-drift.mjs` scans the four canonical entry docs (README, CLAUDE.md, AGENTS.md, QUICKSTART.md) and fails when a `public/*.html` reference points at a page that no longer exists or is only a redirect stub, exempting lines explicitly marked as legacy (mention `legacy`/`redirect`/`renamed`/…, or an inline `<!-- drift-ok -->`). Wired into `pr-gates.yml` (`Markdown link integrity` job) beside the relative-link check, with `apps/lantern-garage/test/docs-drift-gate.test.js` validating the flag/exempt logic. Motivated by the chat.html rename (#2751), which left eleven stale `dream-chat.html` references across those docs for a week.

### Fixed

- docs(#2811): QUICKSTART's surface map pointed **Trader** at `/trader-dashboard.html`, which does not exist (no page, no route) — the new gate caught it. Repointed to `/stock-trader.html`, the live surface the home nav's "Trader" link uses.
