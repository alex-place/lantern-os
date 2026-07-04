fix(chat): MCP-offline message stops telling end users to run `python src/mcp_server/server.py` (#1927)

`lib/keystone-context.js` injected the repo-command remedy into the model's
"Live project context" (which the model parroted verbatim — the injected-context
antipattern), and the `system_status` tool in `lib/tool-runner.js` returned it as
the DOWN message. Both now report the outage honestly and user-appropriately with
no terminal command. Covered by `test/chat-mcp-message.test.js` (2 checks).
Strengthens **Act** (honest status reporting). MCP-singleton auto-restart (#1402)
on the operator box remains a follow-up.
