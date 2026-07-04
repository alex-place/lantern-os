### Fixed
- **Gemini non-stream chat no longer truncates code answers mid-sentence.** On
  `POST /api/dream/chat` with `provider:"gemini"`, gemini-2.5 spends part of
  `maxOutputTokens` on a hidden "thinking" phase, so the old 2048 cap (with no
  `thinkingConfig`) starved long answers — a "write a JSONL dedup function" prompt
  came back ending mid-docstring at `@param {string} filePath` with no function body
  (2026-07-03 gemini eval, `gemini-vertex:gemini-2.5-flash`). The Gemini branch in
  `lib/dream-chat.js` now sets `thinkingConfig.thinkingBudget:0` on thinking-capable
  models (2.5/3.x — the 1.5 fallbacks 400 on it) so the whole budget is visible
  output, raises `maxOutputTokens` to 4096, and joins all response text parts. Same
  prompt now returns a complete, `node --check`-valid function (`finishReason: STOP`).
  Improves the **Act** stage (reliable tool/model output).
- **Truncation is now visible instead of silent.** `dreamChatReply` surfaces the
  Gemini `finishReason` on its result (the `/api/dream/chat` route already spreads it
  into the JSON response) and logs a warning when a reply hits `MAX_TOKENS`.
- **Stream single-shot fallback given the same headroom.** The grounded single-shot
  path in `lib/stream-chat.js` was still capped at 1024 non-RP tokens; raised to 4096
  to match the tool-loop path so long code answers don't truncate there either.
