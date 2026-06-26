### MCP `task_run`: pin a provider (e.g. Gemini) instead of always auto-routing

- `task_run` (and its `run_task` alias) now accept an optional `provider` arg ("gemini" / "claude" / "openai" / "grok" / "ollama"), forwarded to the streaming chat as the request `provider` so you can make a specific model work an issue through MCP / Claude Code. Empty = auto-route via the PCSF leaderboard (unchanged). The arg auto-appears in the MCP tool schema via signature introspection. `execute_task` is unchanged — it runs the local sandboxed Σ₀ coder, which has no cloud provider to pin. Fixes #1235.
