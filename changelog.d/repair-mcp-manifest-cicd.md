### Repair CI: MCP tool-manifest parity tests no longer drift (fixes red master)

The `CI / Python tests` job was red on master: `tests/test_mcp_tool_parity.py` failed
because it (and the Node `tests/test_tool_capability_manifest.js`) pinned the tool
surface with **hand-maintained literal lists** that fell out of date the moment a tool
was added to the registry (`apps/lantern-garage/lib/tool-runner.js`). Three tools
(`system_status`, `recall_memory`, `export_document`) had been added but the golden
manifest and the test literals were never resynced.

Fix, aligned with the repo's own design (the committed
`manifests/tool-capability-manifest-v1.json` is the single source of truth, produced by
`node scripts/tool-runner-bridge.js generate-manifest`):

- **Regenerated the golden manifest** so it reflects the current 27-tool registry.
- **Both parity tests now assert the live surface matches the golden file** (by name)
  instead of a frozen literal, and the fallback-count check derives from the golden file
  too. Adding a tool now needs one deterministic step — regenerate + commit the manifest
  — and a forgotten regen fails loudly with a pointer to the command, rather than
  silently reddening every PR.

No production code changed; this is CI hygiene. Verified: `test_mcp_tool_parity.py` and
`test_tool_capability_manifest.js` both green, full pytest suite green.
