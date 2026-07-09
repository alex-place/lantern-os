Vision now spends only Vertex credits, chains providers by PCSF, and the screenshot
issue-reporter gains a "Try AI again" button + an always-available "Write it myself" option.

- **Gemini vision → Vertex only.** `lib/vision.js` routed Gemini through the AI-Studio
  endpoint (`generativelanguage.googleapis.com` + the depleted `GEMINI_API_KEY`), so
  screenshot auto-reports failed with "prepayment credits depleted" even though the chat
  already ran Gemini over Vertex. Vision now uses the same `lib/gemini-transport` wire, so
  when Vertex is configured (`GEMINI_USE_VERTEX=1` / `VERTEX_PROJECT`) it bills the funded
  Cloud project via ADC and never touches the AI-Studio key (#1232). Vertex needs an
  explicit `contents[].role` — added.
- **PCSF fallback chaining for vision.** Providers (anthropic / openai / gemini) are now
  ordered by the live PCSF leaderboard (`provider-router.orderChainByPcsf`) and chain to the
  next on any failure, so one depleted/down provider never kills image analysis. Gemini
  counts as available via Vertex ADC even with no API key (`providerHasKey` now exported and
  reused; `provider-order._dispatchHasKey` brought to parity).
- **Vertex-only chat gemini.** `stream-chat.js` gated the whole Gemini branch on
  `GEMINI_API_KEY`; it now also enters on a Vertex wire, so a key-less Vertex-only config
  still routes Gemini instead of skipping it.
- **Issue reporter UX.** The screenshot report modal now shows **↻ Try AI again** (re-run
  the AI report after a transient provider blip) and **✎ Write it myself** (edit/replace the
  AI report, or write your own even when vision is down) — the AI-unavailable path already
  required a typed description; this makes user-authored reports a first-class option.
