### Chat: delete the dream persona — Keystone is always a technical agent

- Chat **never** routes through the Python convergence/persona engine anymore (it answered in a dream voice — "…carries a wish. What are you protecting?" — and reported `provider:"unknown"`). All chat goes to the direct provider dispatch with the technical `ROUTER_PROMPT` (cloud coders lead, local is the offline backstop). Re-enable with `CONVERGENCE_CHAT=1`.
- `intent-router.js`: removed the `lantern` (dream) and `three_doors` capabilities; `fallbackRoute()` now answers as the technical `keystone` agent instead of the dream `lantern` persona.
- `ROUTER_PROMPT` stripped of dream/journal framing; the recent-journal "Background" block is no longer injected into chat prompts (it seeded poetic filler in weak local models).
- **Three-Doors / Kingdome of Hearts** removed from the UI: the Explore "Dreams & Stories" section and the dream-chat "Play game" starter chip are gone.
- Thinking indicator upgraded to a **larger mandala spinner** (44px).
