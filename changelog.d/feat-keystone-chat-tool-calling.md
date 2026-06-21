### Added
- **Keystone chat tool-calling** — the dream-chat LLM path can now run a native
  Anthropic `tool_use` agentic loop (opt-in via `CHAT_TOOL_EXEC=1`), reusing the
  `lib/tool-runner` registry as the single source of truth for tool schemas and
  execution: `Read`/`LS`/`Glob`/`Grep` for everyone, `Bash`/`PowerShell`/`Write`/`Edit`
  for operators, each under the same per-tool policy + operator gate. The model loops
  (tool → result → reason) until it answers, bounded to 6 iterations; every call streams
  as a `type:"tool"` SSE event so there is no hidden agency. Off by default → normal chat
  is byte-identical.
- **Tool-call trace in the UI** — `dream-chat-ui.js` renders each native `type:"tool"`
  event as a card (🔧 name + pretty-printed args + result slot) in a full-width trace
  strip above the answer; ok results show `↳ …`, policy/operator denials show `⚠ …`. The
  strip lives on the message row so it survives the per-token bubble re-render.

### Fixed
- `lib/stream-chat/request.js` strips a leading UTF-8 BOM before `JSON.parse` (some
  clients — e.g. PowerShell `Out-File -Encoding utf8` — prepend one, which previously
  dropped the whole body to an empty message), and now surfaces an honest
  `bad_request_body` error for a present-but-unparseable body instead of the misleading
  "all providers failed / cloud unreachable".
