fix(chat): Gemini non-stream fallback list uses only Vertex-valid model ids

The non-stream Gemini path in `dream-chat.js` fell back onto retired ids
(`gemini-1.5-flash`, `gemini-2.0-flash`, `gemini-1.5-pro`) that all 404 on
Vertex. A valid but short reply from `gemini-2.5-flash` was discarded by a hard
`reply.length >= 20` gate, so the loop fell through to those dead models and
surfaced a misleading `gemini_status_404` from `gemini-1.5-pro` even though the
first model worked. Now: (1) the fallback list is `gemini-2.5-flash`,
`gemini-2.5-pro`, `gemini-2.5-flash-lite` (verified 200 on Vertex us-central1);
(2) any non-empty reply is accepted (short answers no longer discarded); (3) the
FIRST real provider error is preserved across the fallback loop, not the last
dead-model 404.
