Anti-sprawl cleanup: removed the "life" extension module plus the orphaned
`memory-decay` demo — standalone personal-cockpit surfaces that sat beside the loop
without pulling their weight.

Deleted the five "life" surfaces — `preferences.html` (taste model, #1426),
`decisions.html` (#1436), `finance.html` (#1434), `health.html` (symptom journal, #1435),
`learn.html` (tutor, #1438) — plus their route handlers, lib backends, and unit tests;
dropped the `life` cluster from `lib/surface-registry.js`; unregistered the routes in
`server.js`; and removed the leftover `Taste` nav link from `dream-chat.html`.

Also removed `memory-decay.html` (confidence-decay demo, #1422) — a standalone toy page
no longer linked from the product nav — along with `routes/memory-decay.js`,
`lib/memory-decay.js`, `test/memory-decay.test.js`, and its core registry entry. The
Remember stage keeps four core surfaces (explore, knowledgecenter, rag-house, wide-search),
so no loop stage loses coverage and `test/surface-boundary.test.js` stays green.

Fixed a latent bug uncovered on the way out: `scripts/validate-deployment-readiness.py`
was probing the now-deleted symptom-journal `routes/health.js` as its "health endpoint"
check; repointed it at `routes/status.js`, which actually serves `/api/health`. (Converge)
