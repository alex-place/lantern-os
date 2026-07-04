feat(chat): recall_memory tool — agent-invoked memory recall instead of a keyword gate

Chat could not answer "use what you already know about me": the only path to
memory was `formatCSFContextForPrompt`'s automatic pre-injection, which is gated
by keyword overlap with the *current* message — a generic identity question has
no distinctive keywords, so it matched nothing and the model then wrongly
concluded it had no memory of past sessions. A gate in front of the model is the
wrong shape (it isn't how Read/Grep work).

Adds a `recall_memory` tool to the shared registry (`lib/tool-runner.js`) that
the model calls on demand — it decides to recall, gets what is on file, and
reasons over it. Backed by the ONE canonical CSF memory + conversation log via
new `lib/csf-memory.js::recallMemory()` (personal life-facts + a cross-session
"what you've told me" digest; query-focused or general profile) — no new store.
operator-only (reads personal memory; hidden from public-server guests).

Fixes found while verifying: human turns are logged as role `operator`/`user`
(not a single `user`), so `recentUserTurns` filters the real human roles; and
Three Doors game-state records tagged `life-memory` are excluded from personal
facts (+ de-dup). The csf-memory reader now honors `CSF_MEMORY_PATH` /
`KEYSTONE_CONVERSATION_LOG` (parity with the writer; makes recall testable).

Improves the Remember stage. Covered by `test/recall-memory.test.js` (8 tests).
