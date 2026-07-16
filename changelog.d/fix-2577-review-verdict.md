Fixed the fleet-review "COMMENT-forever" wedge that starved auto-merge (#2577):
the persona prompt advertises real tools, but the watcher's non-streaming
`/api/dream/chat` call executes none — so the reviewer narrated inspection plans
("Let's start by looking at the diff…") and never emitted its required first-line
`VERDICT:`, which parses fail-closed to COMMENT. Three-part fix: (1) an allowlisted
**one-shot mode** in the chat pipeline (`body.mode: "review"`) that swaps in an
honest no-tools/no-follow-up system prompt and skips every context injection
(web grounding, oracle, mesh, life-fact capture, keystone-ft auto-route);
(2) the watcher now **retries once for just the verdict line** when a review
lacks the tag, prepending a recovered `VERDICT: X`; (3) cross-host adoption via
the `fleet-auto-review:<sha>` marker only adopts reviews that actually
**concluded** (explicit tag) and prefers the newest concluded comment, so a
stale ramble can't shadow its corrected re-review. New `PrWatcher._verdictTag`
helper (tag-only, no bare-token fallback, null instead of fail-closed) with 7
new unit tests — 95 pass. Verified live: a watcher-style `mode:"review"` call
returns a first-line `VERDICT: APPROVE` with zero tool narration, and the
default chat path is unchanged. (Improves Verify — reviews that conclude.)
