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

Fixing the collection crash surfaced two more real failures that had been masked
by the INTERNALERROR (they never got to run):

3. **`test_dashboard_ux::test_markdown_links_use_formatted_reader`.** The home
   loop-mantra (#2335) linked each stage to a **raw** `/repo/docs/loop/*.md` URL;
   the test requires doc links to go through the formatted reader. Repointed the
   six links to `/view?path=docs/loop/*.md`.

4. **`test_mcp_tool_parity::test_node_bridge_manifest`.** The committed golden
   `manifests/tool-capability-manifest-v1.json` had drifted from the live tool
   registry (new tools added without regenerating it). Regenerated it via
   `node scripts/tool-runner-bridge.js generate-manifest`.

5. **`Site Audit` (a11y-audit workflow).** Fix (3) repointed the loop links to the
   `/view?path=…` reader route, but `scripts/audit-site.js` treated the URL as a
   literal public path and reported "FILE NOT FOUND" (it also never resolved the
   old `/repo/…` form). Taught `validatePageExists()` to resolve both the
   `/view?path=<rel>` reader route and `/repo/<rel>` against the repo root, so doc
   links validate against the real file.

Verified: `node scripts/lint-adr-registry.mjs` → OK; the full pytest suite runs
with no INTERNALERROR and the four previously-failing tests now pass (the two
collection/skip fixes plus these two). Improves **Verify** (CI reflects real state).
