/**
 * Real grounding-ring adapters for the mesh grounding resolver (lib/mesh-grounding.js).
 *
 * Wraps the EXISTING retrievers into evidence sources — `{claim, evidence, confidence∈[0,1],
 * source}` — so resolveGrounding() can rank them and decide answer-vs-abstain. No new memory
 * system: these are thin adapters over what the chat already reads.
 *
 *   local-memory      → csf-memory.queryConversationMemory + queryMemories  (this node)
 *   knowledge-center  → csf-memory.queryRagHouse + queryResearchLibrary     (this node)
 *   web               → web-search-client.webSearchMcp                      (external, gated)
 *   mesh              → mesh-grounding.meshPeerSource over peer mirrors      (federated)
 *
 * Confidence: the memory retrievers already score by keyword relevance (the same 0..1
 * `relevanceScore` csf-memory uses, mirrored here as overlapConfidence so we don't have to
 * widen csf-memory's export surface). Web hits get a fixed, deliberately MODEST prior — an
 * open-web match is weaker evidence than this node's own grounded memory, and it sits in the
 * outermost ring so it's only consulted when the inner rings are thin.
 */

"use strict";

const http = require("http");
const https = require("https");

const csfMemory = require("./csf-memory");
const { meshPeerSource, asRing } = require("./mesh-grounding");

// Mirror of csf-memory.relevanceScore (not exported there) — keyword overlap in [0,1].
function overlapConfidence(text, query) {
  if (!text || !query) return 0;
  const lower = String(text).toLowerCase();
  const words = String(query).toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return 0;
  const hits = words.filter((w) => lower.includes(w)).length;
  return hits / words.length;
}

const text120 = (s) => String(s || "").replace(/\s+/g, " ").trim();

// ── local Convergence Memory (this node) ─────────────────────────────────────
function localMemoryRing() {
  return asRing("local-memory", async (question) => {
    const out = [];
    try {
      // Cross-session chat turns already carry a relevance score (0..1).
      for (const c of csfMemory.queryConversationMemory(question, 4)) {
        out.push({
          claim: text120(c.text),
          evidence: `recalled ${c.role === "lantern" ? "Keystone" : "user"} turn${c.at ? " @ " + c.at : ""}`,
          confidence: c.score,
          source: "local-memory",
        });
      }
    } catch { /* fail-safe: a dead source contributes nothing */ }
    try {
      for (const m of csfMemory.queryMemories(question, 3)) {
        const t = text120(m.content?.text || m.content?.raw_input || (m.tags || []).join(" "));
        if (!t) continue;
        out.push({ claim: t, evidence: "convergence memory record", confidence: overlapConfidence(t, question), source: "local-memory" });
      }
    } catch { /* fail-safe */ }
    return out;
  });
}

// ── local Knowledge Center / RAG (this node) ─────────────────────────────────
function knowledgeCenterRing() {
  return asRing("knowledge-center", async (question) => {
    const out = [];
    try {
      for (const r of csfMemory.queryRagHouse(question, 3)) {
        const body = text120(r.content);
        const claim = text120(r.title) || body.slice(0, 80);
        if (!claim) continue;
        out.push({ claim, evidence: body.slice(0, 200) || "knowledge base record", confidence: overlapConfidence(claim + " " + body, question), source: "knowledge-center" });
      }
    } catch { /* fail-safe */ }
    try {
      for (const d of csfMemory.queryResearchLibrary(question, 2)) {
        const title = text120(d.pdfTitle || d.filename);
        const snippet = text120(d.textSnippet);
        if (!title) continue;
        out.push({ claim: title, evidence: snippet.slice(0, 200) || "research library doc", confidence: overlapConfidence(title + " " + snippet, question), source: "knowledge-center:research" });
      }
    } catch { /* fail-safe */ }
    return out;
  });
}

// ── web (external, outermost, gated) ─────────────────────────────────────────
// Only worth calling when a question actually needs external grounding; the resolver's
// cheap-first short-circuit means this often never runs when local memory is strong.
function webRing(opts = {}) {
  // Web results carry no native confidence (title/url/snippet only), so this fixed prior IS
  // the answer/abstain gate for web-only turns. Kept BELOW the resolver's 0.5 threshold on
  // purpose: a lone, uncorroborated web hit abstains; two corroborating hits (noisy-OR ≈ 0.70)
  // or web + any local evidence crosses the bar. Don't answer off one random web result.
  const conf = typeof opts.confidence === "number" ? opts.confidence : 0.45;
  return asRing("web", async (question) => {
    let web;
    try { web = require("./web-search-client"); } catch { return []; }
    try {
      if (typeof web.needsGrounding === "function" && !web.needsGrounding(question)) return [];
      const query = typeof web.extractSearchQuery === "function" ? web.extractSearchQuery(question) : question;
      const results = await web.webSearchMcp(query, opts.maxResults || 4);
      return (Array.isArray(results) ? results : []).map((r) => {
        const title = text120(r.title || r.name);
        const snippet = text120(r.snippet || r.content || r.text);
        return {
          claim: title || snippet.slice(0, 80),
          evidence: snippet.slice(0, 220),
          confidence: conf,
          source: "web" + (r.url ? ":" + r.url : ""),
        };
      }).filter((e) => e.claim);
    } catch { return []; }
  });
}

// ── mesh peers (federated; evidence-not-agency) ──────────────────────────────
// Peer mirrors are backend-capable lantern-os instances exposing read-only /api/mesh/ground.
// `selfUrl` is excluded so a node doesn't query itself over the network.
function meshRing(peers, opts = {}) {
  const fetchImpl = opts.fetchImpl || httpPostJson;
  return asRing("mesh", meshPeerSource(peers || [], { fetchImpl, timeoutMs: opts.timeoutMs || 6000, k: opts.k || 5 }));
}

// Minimal JSON POST for the mesh ring (http/https, hard-timeout, fail-safe → []).
function httpPostJson(targetUrl, body, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(targetUrl); } catch { return resolve([]); }
    const lib = u.protocol === "https:" ? https : http;
    const payload = JSON.stringify(body || {});
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            resolve(Array.isArray(j) ? j : Array.isArray(j.evidence) ? j.evidence : []);
          } catch { resolve([]); }
        });
        res.on("error", () => resolve([]));
      }
    );
    req.on("error", () => resolve([]));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve([]); });
    req.write(payload);
    req.end();
  });
}

/**
 * Default ordered ring set: nearest+cheapest first.
 * local memory → knowledge center → mesh peers → web. Mesh sits ABOVE web on purpose —
 * a trusted peer mirror's grounded memory beats an open-web hit.
 * @param {object} [opts]
 * @param {Array<{id,url}>} [opts.peers]  backend-capable peer mirrors for the mesh ring.
 * @param {boolean} [opts.web=true]       include the web ring.
 * @param {boolean} [opts.mesh=true]      include the mesh ring.
 */
function defaultRings(opts = {}) {
  const rings = [localMemoryRing(), knowledgeCenterRing()];
  if (opts.mesh !== false && Array.isArray(opts.peers) && opts.peers.length) rings.push(meshRing(opts.peers, opts));
  if (opts.web !== false) rings.push(webRing(opts));
  return rings;
}

// The local rings ONLY — what this node serves to peers over /api/mesh/ground (no
// recursion: a node never re-federates the mesh ring when answering a peer's request).
function localServeRings() {
  return [localMemoryRing(), knowledgeCenterRing()];
}

module.exports = {
  localMemoryRing,
  knowledgeCenterRing,
  webRing,
  meshRing,
  defaultRings,
  localServeRings,
  httpPostJson,
  overlapConfidence,
};
