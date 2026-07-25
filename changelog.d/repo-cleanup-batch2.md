### Repo cleanup batch 2: remove legacy scaffolding, docker, Makefile, dead PR-watcher

Operator directive 2026-07-24. Removed (archived to F: with SHA-256 manifest + git history):
7 legacy top-level dirs (assets/brand, caad, config, manifests, models, research, surfaces);
the dead in-process PR-watcher (`lib/pr-watcher.js` + `routes/pr-review.js` + server wiring);
the old docker stack (deploy is gh-pages + Railway + GCE, not docker); the Windows-first Makefile
(replaced by `npm run` scripts); and dependent docker/deploy scripts + the surfaces-only CI
workflow. Fail-soft server reads verified (mesh→empty, status.js→defaults); all CI gates, model
registry, and markdown links patched. Windows scheduled-task removal is flagged for the operator
(several are live production). See docs/ARCHIVE-LEDGER.md.

**Batch 3 (same directive):** all 12 Windows scheduled tasks retired (XMLs archived; deletion
needs an elevated shell — commands in the session report). Cloudflare tunnel already sunset;
Discord lounge bot MIGRATED to alex-place/three-doors (PR #2 there) and fully deregistered here
(MCP curators, surface-registry, server spawn + shutdown, requirements, env, launchers);
arxiv-harvest and claude-session reaper are now on-demand SKILLS (.claude/skills/) instead of
scheduled tasks; all task-installer/autostart scripts removed.

**CI alignment (round 2):** stale tests removed with their removed subjects
(test_cloud_mirrors, test_mcp_tool_parity, test_account_link); the HTML-link gate now guards the
real product index (server-absolute hrefs mapped to public/, query-string routes skipped).
