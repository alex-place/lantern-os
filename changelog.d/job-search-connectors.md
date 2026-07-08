### Added — Job search in chat (real openings) + Indeed connector

- **`job_search` chat tool** (Observe/Act): the assistant searches LIVE job openings from
  real, keyless boards (Jobicy `geo=usa` + Remotive, US-eligibility filtered) and returns
  real apply URLs — never fabricated. Needs a title/keyword (asks if unknown), defaults to
  remote roles open to US applicants, supports a location/region. Works across all
  providers. Surfaced by a `🧭 Job search` starter chip that simply asks the assistant to
  find jobs (no popup) — the LLM does the search.
- **Indeed connector (Anthropic MCP-connector path)**: per-user OAuth 2.1 + PKCE against
  Indeed's official remote MCP server (`https://mcp.indeed.com/claude/mcp`) via Dynamic
  Client Registration; encrypted per-user token store; `/api/job/indeed/{status,connect,
  callback,disconnect}`. When a user has connected Indeed and the chat routes to Claude,
  `mcp_servers` + `mcp_toolset` + the `mcp-client-2025-11-20` beta header are injected so
  Claude searches real Indeed jobs on their behalf. Gated behind a valid token — normal
  chat is unchanged when nobody has connected Indeed. DCR + authorize-URL construction
  verified live; the interactive Indeed sign-in + live tool call are the user's step.
