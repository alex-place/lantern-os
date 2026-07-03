fix(chat,trade): theme-endpoint correctness + DoS caps on chat/trade backends

From an adversarially-verified app-gap audit, prioritized on the chat and trade surfaces:

- **fix(chat): `/api/ui/theme` was doubly broken.** `routes/ui.js` called
  `sendJson(res, status, data)` but the signature is `sendJson(res, data, status=200)` —
  so it returned the numeric status as the JSON body and the payload as the HTTP status.
  It also did `return sendJson(...)` (which returns `undefined`), reporting the route as
  unhandled and letting the server fall through (a double-send hazard the `responseClosed`
  guard was silently absorbing). Now returns a correct `{theme}` body + `return true`.
  The chat theme toggle persists again. Covered by `tests/test_ui_theme.js` (7 assertions).
- **fix(chat): cap request bodies on the convergence backend.** 8 handlers in
  `routes/convergence-dispatch.js` (grounding / route-intent / agent / route-task|market|code
  / …) read `req.on("data")` with no size limit — an unbounded-body OOM DoS on the chat
  reasoning/routing path. Added a 1 MB memory guard (destroy on overflow), matching the
  `collectRequestBody` cap the same file already uses elsewhere and the `profiles.js` fix
  from #1882. Verified: a >1 MB body drops the socket instead of accumulating.
- **fix(trade): cap external-service response reads.** `routes/trading.js` `callAITrader()`
  and `callDashboard()` accumulated the AI-trader / dashboard response body unbounded; a
  runaway or MITM'd local service could OOM the server. Added an 8 MB response cap
  (destroy + reject); the existing 10 s timeouts are unchanged.

Loop stage: Act / Verify (harden the surfaces users actually run). No behavior change for
normal-sized requests. Non-chat/trade audit gaps (dead nav links, unguarded upload/csf
endpoints, dormant C7 validation log, etc.) are tracked separately.
