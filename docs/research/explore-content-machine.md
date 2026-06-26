# Explore as a Single-Pane, Σ₀-Ranked, Profile-Fed Content Machine

**Status:** Research / design proposal
**Date:** 2026-06-25
**Loop stage improved:** **Reason** (rank what to surface) + **Converge** (learn the user from interaction), grounded by **Verify** (every card carries source + confidence) and **Remember** (on-device interest profile).

---

## 1. What we have today (grounded in the code)

The Explore page is a **static link directory with three live rails bolted on**:

| Piece | File | Nature |
|---|---|---|
| Watch rail | [explore.html:497](apps/lantern-garage/public/explore.html) → `/api/youtube/lantern-videos` ([youtube.js](apps/lantern-garage/routes/youtube.js)) | one channel, server-scraped |
| Discover rail | [explore.html:513](apps/lantern-garage/public/explore.html) → `/api/feeds/discover` ([discover-feeds.js](apps/lantern-garage/routes/discover-feeds.js)) | 3 hardcoded RSS sources, sorted by date |
| Build rail | [explore.html:524](apps/lantern-garage/public/explore.html) → `/api/github/activity` ([github-activity.js](apps/lantern-garage/routes/github-activity.js)) | repo releases/commits |
| 6 static sections | [explore.html:545-679](apps/lantern-garage/public/explore.html) | hand-authored `<a class="panel">` link cards |

Everything is **chronological or hand-curated**. Nothing is ranked, nothing knows who the user is, and the page is ~10 disconnected boxes. There is no single feed and no personalization signal anywhere.

**Two assets already exist that do the hard part of "algorithm-fed":**

1. **The Σ₀ ranking discipline is already implemented** in [flourishing-feeds.js](apps/lantern-garage/lib/flourishing-feeds.js). It pulls candidates from multiple real sources, fuses them by **inverse-variance weighting**, **inflates uncertainty by between-source disagreement** (corroboration tightens, conflict widens), and ranks "what to ground next" with a **Question Machine** score = `uncertainty × leverage` ([flourishing-feeds.js:157](apps/lantern-garage/lib/flourishing-feeds.js)). That is exactly the math a content ranker needs — it's just pointed at world-model beliefs instead of content cards.

2. **User profiles already persist** locally, append-only JSONL + role/tier/entitlements ([user-profiles.js](apps/lantern-garage/lib/user-profiles.js)). What's missing is a **derived interest signal** — there is no record of what the user reads, watches, or clicks.

So this is **extension, not addition** (the anti-sprawl rule): reuse the flourishing fusion engine for scoring, reuse the profile store for identity, add one interaction log and one ranking route. No new "recommendation subsystem."

---

## 2. The target: one pane, one ranked stream

Collapse the directory + 3 rails into **a single infinite stream of typed cards** with lightweight filter chips. One endpoint feeds it: `GET /api/explore/feed`.

Card types (all already have a source today):
- `read` — RSS items (discover-feeds + flourishing news)
- `watch` — lanternYT videos
- `build` — GitHub releases/commits
- `doc` — Knowledge Center / reference library entries
- `belief` — a flourishing belief that moved (e.g. "child survival ↑, now corroborated")
- `action` — a contextual jump (resume a dream, open a queued task) — ties Explore back into the loop

Every card renders **why it surfaced** ("because you read 3 local-first posts" / "corroborated by 2 sources") — that's the Verify rule made visible, and it's also the trust mechanism that lets an algorithmic feed not feel like a black box.

---

## 3. Architecture — the loop, applied to content

```
Observe   → gather candidate cards from all feed sources (existing routes)
Remember  → load user profile + interest vector (on-device interaction log)
Reason    → Σ₀ score each candidate: relevance × freshness × trust × diversity
Verify    → every card carries [why, evidence, confidence, source]; drop unsourced
Act       → render the single ranked pane; user clicks/dwells/dismisses
Converge  → log interaction as a convergence record → interest vector updates
            (retrieval-based learning, NOT weight modification)
```

### 3.1 Observe — `lib/explore-feed.js` (new, thin aggregator)
Fan out to the candidate producers we already have and normalize to a common card shape:
```js
{ id, type, title, url, source, published, topics:[...], evidence:{...} }
```
Sources: `discover-feeds`, `flourishing.news`, `youtube`, `github-activity`, the knowledge index, and `flourishing-feeds.panel()` for `belief` cards. Each producer already caches server-side, so this is cheap I/O + a merge.

### 3.2 Remember — the interest vector (the missing piece)
Add **one append-only log**, mirroring the profile/convergence convention:
`data/profiles/<userId>/interactions.jsonl`
```json
{"ts":"…","event":"click|dwell|dismiss|like","cardType":"read","topics":["local-first","ai"],"source":"Simon Willison","weight":1.0}
```
Derive an **interest profile** on read: per-topic and per-source weights with **time decay** (recent interactions count more). This is pure retrieval over the user's own log — fully local, no cloud, and it satisfies North Star #5 (learning = retrieval + experience, never retraining).

Cold start: a guest with no log gets the **editorial/freshness ranking we have today** (graceful degradation), plus the Question Machine deliberately mixes in exploratory cards to *learn* preferences fast.

### 3.3 Reason — the Σ₀ score (reuse flourishing math)
Each candidate becomes a **hypothesis**: *"the user will value this card."* Score it with explicit, sourced factors — the convergence-record discipline `[claim, evidence, confidence, source]`:

| Factor | Evidence | From |
|---|---|---|
| **relevance** | overlap of card topics/source with interest vector | interaction log |
| **freshness** | recency, decayed | card `published` |
| **trust** | source corroboration / reliability | flourishing-feeds fusion idea; per-source reliability |
| **diversity** | penalize near-duplicates & over-represented sources | within-batch |

`score = w·relevance · freshness · trust · diversity`, and carry an **uncertainty** per card (low-evidence users → high uncertainty → more exploration). The fusion/uncertainty code in [flourishing-feeds.js:108-137](apps/lantern-garage/lib/flourishing-feeds.js) ports almost directly.

**The Question Machine is the explore/exploit knob.** Its `uncertainty × leverage` ([flourishing-feeds.js:157](apps/lantern-garage/lib/flourishing-feeds.js)) decides how much of the pane is *high-confidence relevant* vs *high-uncertainty exploratory* — the principled answer to filter-bubble collapse. Surfacing a card we're *uncertain* the user will like, in a topic we know little about, is the highest-leverage way to *learn the profile* — exactly what the Question Machine is for.

### 3.4 Verify — provenance is mandatory
No card ships without `source` + `evidence` + a confidence. Belief cards already carry posterior + uncertainty + source URLs. RSS/video/repo cards carry their origin. The "why surfaced" line is generated from the winning score factor. This keeps the algorithmic feed inside the External-Reality Rule instead of becoming an opaque engagement optimizer.

### 3.5 Converge — close the loop
Client posts interactions to `POST /api/explore/interaction`; the server appends to the log and (optionally) writes a lightweight convergence record. Next page load, the interest vector reflects it. The feed **measurably converges** on the user's taste over sessions — that convergence (e.g. rising click-through on top-ranked cards) is the metric to log, the same way CIO accuracy is tracked.

---

## 4. Role of Σ₀ vs role of profiles (the two levers you named)

- **Σ₀** supplies the *honesty + ranking machinery*: fused, uncertainty-aware scoring; corroboration as trust; the Question Machine for explore/exploit; mandatory provenance. It's what stops this from being a dopamine feed — every item is a sourced, confidence-tagged hypothesis.
- **User profiles** supply the *who*: identity, role/tier/entitlements (gate `action`/premium cards), and — once we add the interaction log — the **interest vector** that personalizes ranking. Local-first, append-only, the user owns it.

Together: **Σ₀ decides *how well-grounded and how novel* a card is; the profile decides *how relevant to this person*.** Multiply them → the single ranked pane.

---

## 5. Build path (phased, each phase shippable)

1. **Single-pane shell** — replace the 6 static sections + 3 rails in [explore.html](apps/lantern-garage/public/explore.html) with one card stream + filter chips. `/api/explore/feed` initially just merges existing sources sorted by freshness (no personalization). *Ships a unified feed immediately.*
2. **Σ₀ scoring** — port the fusion/uncertainty + Question Machine from [flourishing-feeds.js](apps/lantern-garage/lib/flourishing-feeds.js) into `lib/explore-feed.js`; rank by trust × freshness × diversity. Render "why surfaced." *Now it's algorithm-fed, still anonymous.*
3. **Interaction log + interest vector** — add `interactions.jsonl` + `POST /api/explore/interaction`; derive decayed topic/source weights; fold `relevance` into the score. *Now it's profile-fed.*
4. **Converge metric** — log click-through on top-ranked cards; expose convergence on the dashboard. *Now it provably improves.*

## 6. Feature-gate check (CLAUDE.md)

> Better planning / routing → ✓ improves **Reason**. Better verification/grounding → ✓ improves **Verify**.

This names two loop stages, reuses the one fusion engine and the one profile store, and adds **no** new subsystem, memory system, or agent ecosystem. It is squarely inside the convergence constraint.

**Anti-sprawl guardrails:**
- Do **not** build a separate "recommender service" — `lib/explore-feed.js` is a thin aggregator + a port of existing Σ₀ math.
- Do **not** add a second memory — interactions are append-only JSONL under the existing `data/profiles/` convention.
- Do **not** hardcode a model — ranking is arithmetic over signals; if/when an LLM re-ranks, it plugs in as a replaceable provider.

---

## 7. How the industry builds this today — and how it maps to CSF (web-grounded, 2026-06-25)

### 7.1 The production pattern: a multi-stage funnel
Every large social feed (Instagram Explore is the canonical write-up) is a **4-stage funnel** that narrows billions → dozens:

1. **Retrieval / candidate sourcing** — blend several sources with tunable weights: heuristics (trending) + **two-tower neural nets**. The *item tower* embeds content **offline** (cached); the *user tower* embeds the user **online** from fresh features; candidates = **approximate nearest-neighbour (ANN)** search over item embeddings (FAISS). [[evidence: Instagram Explore]]
2. **First-stage ranking** — a lightweight two-tower model, **distilled** to mimic the heavy ranker, trims thousands → hundreds.
3. **Second-stage ranking** — a heavy multi-task net predicts each engagement probability and combines them with an explicit **value model**:
   `EV = W_click·P(click) + W_like·P(like) − W_see_less·P(see_less) + …`
4. **Final reranking** — business/integrity rules: filter harmful content, **boost diversity**, prevent author repetition.

**This funnel scales *down* to one local user cleanly** — it's exactly the `Observe → Reason` split in §3, minus the GPU fleet. Our "item tower" = precomputed content embeddings; our "user tower" = the interest vector from the interaction log; "value model" = the Σ₀ score; "final rerank" = the diversity + Question-Machine exploration pass.

### 7.2 The LLM shift: generative recommenders + **semantic IDs**
The 2024–2025 frontier (Meta **HSTU**, Kuaishou **OneRec**) reframes recsys as **language modeling**: predict the **next item** the way an LLM predicts the next token. The enabling trick is **Semantic IDs**:

- An item's content embedding is **residual-quantized** (RQ-VAE / RQ-Kmeans) into a short sequence of discrete codes, e.g. `(12, 24, 52)` — "characters" composing an item "word." Items that share leading codes are semantically related → **compositional generalization** to new items. [[evidence: GR handbook; Yuan Meng]]
- The model autoregressively **generates** the next item's semantic ID (retrieval) or the next **action** token (ranking) over the user's `(content, action, content, action, …)` history. One unified model replaces the whole funnel, and — unlike classic DLRM — it gets **scaling laws** (a 10-item history yields 9 training signals, not 1).
- **Storage flips**: semantic-ID **codebooks replace dense item-embedding tables**. A code is ~40–60 bits vs ~384–768 bits for a raw embedding — compact, composable, decode-on-demand.

### 7.3 Why we do **not** transplant HSTU/OneRec
They assume **billions of interactions, trillion-param decoders, GPU fleets, and a multi-tenant catalog** to learn scaling laws. We are **one user, local-first, an 8 GB GPU**. Training a generative recommender here would overfit a tiny sequence and violate North Star #5 (learning = retrieval + experience, **not** weight modification). So we **borrow the representation, not the training regime**:

| Industry primitive | Local-first / CSF translation |
|---|---|
| Two-tower retrieval + ANN | Content embeddings (any provider) + a small ANN/brute-force over the corpus; user tower = interest vector. **Feasible now.** |
| Heavy MTML second-stage ranker | **LLM as a zero-shot *listwise reranker*** over the top-N candidates — the proven small-scale role for an LLM in recsys (no training, plugs in as a replaceable provider). [[evidence: LLM-reranker survey]] |
| RQ-VAE **Semantic IDs** | **Residual-quantize each content embedding into discrete codes stored in CSF** (see §7.4). Adopt the *compact composable code*, skip the generative decoder. |
| Value model `Σ Wᵢ·P(actionᵢ)` | The Σ₀ score in §3.3 — same weighted multi-objective form, **plus** confidence/uncertainty + corroboration-as-trust. |
| OneRec **DPO multi-objective alignment** (relevance/diversity/safety/…) | Our **feature-gate + diversity + Question-Machine** pass — the same "balance conflicting objectives" goal, done as explicit arithmetic instead of preference-tuned weights. |

### 7.4 The CSF bridge — residual quantization is already CSF's native idea
The reason "for CSF" is not a stretch: **Semantic IDs and CSF are the same mathematical family — discrete residual quantization.**

- **RQ-VAE** encodes a vector as *successive nearest-codebook residuals* — store the codes, reconstruct on demand.
- **CSF's `qutrit_delta` / `quantum_dust`** ([src/csf/v07/quantum_dust.py](src/csf/v07/quantum_dust.py)) encode a 3¹² base-3 lattice as **deviations from a converged baseline — only the residual deltas are stored explicitly**; "no change" is nearly free.

Both are "**pick the nearest lattice/codebook point, store only the residual.**" The honest gap: CSF's codes are a **fixed base-3 lattice**, not a **learned, content-semantic** codebook — so CSF doesn't produce *semantic* IDs today. The opportunity:

> **Add a content-embedding → CSF-code mapping.** Compute an embedding per content card, residual-quantize it (RQ-Kmeans) into a short code, and persist `{card, code, codebook}` **in a CSF archive**. Retrieval becomes ANN/prefix-match over codes; the user-interest "tower" becomes the centroid of recently-engaged codes. CSF stops being only a *storage* format and becomes the **semantic-ID index for the Explore feed** — codebooks and codes are exactly the compact, append-friendly artifact CSF is good at.

This keeps the whole thing inside the North Star: one memory (CSF + JSONL), retrieval-not-retraining, models replaceable (embedding + reranker are both swappable providers), and every card still carries `[why, evidence, confidence, source]`.

### 7.5 Net recommendation
Build the **funnel, not the generative model**: (1) embeddings + ANN retrieval, (2) Σ₀ value-model scoring, (3) **LLM listwise rerank** of the top-N, (4) diversity + Question-Machine exploration rerank. Store content embeddings **as residual-quantized semantic codes in CSF**. That is precisely "how social platforms + LLMs construct a feed today," scaled to a solo local-first system, and it lands the LLM exactly where it pays off at small scale (reranking + the semantic-ID representation) instead of where it doesn't (training a trillion-param decoder).

**Sources:** [Scaling Instagram Explore (Engineering at Meta)](https://engineering.fb.com/2023/08/09/ml-applications/scaling-instagram-explore-recommendations-system/) · [Generative Recommendation: From Tokenization to Autoregressive Ranking (Yuan Meng)](https://www.yuan-meng.com/posts/generative_recommendation/) · [Generative Recommendation with Semantic IDs: A Practitioner's Handbook (arXiv 2507.22224)](https://arxiv.org/pdf/2507.22224) · [Two-Tower Model deep dive (Shaped)](https://www.shaped.ai/blog/the-two-tower-model-for-recommendation-systems-a-deep-dive) · [How Good are LLM-based Rerankers? (arXiv 2508.16757)](https://arxiv.org/pdf/2508.16757)

---

## 8. DECISION — ship it on PCSF now, dogfood toward the real recommender later

**The chosen near-term path. This supersedes the embeddings/semantic-ID build as the *first* thing to ship** — that stays the future "better product" (§7.4), and the PCSF feed is what generates the data to train it.

### 8.1 The realization: the feed IS a PCSF leaderboard
PCSF is not provider-specific. It is a general mechanism: **a declared candidate set, reordered by a live leaderboard of recorded outcomes, with cold-start priors and append-only feedback.** The content feed is structurally identical to provider routing:

| PCSF for providers (today) | PCSF for the Explore feed (this) |
|---|---|
| candidate = `{provider, model}` | candidate = a content card `{key, type, …}` |
| `key` = model/provider name | `key` = `source:Simon Willison` / `topic:local-first` / `type:watch` |
| outcome = call succeeded / latency / cost | outcome = **click = success, dwell = latency, dismiss = failure** |
| `rankCandidates()` → best provider first | `rankCandidates()` → best card first |
| `recordModelOutcome()` appends JSONL | `recordModelOutcome()` appends JSONL |
| cold prior: cloud explored above local | cold prior: editorial order, then exploration |
| reorders the static fallback chain | reorders the candidate card list |

[`rankCandidates(candidates, taskType, opts)`](apps/lantern-garage/lib/model-leaderboard.js) is **already generic** — candidates carry an arbitrary `key`, scored by a cost-aware composite of success-rate + latency, unscored items get a cold-start prior. **Nothing about it assumes LLMs.** We call it with `taskType: "explore"` and content cards instead of providers.

### 8.2 What we build (almost nothing new)
1. **`data/pcsf/explore.pcsf.json`** — declare the candidate taxonomy (the curated sources, topic tags, card types) + static default priority + state, mirroring [model.pcsf.json](data/pcsf/model.pcsf.json). This is the editorial cold-start order.
2. **`lib/explore-feed.js`** — the §3.1 aggregator that produces cards, then calls `rankCandidates(cards, "explore", { … })` to order them. ~50 lines around an existing function.
3. **`POST /api/explore/interaction`** — on click/dwell/dismiss, call `recordModelOutcome(card.key, "explore", success, dwellMs)`. That's the existing append-only outcome log; the leaderboard self-updates. No new store.
4. The single-pane UI (§2) renders the ranked cards.

The Σ₀ value-model (§3.3) and Question-Machine exploration become **the cold-start priors and the leaderboard's explore/exploit** — which PCSF already implements. We get personalization, exploration, and convergence **for free from infrastructure we already run in production for model routing.**

### 8.3 The dogfood flywheel (the part that compounds)
Two loops, both already proven for models in [leaderboard-routing.js](apps/lantern-garage/lib/leaderboard-routing.js):

- **We dogfood PCSF.** Pointing our own provider-ranking format at a *completely different* problem (content, not LLMs) is the stress test that makes PCSF better. Whatever the feed needs — multi-key candidates, per-user leaderboards, time-decay — becomes a PCSF improvement that **also upgrades model routing.** One format, two consumers, shared gains. (Feature gate: improves **Reason**; reuses one mechanism; adds no subsystem.)
- **The feed generates the training corpus for the future recommender.** Exactly as `recordOuroLoss()` captures cloud wins as distillation data for the local coder, every Explore interaction is a labeled `(context → engagement)` row. Shipping the cheap PCSF feed **now** accumulates the impression/click dataset that the embeddings + semantic-ID + LLM-reranker recommender (§7) needs to exist at all. The simple thing today *is* the data pipeline for the sophisticated thing tomorrow.

### 8.4 Net
- **Today:** one ranked pane, personalized + self-improving, built on the PCSF leaderboard + outcome log we already run. New code is an aggregator, one JSON declaration, and one POST route.
- **Meanwhile:** it logs the interaction corpus.
- **Later:** swap the leaderboard scorer for the embeddings/ANN + LLM-reranker + CSF semantic-ID engine (§7) once the data justifies it — same `/api/explore/feed` contract, same interaction log, no UI rewrite.

This is the "do what's best with what we have, dogfood toward the better product" path end to end.
