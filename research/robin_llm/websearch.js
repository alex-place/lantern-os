"use strict";
// Live prior-art search -- the leg the audit was missing.
//
// WHY NOT THE REPO'S OWN CLIENT. lib/web-search-client.js falls through to a wiki lookup and
// returns confident nonsense: asked about attention heads and hallucination detection it returned
// a Wikipedia article on Lewy body dementia, with success:true. A prior-art check that silently
// returns garbage is worse than none, so this talks to two scholarly indexes directly.
//
//   arXiv API        the right corpus for this domain, precise, no key. Validated against the
//                    2026-08-20 red team: querying it for "uncertainty aware attention heads"
//                    returns the exact paper the LOCAL corpus missed, which is the failure this
//                    whole module exists to fix.
//   OpenAlex         catches published work that never hit arXiv. Use the title_and_abstract
//                    filter, not `search`: plain search is citation-weighted and returned YOLOv10
//                    for a hallucination-detection query, while the filter returned exactly one
//                    result and it was the right one.
//   Google Patents   THE PATENT LITERATURE, which none of the paper legs can see and which is
//                    where a large part of applied ML actually lands. First query on our own
//                    goal returned four granted/published patents on LLM hallucination detection
//                    that arXiv, OpenAlex and OpenReview between them never surfaced.
//                    CAVEAT, stated because it is load-bearing: this is the undocumented XHR
//                    endpoint Google Patents' own front end calls, not a published API. It has no
//                    stability guarantee and its terms are not the terms of a research API. It is
//                    used here at low volume with the same politeness gap as everything else, and
//                    it should be replaced by EPO OPS -- documented, free, worldwide -- the moment
//                    someone registers the key (scripts/patent_harvest.py is written and waiting;
//                    F:/patent-corpus currently holds 22 documents from one seed file).
//   OpenReview       conference submissions under review, which neither of the above can see.
//                    Added after an audited run left "Modular Verification Head Addition" as
//                    UNVERIFIED with 40 arXiv and 16 OpenAlex hits searched -- while UHeads, an
//                    ICLR submission doing exactly that, sat in OpenReview. api2, not api1: the
//                    same query returns UHeads first from api2 and unrelated CoT work from api1.
//
// WHAT IT STILL MISSES, stated because the audit's honesty depends on it: venues with no open
// index at all, work published only as a blog post or a model card, and anything too recent to be
// indexed anywhere. "No match" remains a stronger silence, not evidence.
//
// Polite by construction: one request per host per REQUEST_GAP ms, results cached on disk so a
// re-run costs nothing. Failures are reported, never swallowed -- a leg that did not run must not
// look like a leg that ran and found nothing.

const https = require("https");
const fs = require("fs");
const path = require("path");

const UA = "lantern-research/1.0 (mailto:founder@lantern-os.net)";
const REQUEST_GAP = Number(process.env.ROBIN_WEB_GAP_MS || 3200);                 // arXiv asks for ~3s between calls; we honour it for both
const TIMEOUT_MS = 25000;
const CACHE = path.join(__dirname, "results", ".websearch-cache.json");

let _cache = null;
const _lastCall = new Map();

function cache() {
  if (process.env.ROBIN_WEB_NOCACHE === "1") return {};
  if (_cache) return _cache;
  try { _cache = JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { _cache = {}; }
  return _cache;
}

function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(_cache || {}, null, 1));
  } catch { /* a cache that cannot be written is not an error worth failing a run over */ }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function polite(host) {
  const last = _lastCall.get(host) || 0;
  const wait = REQUEST_GAP - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  _lastCall.set(host, Date.now());
}

// Test seam, mirroring lib/verify-llm.js: swap the single HTTP call so the merge, fallback and
// leg-reporting logic can be exercised without a network.
let _get = _realGet;
function _setFetch(fn) { _get = fn; }
function _resetFetch() { _get = _realGet; }
function get(url) { return _get(url); }

function _realGet(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { "User-Agent": UA } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (e) => resolve({ status: -1, body: String(e.message || e) }));
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); resolve({ status: -2, body: "timeout" }); });
  });
}

function stripTags(s) { return String(s).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(); }

const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "using", "via", "into",
                      "when", "what", "how", "does", "can", "are", "its", "our", "per", "than"]);

// Words so common in this literature that a query built from them matches everything and
// therefore nothing. Distinct from STOP, which is ordinary English: these are domain-generic.
const GENERIC = new Set(["model", "models", "language", "large", "learning", "method", "methods",
                         "parameter", "parameters", "efficient", "efficiency", "training", "train",
                         "reasoning", "detection", "detect", "token", "tokens", "neural", "network",
                         "approach", "based", "task", "tasks", "performance", "small", "test"]);

function terms(query) {
  return String(query).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w));
}

// A NARROWING LADDER, because both indexes treat a multi-term query as a conjunction: one word
// the paper does not happen to use zeroes the whole search. Measured -- "spectral rewiring
// parameter-efficient fine-tuning reasoning" returns nothing from either leg, while "spectral
// rewiring" returns the paper the idea was restating. So: exact phrase, then progressively fewer
// of the leading terms, stopping at the first rung that returns anything.
//
// Looser rungs return looser matches, and that is fine here: the judge decides relevance, and a
// candidate it can reject beats a silence it would read as novelty. The rung that matched is
// recorded so a loose match can be seen for what it is.
// The DISTINCTIVE adjacent pairs of a query -- both words outside the domain-generic list. This
// is what the leading-N ladder got wrong: for "parameter-efficient spectral rewiring reasoning"
// the leading two terms are "parameter efficient", which returns generic PEFT work and stops the
// ladder before it ever reaches "spectral rewiring" -- the pair that finds the paper the idea was
// restating. Position in the sentence says nothing about which words carry the idea.
function distinctivePairs(query, cap = 3) {
  const t = terms(query);
  const pairs = [];
  for (let i = 0; i + 1 < t.length; i++) {
    if (!GENERIC.has(t[i]) && !GENERIC.has(t[i + 1])) pairs.push([t[i], t[i + 1]]);
  }
  return pairs.slice(0, cap);
}

function arxivQueries(query) {
  const t = terms(query);
  const out = [`all:${encodeURIComponent(`"${query}"`)}`];
  if (t.length > 6) out.push(t.slice(0, 6).map((x) => `all:${encodeURIComponent(x)}`).join("+AND+"));
  for (const [a, b] of distinctivePairs(query)) {
    out.push(`all:${encodeURIComponent(a)}+AND+all:${encodeURIComponent(b)}`);
  }
  if (out.length === 1 && t.length >= 2) {
    out.push(t.slice(0, 2).map((x) => `all:${encodeURIComponent(x)}`).join("+AND+"));
  }
  return out;
}

function openalexQueries(query) {
  const t = terms(query);
  const out = [query];
  for (const [a, b] of distinctivePairs(query)) out.push(`${a} ${b}`);
  if (out.length === 1 && t.length > 2) out.push(t.slice(0, 2).join(" "));
  return out;
}

async function arxivOnce(searchQuery, k) {
  await polite("arxiv");
  const r = await get(`https://export.arxiv.org/api/query?search_query=${searchQuery}&max_results=${k}&sortBy=relevance`);
  return r;
}

// UNION the rungs rather than stopping at the first that returns anything. Stopping early is
// what hid the spectral-rewiring paper: a broad rung returned plenty of irrelevant PEFT work, the
// ladder halted, and the narrow rung that would have found it was never tried. A rung returning
// hits is not evidence that it returned the RIGHT hits.
async function arxiv(query, k = 5) {
  const ladder = arxivQueries(query);
  const hits = [];
  const seen = new Set();
  let anyOk = false;
  let lastStatus = "no-response";
  for (let i = 0; i < ladder.length; i++) {
    const r = await arxivOnce(ladder[i], k);
    lastStatus = r.status;
    if (r.status !== 200) continue;
    anyOk = true;
    for (const h of parseArxiv(r.body, i)) {
      if (!seen.has(h.id)) { seen.add(h.id); hits.push(h); }
    }
  }
  if (!anyOk) return { ok: false, reason: `arxiv ${lastStatus}`, hits: [], rung: 0 };
  return { ok: true, reason: "", hits, rung: hits.length ? Math.min(...hits.map((h) => h.rung)) : 0 };
}

function parseArxiv(body, rung) {
  const hits = [];
  for (const entry of body.split("<entry>").slice(1)) {
    const id = (entry.match(/<id>([^<]+)<\/id>/) || [])[1] || "";
    const title = stripTags((entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
    const summary = stripTags((entry.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || "");
    const pub = (entry.match(/<published>(\d{4})/) || [])[1] || "";
    if (title) hits.push({ source: "arxiv", id: id.split("/abs/")[1] || id, year: pub, title,
                          abstract: summary.slice(0, 400), rung });
  }
  return hits;
}

// OpenReview's `term` search is full-text relevance, not a conjunction, so the raw query works
// where arXiv and OpenAlex need narrowing. One narrowing rung is still tried for recall.
async function openreviewOnce(query, k) {
  await polite("openreview");
  // Ask for FOUR TIMES what we want: most notes returned are reviews and replies, which carry no
  // title and are filtered out. Requesting k returned 2 usable hits for k=8.
  return get(`https://api2.openreview.net/notes/search?term=${encodeURIComponent(query)}&limit=${k * 4}`);
}

function orTitle(v) {
  return v && typeof v === "object" ? String(v.value || "") : String(v || "");
}

async function openreview(query, k = 5) {
  // The same narrowing ladder as the other legs, and for the same reason: OpenReview's term
  // search is literal, so "lightweight verification head frozen model reasoning step correctness"
  // returns papers about lightweight things, while "verification head" returns UHeads. One pair
  // was not enough -- with cap 1 the only pair offered was the leading one, which is exactly the
  // positional bias already fixed for arXiv.
  const pairs = distinctivePairs(query, 3);
  const ladder = [query, ...pairs.map(([a, b]) => `${a} ${b}`)];
  const hits = [];
  const seen = new Set();
  let anyOk = false;
  let lastStatus = "no-response";
  for (let i = 0; i < ladder.length; i++) {
    const r = await openreviewOnce(ladder[i], k);
    lastStatus = r.status;
    if (r.status !== 200) continue;
    anyOk = true;
    try {
      const j = JSON.parse(r.body);
      for (const note of j.notes || []) {
        const c = note.content || {};
        const title = orTitle(c.title);
        // Replies and reviews are notes too, and they have no title. Only submissions count.
        if (!title || seen.has(title.toLowerCase())) continue;
        seen.add(title.toLowerCase());
        hits.push({ source: "openreview", id: note.id || "", title,
                    year: note.cdate ? String(new Date(note.cdate).getUTCFullYear()) : "",
                    abstract: orTitle(c.abstract).slice(0, 400), venue: orTitle(c.venue), rung: i });
      }
    } catch (e) {
      return { ok: false, reason: `openreview parse: ${e.message}`, hits, rung: i };
    }
  }
  if (!anyOk) return { ok: false, reason: `openreview ${lastStatus}`, hits: [], rung: 0 };
  return { ok: true, reason: "", hits, rung: hits.length ? Math.min(...hits.map((h) => h.rung)) : 0 };
}

function stripHtml(s) { return String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }

async function googlepatentsOnce(query, k) {
  await polite("googlepatents");
  return get(`https://patents.google.com/xhr/query?url=${encodeURIComponent(`q=${query}&num=${k}`)}`);
}

async function googlepatents(query, k = 5) {
  // Patent titles are terse and claim-shaped, so the phrase rung rarely hits; the distinctive
  // pairs do most of the work here.
  const ladder = [query, ...distinctivePairs(query, 2).map(([a, b]) => `"${a} ${b}"`)];
  const hits = [];
  const seen = new Set();
  let anyOk = false;
  let lastStatus = "no-response";
  for (let i = 0; i < ladder.length; i++) {
    const r = await googlepatentsOnce(ladder[i], k);
    lastStatus = r.status;
    if (r.status !== 200) continue;
    anyOk = true;
    try {
      const j = JSON.parse(r.body);
      for (const cluster of (j.results && j.results.cluster) || []) {
        for (const row of cluster.result || []) {
          const pt = row.patent || {};
          const id = pt.publication_number || row.id;
          const title = stripHtml(pt.title);
          if (!id || !title || seen.has(id)) continue;
          seen.add(id);
          hits.push({ source: "patent", id, title,
                      year: String(pt.grant_date || pt.publication_date || "").slice(0, 4),
                      abstract: stripHtml(pt.snippet || pt.abstract || "").slice(0, 300),
                      venue: pt.assignee || "", rung: i });
        }
      }
    } catch (e) {
      return { ok: false, reason: `patents parse: ${e.message}`, hits, rung: i };
    }
  }
  if (!anyOk) return { ok: false, reason: `patents ${lastStatus}`, hits: [], rung: 0 };
  return { ok: true, reason: "", hits, rung: hits.length ? Math.min(...hits.map((h) => h.rung)) : 0 };
}

async function openalexOnce(query, k) {
  await polite("openalex");
  return get(`https://api.openalex.org/works?filter=title_and_abstract.search:${encodeURIComponent(query)}`
           + `&per_page=${k}&mailto=founder@lantern-os.net`);
}

async function openalex(query, k = 5) {
  const ladder = openalexQueries(query);
  const hits = [];
  const seen = new Set();
  let anyOk = false;
  let lastStatus = "no-response";
  for (let i = 0; i < ladder.length; i++) {
    const r = await openalexOnce(ladder[i], k);
    lastStatus = r.status;
    if (r.status !== 200) continue;
    anyOk = true;
    try {
      const j = JSON.parse(r.body);
      for (const w of j.results || []) {
        const id = (w.ids && w.ids.doi) || w.id || String(w.title || "");
        if (!w.title || seen.has(id)) continue;
        seen.add(id);
        hits.push({ source: "openalex", id, year: String(w.publication_year || ""),
                    title: String(w.title), abstract: "", rung: i,
                    venue: (w.primary_location && w.primary_location.source
                      && w.primary_location.source.display_name) || "" });
      }
    } catch (e) {
      return { ok: false, reason: `openalex parse: ${e.message}`, hits, rung: i };
    }
  }
  if (!anyOk) return { ok: false, reason: `openalex ${lastStatus}`, hits: [], rung: 0 };
  return { ok: true, reason: "", hits, rung: hits.length ? Math.min(...hits.map((h) => h.rung)) : 0 };
}

// One query across both legs. Returns hits plus WHICH LEGS ACTUALLY RAN -- the audit must be able
// to tell "searched and found nothing" apart from "did not search".
// The cache key carries the LEG SET. Adding the patent leg made every stored entry a record of a
// search that no longer exists -- and searchAll then read r.legs.patent off an entry written
// before that leg had a name, which threw. A cache that outlives a change in what is cached is a
// correctness bug, not a stale-data inconvenience.
const LEGS = ["arxiv", "openalex", "openreview", "patent"];
const CACHE_VERSION = LEGS.join("+");

async function search(query, k = 5) {
  const key = `${CACHE_VERSION}::${query}::${k}`;
  const c = cache();
  if (c[key]) return c[key];
  const [a, o, v, g] = [await arxiv(query, k), await openalex(query, k),
                        await openreview(query, k), await googlepatents(query, k)];
  const out = {
    query,
    legs: { arxiv: { ok: a.ok, reason: a.reason, n: a.hits.length, rung: a.rung },
            openalex: { ok: o.ok, reason: o.reason, n: o.hits.length, rung: o.rung },
            openreview: { ok: v.ok, reason: v.reason, n: v.hits.length, rung: v.rung },
            patent: { ok: g.ok, reason: g.reason, n: g.hits.length, rung: g.rung } },
    searched: a.ok || o.ok || v.ok || g.ok,
    hits: [...a.hits, ...o.hits, ...v.hits, ...g.hits],
  };
  c[key] = out;
  saveCache();
  return out;
}

async function searchAll(queries, k = 5) {
  const legs = Object.fromEntries(LEGS.map((l) => [l, { ok: false, n: 0 }]));
  const seen = new Set();
  const hits = [];
  for (const q of queries.slice(0, 3)) {
    const r = await search(q, k);
    for (const leg of LEGS) {
      const got = r.legs[leg] || { ok: false, n: 0 };   // an entry from an older leg set
      legs[leg].ok = legs[leg].ok || got.ok;
      legs[leg].n += got.n;
    }
    for (const h of r.hits) {
      const id = `${h.source}:${h.id || h.title}`;
      if (!seen.has(id)) { seen.add(id); hits.push(h); }
    }
  }
  return { queries: queries.slice(0, 3), legs, searched: LEGS.some((l) => legs[l].ok), hits };
}

module.exports = { search, searchAll, arxiv, openalex, openreview, googlepatents, LEGS, arxivQueries, openalexQueries, distinctivePairs,
                   _setFetch, _resetFetch, REQUEST_GAP, CACHE };
