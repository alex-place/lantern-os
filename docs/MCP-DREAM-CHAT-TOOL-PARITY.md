# MCP and Dream Chat tool parity

`apps/lantern-garage/lib/tool-runner.js` is the canonical source for shared
tool names, schemas, policies, execution, and receipt shape.

Dream Chat exposes the manifest at `GET /api/dream/tools` and executes tools
directly through that runner. MCP invokes `scripts/tool-runner-bridge.js`
through `src/mcp_server/shared_tool_bridge.py`; Python does not contain a
second schema or policy table.

There is no committed copy of the manifest: the generated fallback file
(`manifests/tool-capability-manifest-v1.json`) was removed in #2922, so MCP
discovery needs Node. `tests/test_tool_capability_manifest.js` checks that the
bridge's manifest matches the in-process one.

Shared tools:

- read: `Read`, `LS`, `Glob`, `Grep`, `web_search`, `web_fetch`
- operator-only shell: `Bash`, `PowerShell`
- operator-only mutation: `Write`, `Edit`

MCP `tools/list` includes the same manifest as `sharedToolManifest`. Each
shared tool carries `_meta.lantern.kind = shared_capability`. Queue, task,
fleet, GitHub, local-runner, and convergence tools remain available but are
labeled `mcp_specific_operational`.

## Gates

- `CHAT_TOOL_EXEC=1` enables execution on both surfaces. When absent, tools
  remain discoverable and return `status=unavailable` with
  `reason_code=chat_tool_exec_disabled`.
- `MCP_SHARED_TOOL_OPERATOR=1` authorizes operator-only tools for the MCP
  process. It is off by default.
- Repo sandboxing, the shared command allowlist, safe execution, and web-fetch
  private-host blocking remain authoritative in the Node runner.

Every result uses:

```json
{
  "status": "executed | denied | unavailable | blocked",
  "tool": "Read",
  "reason_code": null,
  "receipt": {
    "schema_version": 1
  }
}
```

The focused contract checks are:

```text
node tests/test_tool_capability_manifest.js
python -m pytest tests/test_mcp_tool_parity.py -q
```
