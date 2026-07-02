### Orchestration Control Center: panels no longer show a false "data unavailable"

On load the Control Center fired ~17 fetches at once, led by the work board's slow
sub-calls (PR lanes shell out to `gh` and hold a connection for seconds). The browser
caps ~6 connections per host and `AbortSignal.timeout()` counts queue time, so the light
one-shot panels behind them — provider reliance, agent merit, calibration, keystone-test
runs, rollover — timed out *while still queued* and, having no refresh interval, showed a
permanent false "data unavailable" / "No graded runs yet" until a manual reload, even
though every endpoint returned 200.

Fixed three ways: `fetchJson()` retries once on a thrown error (network/timeout/abort) after
a short backoff (idempotent GETs only; non-2xx still falls through without a retry); the
boot now requests the fast single-shot panels first and defers the heavy work board a tick
so it can't starve them of connection slots; and the page gains a proper top-level `<h1>`
(visually hidden) for accessibility. Verified in dev preview — panels populate reliably
across repeated reloads under a heavily loaded local server.

Also corrects stale "Lantern OS" branding in the `creator-intake.html` page title
(→ unisona.ai).
