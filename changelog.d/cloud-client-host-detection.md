fix(chat): make dream-chat work when served from a real cloud host, not just localhost

Two client-side assumptions broke Dream Chat on the cloud deploy (GCE VM behind
Cloudflare, e.g. unisona.ai):

- `dream-chat.js` computed `isStaticHost = hostname !== "127.0.0.1"`, so ANY real
  deploy was treated as a backend-less static host: the client pointed at
  `http://127.0.0.1:4177` (unreachable from a visitor) and showed a
  "Dream Chat requires the local server" banner. It now matches the rest of the
  codebase (`app.js`): only `file://` or `*.github.io` fall back to the local dev
  server; everywhere the Node backend serves the page, the API is same-origin.

- `dream-chat-ui.js`'s MCP connector (health check, connect, web-search test) all
  hit the operator's own `127.0.0.1:8772`, which on a hosted page is the visitor's
  machine. The connector is now gated behind `isLocalHost`: the card is hidden and
  the actions no-op with a "local-only" message on hosted deploys, while remaining
  fully functional on localhost.

Verified on the live cloud host: banner gone, `isStaticHost=false`, same-origin
`/api/agents` and `/version.json` return 200, and the MCP card is hidden.
