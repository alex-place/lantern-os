### Fixed

- dream-chat: the assistant's own reply could be dropped from the send-history when a convergence-router reply carried action chips — `renderActionChips` was *called* at finalize but never *defined*, so a ReferenceError aborted finalize before the `history.push`, and on the next turn the model "forgot what it just said" (reproduced with Gemini Flash). Implemented `renderActionChips`, and moved the assistant `history.push` to run immediately after the reply renders (guarded), so no optional decoration error can erase the turn. Also removed a broken `xenon-starship-art` tool-replay branch (bare expression, no return).

### Added

- dream-chat: rich markdown in replies — headings, bulleted/numbered lists, tables, blockquotes, and italics now render as real HTML instead of flat `<br>` text; fenced code blocks keep their newlines. Verified live in the dev preview against a table/list/heading/code sample (finalize and history-replay paths).

### Changed

- dream-chat: pruned ~386 lines of dead code — the `runWorkspace` self-edit UI + `showWksReceipt` (0 callers), the MCP connector sidecar (targeted DOM that doesn't exist in the page), the `updateContext`/`ctx-*` toggles, and the personal-cube DOM-insights writer + its 5-minute poll. The `personalContext` fetch used by the chat request is preserved.
