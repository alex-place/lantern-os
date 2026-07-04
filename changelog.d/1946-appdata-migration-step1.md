refactor(desktop): route chat-memory stores through app-paths.dataRoot() — Phase-0 call-site migration step 1 (#1946)

The Phase-0 seam (#1973) defined where writable state should live; this routes the
core chat-memory stores through it so UNISONA_DESKTOP=1 / UNISONA_STATE_DIR relocate
their reads AND writes to %APPDATA%\unisona\data coherently. file-queue.js re-anchors
relative reads by prefix (data/ → stateRoot; manifests//reports/ → repoRoot);
conversation-store, session-summary-store, dreamer-store compute data/ paths from
dataRoot() and make readJsonl paths relative to stateRoot(). Behaviour-preserving on
servers (dataRoot()==repoRoot/data with no env set; full test:sigma0 green). Covered
by test/appdata-migration.test.js (3 checks incl. an end-to-end round-trip). Next
step: csf-memory, rag-house, server.js constants, then flip the launcher.
Strengthens **Remember** (durable per-user state location).
