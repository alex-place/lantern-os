---
author: Alex Place
created: 2026-06-26
updated: 2026-06-26
status: current
---

# Explore Feed — single-pane, PCSF-ranked content (as-built)

**What the page *is* today.** The Explore page ([`public/explore.html`](../apps/lantern-garage/public/explore.html))
is **one ranked, self-improving content stream** with type-filter chips — not a static link
directory. It is built on the **same PCSF leaderboard that ranks model providers**, so it adds
**no new recommender subsystem**: one mechanism, two consumers.

- **Loop stage:** **Reason** (rank what to surface) + **Converge** (learn the user from
  interaction), grounded by **Verify** (every card carries a source + a "why surfaced" line).
- **Design rationale / future path:** [`docs/research/explore-content-machine.md`](research/explore-content-machine.md) §8.
- **Shipped:** PR #1259 (epic #1211 P0 — #1214–1218).

---

## 1. Data flow

```
Observe   lib/explore-feed.js → aggregate()         gather candidate cards from existing producers
Reason    lib/explore-feed.js → rankedFeed()        rankCandidates(cards, "explore") orders them
Act        GET /api/explore/feed                     server returns the ranked feed
          public/explore.html                       renders one stream + filter chips
Converge   POST /api/explore/interaction            click/dwell=success, dismiss=failure
          → recordModelOutcome(card.key,"explore")  appended to the agent-performance leaderboard
                                                     ↑ next feed load reorders by what was learned
```

The aggregator fans out to producers that **already exist and cache server-side** — no new
fetching infrastructure:

| Card type | Producer | Source |
|---|---|---|
| `read`   | [`routes/discover-feeds.js`](../apps/lantern-garage/routes/discover-feeds.js) `load()` | curated RSS/Atom (Simon Willison, HN, MIT Tech Review) |
| `watch`  | [`routes/youtube.js`](../apps/lantern-garage/routes/youtube.js) `load()` | lanternYT channel |
| `build`  | [`routes/github-activity.js`](../apps/lantern-garage/routes/github-activity.js) `load()` | repo releases + commits |
| `belief` | [`lib/flourishing-feeds.js`](../apps/lantern-garage/lib/flourishing-feeds.js) `panel()` | fused world-model beliefs |
| `doc`    | `data/knowledge/index.meta.json` | Keystone knowledge index |

Each producer runs under an 8 s timeout; a source that fails or times out drops **only its own
cards** (`Promise.allSettled` + per-producer `.catch(() => [])`). The page never blanks.

---

## 2. Card shape & the leaderboard key

Every card is normalized to:

```js
{ id, type, title, url, source, published, topics:[...], evidence:{ why, source }, key }
```

- `key = "source:<source>"` — the **leaderboard agentId**. Outcomes recorded against this key are
  what reorder the feed. (`topic:` / `type:` namespaces are reserved for the P1 personalization
  work; see §5.)
- `id` is unique per card and is the **dedupe key** in `aggregate()` — *not* `url`, because every
  belief card shares `url:"/flourishing.html"` and a url-key would collapse them to one.
- `evidence` satisfies the Verify rule — no card ships without a source; the UI renders the
  "why surfaced" line from it.

---

## 3. Ranking & cold start

`rankedFeed()` calls [`rankCandidates(cards, "explore", opts)`](../apps/lantern-garage/lib/model-leaderboard.js)
— the generic PCSF ranker. Cards then sort by:

1. **PCSF score** (learned `compositeScore` for a source with enough signal; otherwise a cold prior).
2. **Editorial order** — the `default_priority` list in
   [`data/pcsf/explore.pcsf.json`](../data/pcsf/explore.pcsf.json) (ties among cold-start cards).
3. **Freshness** — card `published`, most-recent first.

**Contract:** with no interaction signal, the feed equals **editorial + freshness** order. A source
the user clicks ≥3× floats to the top; a source dismissed is pushed down once the leaderboard has
enough samples (see §5 for the current limit).

The taxonomy declaration `data/pcsf/explore.pcsf.json` is a **committed config** (force-added past the
`data/pcsf/*.json` gitignore, like `model.pcsf.json`), not runtime state.

---

## 4. API contract

### `GET /api/explore/feed`
→ `{ cards: [...], count, generatedAt }` — cards in ranked order. On any internal error it returns
`{ cards: [], count: 0, error }` with HTTP 200 so the page degrades instead of blanking.

### `POST /api/explore/interaction`
Body: `{ key, event, dwellMs? }`
- `key` must start with `source:` (else 400).
- `event` ∈ `click | dwell | like | open` (success) · `dismiss | skip` (failure); anything else → 400.
- Records via `recordModelOutcome(key, "explore", success, dwellMs, 0)` — appends to
  `apps/data/agent-performance.jsonl` (the existing leaderboard log). **No new store.**
→ `{ ok: true, key, event, success }`.

The client posts with `navigator.sendBeacon` (falling back to `fetch keepalive`) so a click that
also navigates away still records.

---

## 5. Known limitations (→ P1 child issues)

Honest gaps, deferred to the epic's later issues rather than papered over:

- **Per-source granularity.** `card.key` is `source:<name>`, so dismissing one noisy card demotes
  *every* card from that source. Per-topic / per-card relevance is **#1219** (personalization).
- **Dismiss doesn't fully sink yet.** `rankCandidates` fetches only the top-ranked agent
  (`limit=1`, shared with model routing) and needs **≥3 samples** before a key scores, so a
  dismissed source currently rests at the neutral prior rather than dropping below it. Raising the
  fetch limit + a diversity / exploration rerank is **#1220**.
- **No `dwell` from the client yet.** The contract supports dwell-as-latency, but the UI emits only
  `click`/`dismiss` today (#1220).
- **Convergence metric.** Click-through-rate on top-ranked cards is the convergence signal to log
  and surface on the dashboard — **#1221**.

These are why the design doc frames this as the *first* shippable slice that **also logs the
`(context → engagement)` corpus** for the future embeddings / semantic-ID recommender.

---

## 6. Files

| File | Role |
|---|---|
| [`data/pcsf/explore.pcsf.json`](../data/pcsf/explore.pcsf.json) | candidate taxonomy + editorial cold-start order (#1214) |
| [`apps/lantern-garage/lib/explore-feed.js`](../apps/lantern-garage/lib/explore-feed.js) | aggregator + ranker; `node explore-feed.js` prints the merged list (#1215) |
| [`apps/lantern-garage/routes/explore.js`](../apps/lantern-garage/routes/explore.js) | `GET /api/explore/feed` + `POST /api/explore/interaction` (#1216, #1218) |
| [`apps/lantern-garage/public/explore.html`](../apps/lantern-garage/public/explore.html) | single-pane UI + filter chips; static directory demoted to a collapsed "All tools" (#1217) |
| `routes/{discover-feeds,youtube,github-activity}.js` | now export a reusable cache-aware `load()` |
