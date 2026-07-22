# Worldwide-Patent Corpus (prior-art / IP grounding)

A local, offline BM25 corpus of **worldwide patents** that lets the unisona.ai chat
assistant answer prior-art, freedom-to-operate, patent-landscape, and "who holds the
patent on X" questions grounded in **real patents from ~90+ patent offices** — with a
citable publication number and URL for every claim.

It is the **third local-corpus grounding source**, built to be a near-exact twin of the
[arXiv corpus](ARXIV-CORPUS.md): same BM25 machinery, same fail-safe design, same
one-loop integration. It is **not a new memory system** — it folds into the single
research loop (`lib/wide-search.js`) and is exposed as one chat tool (`patent_search`).

## North Star fit

This strengthens the **Observe / Remember** stages of the convergence loop by adding a
grounded external evidence source. Every patent surfaced carries `[claim, evidence,
confidence, source]` — the publication number is the evidence id, the abstract is the
evidence, and the Google Patents / Espacenet URL is the source. No new top-level surface,
no new subsystem: one lib + one tool + one fold-in.

## Data source — EPO Open Patent Services (free, worldwide)

Harvested from the **European Patent Office's Open Patent Services (OPS)** REST API — the
only free API with genuinely worldwide coverage (DOCDB bibliographic across 90+ countries
+ INPADOC families). Free tier: register at <https://developers.epo.org/> for a Consumer
Key + Secret (OAuth2 client-credentials, no credit card), ~4 GB/week quota.

### The honest limit of "worldwide + free"

Nobody gives away worldwide **full text**. For free, "worldwide" realistically means
**bibliographic metadata + abstract** across 90+ countries; full text (claims +
description) is free only for **EP, WO, and US**. So the corpus **grounds on title +
abstract worldwide**, folding in claims/description where a record carries them (EP/WO/US).
For US-deep full text later, a `--source uspto` harvest path (USPTO Open Data Portal,
free key, US-only) is the natural follow-on.

## Storage layout

Root = `$PATENT_CORPUS_DIR` (default `F:\patent-corpus`):

```
raw\<YYYY>.jsonl     # one patent per line, deduped by publication number, sharded by publication year
index\postings.json  # {term: [[docId, tf], ...]}
index\docs.jsonl     # line docId = {id,title,published,country,assignee,cpc,snippet,url,len}
index\meta.json      # {count, avgdl, k1, b, built_at, terms}
state\harvest.json   # last harvest parameters (for reference / resumption)
```

A raw record is `{id, title, abstract, country, assignee, cpc[], published, patent_url}`
(+ optional `claims` for EP/WO/US). `id` is the display publication number
(`US-11289701-B2`); `patent_url` is the compact Google Patents form.

## Build the corpus

```bash
# 0) One-time: put your free OPS key in .env.local
#      EPO_OPS_KEY=... / EPO_OPS_SECRET=...

# 1) Validate the key (auth + one search, writes nothing)
python scripts/patent_harvest.py --dry-run

# 2) Smoke-test a small harvest, then INSPECT F:\patent-corpus\raw\*.jsonl
python scripts/patent_harvest.py --keywords "solid state battery electrolyte" --from 2018 --max 20

# 3) Full harvest (by keywords, CPC class, applicant, or raw CQL)
python scripts/patent_harvest.py --keywords "solid state battery electrolyte" --from 2015
python scripts/patent_harvest.py --cpc H01M10/0525 --from 2015
python scripts/patent_harvest.py --query 'txt="graphene transistor" and pd within "2019 2026"'

# 4) Build / rebuild the BM25 index (idempotent — re-run after every harvest)
python scripts/patent_build_index.py
```

Harvest a **topic slice** relevant to what you research (the way the arXiv corpus is
gated to AI/ML/quant), not the whole world — that keeps the corpus small, fast, and
on-topic. Re-run the harvest with new `--keywords`/`--cpc` to grow coverage over time.

> ⚠️ The OPS harvester's response parsing is coded from the published API docs but should
> be validated live with your key using `--dry-run` then `--max 20` before a full run —
> inspect the first records. The retrieval side is fail-safe regardless: a missing or
> empty corpus never blocks chat.

## How it's wired

1. **Research loop** — `lib/wide-search.js` folds `queryPatents()` hits into every research
   round's source pool (deduped by URL), so `!research`, autowork issue-research, and the
   `/api/research/wide-search` route all pick up patents with no extra wiring. Gated on/off
   with `WIDE_SEARCH_PATENTS` / `WIDE_SEARCH_PATENTS_K`.
2. **Chat tool** — `patent_search` (in `lib/tool-runner.js`) lets the assistant search
   patents directly ("find prior art for …"). Read-only, guest-safe, provider-agnostic
   (Anthropic / OpenAI / Gemini / local schemas regenerate automatically).

Both self-gate: `looksLikePatentQuestion()` fires only on patent / prior-art / IP intent,
so patents contribute nothing to unrelated chats (anti-sprawl, like the arXiv gate).

## The tokenizer contract

`lib/patent-index.js` (JS query) and `scripts/patent_build_index.py` (index build) **must
tokenize identically** — same lowercase, same `[a-z0-9]+`, same stopwords — or query terms
won't line up with indexed terms. The two are byte-identical to the arXiv tokenizer on
purpose: the three corpora share one tokenization contract. `test/patent-index.test.js`
verifies retrieval end-to-end over a fixture index.
