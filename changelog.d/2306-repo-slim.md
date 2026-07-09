chore(repo): slim tracked surface for agentic context (#2306 #2307 #2309 #2310 #2315)

Cut file-count and binary noise that bloats agent Glob/Grep/tree and clones:
- Untrack committed `apps/lantern-garage/payment-bridge/node_modules/` (174
  vendored files; `node_modules/` was already gitignored — force-added copy).
- Fold 463 `changelog.d/` fragments into CHANGELOG.md (they never folded at
  release); `.gitkeep` retained so new fragments keep landing there.
- Remove `docs/archive/` (38 stale 2026-06-19 docs; git history retains them).
- Delete dead `src/hff-api/app-legacy.py` — `safe_app:app` is the live WSGI
  entrypoint (per `wsgi.py`/`dashboard_app.py`); the legacy file (hyphenated,
  not importable) confused which entrypoint is authoritative.
- Untrack 14 volatile `data/csf_memory/raw/trace/*.json` runtime traces and
  gitignore the dir + root `agentic*` harness dumps.

Improves Reason/Act (agent context hygiene). Media (mp3/csf), runtime JSONL
logs, flat-RAG dumps, monolith splits, and root-md consolidation are tracked
separately (#2311-#2314, #2316-#2317) as they need R2 hosting or per-file care.
