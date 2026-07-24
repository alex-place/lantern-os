### Repo cleanup batch 2: remove legacy scaffolding, docker, Makefile, dead PR-watcher

Operator directive 2026-07-24. Removed (archived to F: with SHA-256 manifest + git history):
7 legacy top-level dirs (assets/brand, caad, config, manifests, models, research, surfaces);
the dead in-process PR-watcher (`lib/pr-watcher.js` + `routes/pr-review.js` + server wiring);
the old docker stack (deploy is gh-pages + Railway + GCE, not docker); the Windows-first Makefile
(replaced by `npm run` scripts); and dependent docker/deploy scripts + the surfaces-only CI
workflow. Fail-soft server reads verified (mesh→empty, status.js→defaults); all CI gates, model
registry, and markdown links patched. Windows scheduled-task removal is flagged for the operator
(several are live production). See docs/ARCHIVE-LEDGER.md.
