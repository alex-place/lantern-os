Added: `/settings.html` — a tabbed, two-column settings page carrying all of the
key config: **API keys** (all four provider key cards — save/test/clear against
the real `/api/providers/set-key` + `/api/providers/test/:id` endpoints, plus the
preferred-provider picker), **Connectors** (MCP server + web search checks), and
**Context** (web/CSF/trading context toggles). Tabs implement the WAI-ARIA tabs
pattern (ArrowLeft/Right/Home/End move selection + focus, hash deep-links
`#keys/#connectors/#context`); the two-column grid collapses to one column under
720px. The old single-column `/api-keys-settings.html` is retired via a 302 to
`/settings.html` (surface registry + explore/welcome links + the a11y test list
updated). Verified in a real browser signed in as the test account: tab
switching, keyboard nav, mobile collapse, and the server-key overlay all work;
`test:boundary` and `scripts/test-a11y.js` pass. (Improves Act — one settings
surface, no duplicate key pages.)
