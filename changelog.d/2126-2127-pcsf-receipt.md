fix(chat): always show which model answered + confirm provider switches (#2126, #2127)

Live replies could render only `Unisona · chat · <time>` with no provider/model
signature, so the user couldn't tell which model produced the answer (#2126) — and
switching the provider dropdown gave no acknowledgement (#2127).

The provider/model receipt now renders on every model-served reply as a collapsed
`▸ debug` disclosure (e.g. `gemini/gemini-2.5-flash`). The verbose route internals
(swap chain + route reason) stay operator-only behind the debug toggle, so the
default stays clean (#1926) while the "which model" transparency is always available.
Selecting a provider now also flashes a brief "Switched to X — your next message will
use it" confirmation, and the next reply's receipt reflects the pinned model.

Verified in dev preview: a reply's `▸ debug` expander shows the serving model; the
picker toast appears on switch with the label updated.
