feat(orchestration): consolidate the control center, delete the duplicate Ops Hub

Reworked `orchestration.html` into three labelled bands — *The loop, right now*
(Work Board · PR Lanes · Agent Slots · Auto-Pull · Manual Work), *Brain &
compute* (Local Model · Training · GPU Keys · AI Providers), and *How well it's
working* (Reliance · Calibration · Self-Test · Rollover · Repo Memory) — and
merged the four scattered provider panels down to two: **AI Providers** (keys +
fallback chains) and **AI Provider Reliance** (reliance + per-model chat
reliability). Fixed a boot-burst starvation bug where ~20 concurrent boot
fetches oversubscribed the browser's ~6-connection pool, so the light one-shot
analytics panels aborted *while queued* behind the gh-backed work-board calls
and — having no refresh interval — showed a permanent false "unavailable"; the
page now boots in concurrency-limited waves with a longer per-fetch timeout.
Added a **Manual Work** card to the profile Administration section beside the
existing Orchestration card. Deleted the duplicate `operations.html` dashboard
and its fully self-contained chain (the 3 `dashboard-*.js` files + the
`/api/system/overview` route), with every nav, surface-registry, feature-graph,
a11y, and doc reference cleaned up. Improves the Act stage (fleet control) and
cuts architectural sprawl; the surface-boundary contract test stays green.
