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
//
// WHAT IT STILL MISSES, stated because the audit's honesty depends on it: OpenReview submissions
// and other unindexed preprints. UHeads -- one of the two papers that killed a novelty claim in
// the red team -- returns zero results from both legs, because it is an ICLR submission. So even
// with this wired in, "no match" is not "novel". It is a stronger silence, not evidence.
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
async function search(query, k = 5) {
  const key = `${query}::${k}`;
  const c = cache();
  if (c[key]) return c[key];
  const [a, o] = [await arxiv(query, k), await openalex(query, k)];
  const out = {
    query,
    legs: { arxiv: { ok: a.ok, reason: a.reason, n: a.hits.length, rung: a.rung },
            openalex: { ok: o.ok, reason: o.reason, n: o.hits.length, rung: o.rung } },
    searched: a.ok || o.ok,
    hits: [...a.hits, ...o.hits],
  };
  c[key] = out;
  saveCache();
  return out;
}

async function searchAll(queries, k = 5) {
  const legs = { arxiv: { ok: false, n: 0 }, openalex: { ok: false, n: 0 } };
  const seen = new Set();
  const hits = [];
  for (const q of queries.slice(0, 3)) {
    const r = await search(q, k);
    for (const leg of ["arxiv", "openalex"]) {
      legs[leg].ok = legs[leg].ok || r.legs[leg].ok;
      legs[leg].n += r.legs[leg].n;
    }
    for (const h of r.hits) {
      const id = `${h.source}:${h.id || h.title}`;
      if (!seen.has(id)) { seen.add(id); hits.push(h); }
    }
  }
  return { queries: queries.slice(0, 3), legs, searched: legs.arxiv.ok || legs.openalex.ok, hits };
}

module.exports = { search, searchAll, arxiv, openalex, arxivQueries, openalexQueries, distinctivePairs,
                   _setFetch, _resetFetch, REQUEST_GAP, CACHE };
