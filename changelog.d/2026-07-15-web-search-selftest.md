### Fixed

- The "Test" web-search check on the API-keys settings page no longer reports "Ready" when web search is broken. It hit `GET /api/web-search` (which returned 404) and never checked `resp.ok`, so any response — including that 404 — flipped the badge to "Ready / Web search OK". Added a real `GET /api/web-search?q=…` endpoint wired to the existing web-search client (MCP → direct/Wikipedia/news fallbacks), and made the self-test verify `resp.ok` and that results came back. Verified: a live search shows "Ready" with the result count and source; a 404 now shows "Error". (#2506)
