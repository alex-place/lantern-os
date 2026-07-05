### 500s stop leaking raw exception text to clients (#2068)

`server.js`'s two central error handlers returned `{error: e.message}` straight to the
browser, leaking exception text (file paths, stack internals) to any user who tripped a
500. A new `sendServerError(res, err, context)` helper logs the full error + stack
server-side under a short `errorId` and returns only a generic
`{error: "Internal server error", errorId}` — the user can quote the id so an operator
finds the matching log line. Loop stage: **Act** (keep surfaces safe).
