### Orchestration: autowork research/grounding fixed + every step logged

- **The fleet path now actually researches.** `lib/auto-dispatch.js` calls the **non-stream** `POST /api/convergence/autonomous-work`, which used to call `generatePlan` with **empty scope and empty context** — the model patched blind (the #1 source of hunk-not-located aborts). It now runs the same grounding step as the SSE route.
- **"Research always returns 20 files" fixed.** Keyword extraction dropped stopwords (`this`/`with`/`test`/`error`/`file`…) that `git grep` matched in hundreds of files. New `lib/autowork-research.js` filters stopwords, ranks identifier-looking tokens, and scopes files via the symbol-aware `repo-context.searchRepoFiles` (relevance-ranked, bounded), with a git-grep fallback.
- **"0 web sources" fixed.** The old code hit DuckDuckGo's *Instant Answer* endpoint (`json.Results`, empty for ~every real query). Grounding now uses the dependable `lib/web-search-client.webSearch` (MCP → DuckDuckGo → Wikipedia).
- **Every step is logged and reviewable.** Both routes append each step (`research`/`plan`/`patch`/`test`/`commit`/`push`/`pr`/`done`, plus error exits) to `data/autowork-runs/<date>.jsonl` (gitignored). The fleet path previously emitted nothing.
- Tests: `node tests/test_autowork_research.js` (keyword filtering, bounded ranked scope, step logging).
