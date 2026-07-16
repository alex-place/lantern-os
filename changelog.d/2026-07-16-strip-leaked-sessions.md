### Fixed

- security: strip the two session-store files + stray telemetry deltas that PR #2575 accidentally committed (swept from a test server's runtime dir), and gitignore `data/sessions/` so a session file can never be committed again. The leaked session IDs were deleted from the live stable server's store immediately (per-request file reads — invalidation was instant) and the cookie-signing secret means raw IDs alone were not replayable.
