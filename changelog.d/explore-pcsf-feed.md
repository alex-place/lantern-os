### Explore: single-pane, PCSF-ranked content feed (#1211 P0 — #1214–1218)

Replaced the Explore page's static link directory + 3 chronological rails with **one
ranked, self-improving content pane**, built on the **same PCSF leaderboard we already
run for model routing** — no new recommender subsystem.

- **#1214** `data/pcsf/explore.pcsf.json` — declares the candidate taxonomy (sources,
  topics, card types) + editorial cold-start order.
- **#1215** `apps/lantern-garage/lib/explore-feed.js` — thin aggregator over existing
  producers (RSS discover, lanternYT, GitHub activity, flourishing beliefs, knowledge
  index), normalized to one card shape with graceful per-source timeout/failure.
  Producer routes (`discover-feeds`, `youtube`, `github-activity`) now export a reusable
  cache-aware `load()` (route behaviour unchanged).
- **#1216** `GET /api/explore/feed` — ranks cards via `rankCandidates(cards, "explore")`;
  cold start falls back to editorial order, then freshness.
- **#1217** `explore.html` — single ranked stream + type filter chips
  (Read/Watch/Build/Docs/Beliefs); every card shows "why surfaced" (the Verify rule made
  visible). The old directory is demoted to a collapsed "All tools" section — nothing lost.
- **#1218** `POST /api/explore/interaction` — click/dwell = success, dismiss = failure,
  recorded via `recordModelOutcome(card.key, "explore", …)` onto the existing
  agent-performance log. No new store.

Loop stage: **Reason** (rank what to surface) + **Converge** (learn from interaction),
grounded by **Verify** (sourced cards). Dogfoods PCSF as a second, non-LLM consumer and
logs the (context → engagement) corpus for the future embeddings/semantic-ID recommender.
Design: `docs/research/explore-content-machine.md` §8.

Verified on the dev preview: feed renders (29 cards), editorial order with no signal,
chips filter, dismiss records + removes, a clicked source reorders to the top, responsive
(1-col mobile / 3-col desktop), dark mode, no console errors. Follow-ups: full source
down-ranking + diversity rerank (#1219/#1220), convergence CTR tile (#1221).
