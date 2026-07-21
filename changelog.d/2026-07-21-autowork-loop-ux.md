### Changed

- chat(autowork): the autowork panel now walks the Σ₀ loop visibly, and the Approve moment
  carries the verification evidence. **Loop strip** — a six-node Observe → Remember → Reason →
  Act → Verify → Converge tracker at the top of every autowork panel (live, background-watcher,
  and reconnect paths) lights each stage as its phases run; every step row also carries a small
  stage chip, so a run is legibly one walk of the North-Star loop. **Convergence finale** — the
  server has always streamed the full convergence record (hypothesis, evidence, confidence
  breakdown), council verdict, and tests outcome on the `done` event, and the client discarded
  all of it, rendering only "View PR"; the finale now shows a verdict chip (`grounded` green /
  `seam_open` amber-warned / other blue), a tests chip, an overall-confidence meter with a
  per-axis tooltip, and the evidence list in a collapsible convergence-record block.
  **Warn-aware Approve** — when the run is unverified (council `seam_open`, tests failed, or
  tests not run) the one-click Approve becomes an explicit amber "⚠ Approve anyway" with the
  reason in the button, tooltip, and confirm dialog, so a chat-side merge can no longer silently
  launder unverified work.

### Fixed

- autowork(server): the `done` event's `convergence.confidence.research` was read from a
  nonexistent field (`confidence.research`; the record stores `codebaseResearch`) and was always
  `undefined` — now mapped correctly. The run log's `result` record now also persists the
  convergence summary + council verdict + tests outcome, and `GET
  /api/convergence/autonomous-work/status` surfaces them, so re-attached clients (background
  watcher, dropped-SSE reconnect) render the same verify/converge evidence as a live one.
