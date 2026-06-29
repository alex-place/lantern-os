fix(ci): repair red CI — regenerate the 19-tool capability manifest, sync the
`test_mcp_tool_parity.py` / `test_tool_capability_manifest.js` contract tests to
the real surface, and drop the stale `--ignore` excludes from ci.yml /
static-surface-ci.yml / orchestration-challenge-ci.yml so CI runs the full
`pytest tests` suite. README documents the tool-surface contract + regen command.
