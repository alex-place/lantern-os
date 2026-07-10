fix(ci): stop the chronic Python-tests + ADR-lint red that blocked every PR

Two root causes made `CI / Python tests` and `PR Gates / ADR registry lint`
fail on **every** PR (the aggregate "All checks passed" gate inherited both):

1. **Python tests INTERNALERROR at collection.** `tests/test_mcp_mesh_tools.py`
   did a module-level `import server`, and `src/mcp_server/server.py` calls
   `sys.exit(1)` at import time when fastapi/uvicorn are absent (which they are in
   CI's lean Python job). `SystemExit` isn't an `ImportError`, so it crashed
   pytest **collection** and failed the whole suite — not just that module. Added
   `pytest.importorskip("fastapi")` at the top of the file (the same pattern the
   discord suites already use), so it skips cleanly when the server deps aren't
   installed instead of taking the run down.

2. **ADR registry lint status mismatch.** `docs/adr/README.md`'s index row for
   ADR-0010 said `Accepted (Alex Place, 2026-07-02)` while the ADR file's own
   frontmatter says `status: Proposed` (deliberately set in #2142 — agents can't
   self-approve and `approved-by` is still pending). Aligned the index row to the
   file's `Proposed` state (the non-fabricating direction). If ADR-0010 was in
   fact approved, flip both the file frontmatter and this row to `Accepted`.

Verified: `node scripts/lint-adr-registry.mjs` → OK; pytest collects all four MCP
test files with no INTERNALERROR; `tests/test_mcp_mesh_tools.py` still runs (3
passed) when fastapi is present. Improves **Verify** (CI reflects real state).
