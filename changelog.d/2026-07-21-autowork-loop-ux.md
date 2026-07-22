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

- chat(autowork): **deterministic `!work #<issue>` / `!autowork #<issue>` command** — the server
  route validates the issue number and tags the done event `source:"work"` (the same
  server-tags/client-acts contract `!review` uses); the client then opens the one real run panel
  (`runAutowork`). Fixes the dead end where an explicit "run autowork on issue #N" request got a
  clarification reply and **no autowork affordance at all** whenever the Ouro intent router — the
  only source of `coding_change` — is offline (which is every fresh install: ollama down ⇒ no
  offer, ever). Explicit bang-commands are the sanctioned deterministic path; NL phrasing stays
  with the model.
- chat(autowork): guests who trigger autowork now get an actionable auth message — the stream
  endpoint (correctly) refuses non-operator sessions, but the panel showed the raw
  "Connection lost — stream_unavailable_403"; it now explains autowork changes the repo, needs an
  operator sign-in, and links `/auth.html` with the retry command.

### Fixed

- autowork(#2762): **deterministic verify floor** — the first end-to-end run shipped
  `verified: false` because the plan specified zero tests, leaving the Verify stage empty.
  Two-layer fix: the plan prompt now requires non-empty, REAL, allowlist-family test commands
  for any code change (never invented paths); and when a plan still names none, the pipeline
  derives a floor from the files the patch actually changed — a syntax/compile check per
  source file plus the repo's real unit tests for that file where they exist
  (`tests/test_<base>.py`, `apps/lantern-garage/test/<base>.test.js`) — so verification is
  never zero for a code change. Floor commands are emitted only if they pass the existing
  #873 closed-class test allowlist verbatim (extended with `node --check`, `py_compile`, and
  the standalone-unit-test patterns); unit-tested in
  `apps/lantern-garage/test/verify-floor.test.js` (8 checks, incl. shell-metachar paths
  skipped and allowlist round-trip). Finale + step details say when the floor (not planned
  tests) did the verifying.

- autowork(#2762): the apply-retry's self-correction mechanism was poisoning itself. The
  retry feedback DID include the targeted file's real content — but line-numbered
  (`102: <line>`) with the instruction "copy context lines VERBATIM from here", so an obedient
  model produced hunk context prefixed `NN: ` that exists in no file, failing identically every
  attempt; the failed hunk's own @@ coordinate (a hallucination) was the only position signal;
  and content was capped at the file's first 400 lines. `targetedFileContext` now emits RAW
  un-numbered content (whole file when ≤520 lines, head+tail windows with true ranges
  otherwise), locates the failed hunks' believed lines in the real file and states the true
  anchor line numbers in prose ("your claimed context exists near line N" / "NONE of your
  context lines exist — that content was invented"), and instructs explicitly that diff lines
  must carry no line numbers. The freshness law applied to the Act seam: fresh truth into the
  retry, not another sample of the stale prompt.

- chat(autowork): the loop strip derived stage state by forward-marking ("everything before the
  current stage is done"), but the pipeline is not in loop order — `branch` (an Act phase) runs
  before `research` (Remember) — so Reason lit as done before the plan step ever ran. Stage state
  is now recomputed from the actual step rows (active if any phase active/retrying, error if one
  errored, done once at least one finished) — order-independent. Caught live on the first real
  run. `runAutowork` also null-guards its offer-button reference so command-started runs (no
  button) can't crash the finale.
- autowork(server): the `done` event's `convergence.confidence.research` was read from a
  nonexistent field (`confidence.research`; the record stores `codebaseResearch`) and was always
  `undefined` — now mapped correctly. The run log's `result` record now also persists the
  convergence summary + council verdict + tests outcome, and `GET
  /api/convergence/autonomous-work/status` surfaces them, so re-attached clients (background
  watcher, dropped-SSE reconnect) render the same verify/converge evidence as a live one.
