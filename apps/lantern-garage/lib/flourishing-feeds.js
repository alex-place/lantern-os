// Flourishing feeds — grounds the world-model beliefs from MULTIPLE real public sources.
//
// Ports the honesty discipline of the Human Flourishing Frameworks world_model into the
// Lantern loop, and adds the External-Reality Rule's core: every important belief is
// corroborated by ≥2 INDEPENDENT sources. Each source produces a normalized observation
// in [0,1] with its own uncertainty + provenance; the belief's posterior FUSES them by
// inverse-variance weighting, and the fused uncertainty is INFLATED by between-source
// disagreement. Independent agreement tightens the belief; conflict widens it — coherence
// is earned from corroboration, not asserted.
//
// Sources (all keyless): World Bank (world aggregates), Our World in Data (grapher CSV),
// IUCN Red List + WWF/ZSL Living Planet Index (via OWID). The map from a raw indicator to
// a flourishing score is a value-laden CHOICE — carried as per-source uncertainty.
//
// Observe (poll) → Remember (cache) → Reason (rank what to ground next) →
// Verify (provenance + corroboration) → Converge (fused domain posteriors).

const https = require("https");

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── belief → multiple sources ────────────────────────────────────────────────
// Each source: provider label, kind (wb|owid), id (WB code | OWID slug), and a linear
// normalization (floor→0, ceil→1; ceil may be < floor for "lower is better"). `u` is the
// source's own uncertainty (includes the normalization-is-a-choice penalty). All ids
// confirmed to return a World value (2026-06-25).
const BELIEFS = [
  { entity: "humans:health", domain: "humans", label: "Life expectancy", sources: [
    { provider: "World Bank", kind: "wb", id: "SP.DYN.LE00.IN", floor: 40, ceil: 85, unit: "years", u: 0.10 },
    { provider: "Our World in Data", kind: "owid", id: "life-expectancy", floor: 40, ceil: 85, unit: "years", u: 0.10 },
  ]},
  { entity: "humans:health:children", domain: "humans", label: "Child survival", sources: [
    { provider: "World Bank", kind: "wb", id: "SH.DYN.MORT", floor: 180, ceil: 0, unit: "per 1,000", u: 0.10 },
    { provider: "Our World in Data", kind: "owid", id: "child-mortality", floor: 18, ceil: 0, unit: "%", u: 0.10 },
  ]},
  { entity: "humans:opportunity", domain: "humans", label: "Access to electricity", sources: [
    { provider: "World Bank", kind: "wb", id: "EG.ELC.ACCS.ZS", floor: 0, ceil: 100, unit: "%", u: 0.12 },
    { provider: "Our World in Data", kind: "owid", id: "share-of-the-population-with-access-to-electricity", floor: 0, ceil: 100, unit: "%", u: 0.12 },
  ]},
  { entity: "humans:education", domain: "humans", label: "Secondary schooling", sources: [
    { provider: "World Bank", kind: "wb", id: "SE.SEC.ENRR", floor: 0, ceil: 100, unit: "% gross", u: 0.15 },
    { provider: "Our World in Data", kind: "owid", id: "gross-enrolment-ratio-in-secondary-education", floor: 0, ceil: 100, unit: "% gross", u: 0.15 },
  ]},
  { entity: "ecosystems:protected_areas", domain: "ecosystems", label: "Protected areas (vs 30×30 target)", proxy: true, sources: [
    { provider: "World Bank", kind: "wb", id: "ER.PTD.TOTL.ZS", floor: 0, ceil: 30, unit: "% of territory", u: 0.18 },
    { provider: "Our World in Data", kind: "owid", id: "terrestrial-protected-areas", floor: 0, ceil: 30, unit: "% of land", u: 0.20 },
  ]},
  { entity: "ecosystems:clean_energy", domain: "ecosystems", label: "Renewable energy share (vs 50% transition)", proxy: true, sources: [
    { provider: "World Bank", kind: "wb", id: "EG.FEC.RNEW.ZS", floor: 0, ceil: 50, unit: "% final energy", u: 0.18 },
    { provider: "Our World in Data", kind: "owid", id: "renewable-share-energy", floor: 0, ceil: 50, unit: "% primary energy", u: 0.18 },
  ]},
  { entity: "animals:extinction_risk", domain: "animals", label: "Red List Index (species survival)", sources: [
    { provider: "IUCN (via OWID)", kind: "owid", id: "red-list-index", floor: 0, ceil: 1, unit: "index 0–1", u: 0.12 },
  ]},
  { entity: "animals:wild_populations", domain: "animals", label: "Living Planet Index (wild populations vs 1970)", proxy: true, sources: [
    { provider: "WWF/ZSL (via OWID)", kind: "owid", id: "global-living-planet-index", floor: 0, ceil: 100, unit: "% of 1970", u: 0.28 },
  ]},
];

function normalize(s, raw) { return clamp01((raw - s.floor) / (s.ceil - s.floor)); }

// ── raw fetchers (keyless, with retry — both APIs rate-limit rapid requests) ──
function getText(url, timeoutMs = 11000) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { "User-Agent": "LanternOS-Flourishing/1.0" } }, (resp) => {
      let body = "";
      resp.on("data", (c) => (body += c));
      resp.on("end", () => resolve(body));
    });
    req.on("error", () => resolve(""));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(""); });
  });
}
async function getJson(url) { try { return JSON.parse(await getText(url)); } catch { return null; } }

async function fetchWB(code, tries = 4) {
  const url = `https://api.worldbank.org/v2/country/WLD/indicator/${code}?format=json&per_page=1&mrnev=1`;
  for (let i = 0; i < tries; i++) {
    const d = await getJson(url);
    const rec = Array.isArray(d) && Array.isArray(d[1]) ? d[1][0] : null;
    if (rec && rec.value != null) return { raw: Number(rec.value), year: rec.date, source: url };
    if (i < tries - 1) await sleep(900);
  }
  return null;
}

async function fetchOWID(slug, tries = 3) {
  const url = `https://ourworldindata.org/grapher/${slug}.csv`;
  for (let i = 0; i < tries; i++) {
    const t = await getText(url);
    if (t && t.includes("OWID_WRL")) {
      let best = null;
      for (const line of t.split("\n")) {
        const f = line.split(",");
        if (f[1] === "OWID_WRL") {
          const y = parseInt(f[2], 10), v = parseFloat(f[3]);
          if (!isNaN(v) && (!best || y > best.year)) best = { raw: v, year: y };
        }
      }
      if (best) return { raw: best.raw, year: String(best.year), source: `https://ourworldindata.org/grapher/${slug}` };
    }
    if (i < tries - 1) await sleep(900);
  }
  return null;
}

// ── fuse a belief from its sources (the corroboration core) ──────────────────
async function fuseBelief(belief) {
  const obs = [];
  for (const s of belief.sources) {
    const raw = s.kind === "wb" ? await fetchWB(s.id) : await fetchOWID(s.id);
    await sleep(250);
    if (!raw) continue;
    obs.push({ provider: s.provider, p: Number(normalize(s, raw.raw).toFixed(4)), u: s.u,
               raw: raw.raw, year: raw.year, unit: s.unit, source: raw.source });
  }
  if (!obs.length) return null;
  // inverse-variance (precision) weighted posterior
  let wsum = 0, psum = 0;
  for (const o of obs) { const w = 1 / (o.u * o.u); wsum += w; psum += w * o.p; }
  const posterior = psum / wsum;
  const uBase = Math.sqrt(1 / wsum);
  // between-source disagreement (population std of the source posteriors)
  const mean = obs.reduce((a, o) => a + o.p, 0) / obs.length;
  const spread = Math.sqrt(obs.reduce((a, o) => a + (o.p - mean) ** 2, 0) / obs.length);
  const uncertainty = Math.sqrt(uBase * uBase + spread * spread);   // corroboration tightens, conflict widens
  return {
    entity: belief.entity, domain: belief.domain, label: belief.label, proxy: !!belief.proxy,
    posterior: Number(posterior.toFixed(4)), uncertainty: Number(uncertainty.toFixed(4)),
    n_sources: obs.length,
    agreement: obs.length < 2 ? "single-source" : (spread < 0.05 ? "corroborated" : "divergent"),
    spread: Number(spread.toFixed(4)),
    sources: obs.map((o) => ({ provider: o.provider, raw: o.raw, year: o.year, unit: o.unit, normalized: o.p, source: o.source })),
    kind: "grounded_feed",
  };
}

// ── domain posteriors (precision-weighted) ───────────────────────────────────
function domainScores(beliefs) {
  const byDomain = {};
  for (const b of beliefs) (byDomain[b.domain] ||= []).push(b);
  const out = [];
  for (const [domain, list] of Object.entries(byDomain)) {
    let wsum = 0, psum = 0;
    for (const b of list) { const w = 1 / (b.uncertainty * b.uncertainty); wsum += w; psum += w * b.posterior; }
    out.push({ domain, score: Number((psum / wsum).toFixed(4)),
               uncertainty: Number(Math.sqrt(1 / wsum).toFixed(4)),
               n: list.length, n_sources: list.reduce((a, b) => a + b.n_sources, 0) });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ── the Question Machine, applied: what to ground next ────────────────────────
// score = uncertainty × leverage. A single-source or divergent belief is the highest-
// leverage place to add another source — exactly what the loop should ask to ground.
function nextQuestions(beliefs, topK = 3) {
  const byDomain = {};
  for (const b of beliefs) (byDomain[b.domain] ||= []).push(b);
  const scored = beliefs.map((b) => {
    const sib = byDomain[b.domain];
    const sibU = sib.reduce((s, x) => s + x.uncertainty, 0);
    const leverage = sibU > 0 ? b.uncertainty / sibU : 1;
    const corroborationBonus = b.n_sources < 2 ? 1.3 : 1.0;            // prefer adding a 2nd source
    return { ...b, q_score: Number((b.uncertainty * leverage * corroborationBonus).toFixed(4)) };
  });
  scored.sort((a, b) => b.q_score - a.q_score);
  return scored.slice(0, topK).map((b) => ({
    entity: b.entity, n_sources: b.n_sources, agreement: b.agreement, uncertainty: b.uncertainty, q_score: b.q_score,
    hypothesis: b.n_sources < 2
      ? `corroborate ${b.entity} with a 2nd source — currently single-source (${b.sources[0].provider}), ±${(b.uncertainty * 100).toFixed(0)}%`
      : `re-ground ${b.entity} — ${b.n_sources} sources ${b.agreement}, ±${(b.uncertainty * 100).toFixed(0)}%`,
  }));
}

// ── cross-domain correlation — REAL patterns, not trivial outliers ───────────
const CORR_PAIRS = [
  { a: "SP.DYN.LE00.IN", b: "EG.ELC.ACCS.ZS", label: "life expectancy ↔ electricity access", coupling: "humans:health × humans:opportunity" },
  { a: "SP.DYN.LE00.IN", b: "SE.SEC.ENRR", label: "life expectancy ↔ schooling", coupling: "humans:health × humans:education" },
  { a: "SH.DYN.MORT", b: "SE.SEC.ENRR", label: "child mortality ↔ schooling", coupling: "humans:health × humans:education" },
  { a: "SP.DYN.LE00.IN", b: "EG.FEC.RNEW.ZS", label: "life expectancy ↔ renewable-energy share", coupling: "humans:health × ecosystems:climate" },
];

let _realIso = null;
async function realCountrySet() {
  if (_realIso) return _realIso;
  for (let i = 0; i < 3; i++) {
    const d = await getJson("https://api.worldbank.org/v2/country?format=json&per_page=400");
    if (Array.isArray(d) && Array.isArray(d[1])) {
      const s = new Set();
      for (const c of d[1]) if (c.region && c.region.id && c.region.id !== "NA") s.add(c.id);
      if (s.size) { _realIso = s; return s; }
    }
    await sleep(900);
  }
  return new Set();
}

async function fetchPerCountry(code, realSet, tries = 3) {
  const url = `https://api.worldbank.org/v2/country/all/indicator/${code}?format=json&per_page=400&mrnev=1`;
  for (let i = 0; i < tries; i++) {
    const d = await getJson(url);
    if (Array.isArray(d) && Array.isArray(d[1])) {
      const out = {};
      for (const r of d[1]) {
        if (r && r.value != null && r.countryiso3code &&
            (realSet.size === 0 || realSet.has(r.countryiso3code))) out[r.countryiso3code] = Number(r.value);
      }
      if (Object.keys(out).length) return out;
    }
    if (i < tries - 1) await sleep(900);
  }
  return {};
}

function pearson(pairs) {
  const n = pairs.length;
  if (n < 8) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pairs) { sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
  const cov = sxy - (sx * sy) / n, vx = sxx - (sx * sx) / n, vy = syy - (sy * sy) / n;
  if (vx <= 0 || vy <= 0) return null;
  return cov / Math.sqrt(vx * vy);
}

let corrCache = { at: 0, items: [] };
async function correlations(force = false) {
  if (!force && Date.now() - corrCache.at < TTL_MS && corrCache.items.length) return corrCache.items;
  const realSet = await realCountrySet();
  const series = {};
  const codes = [...new Set(CORR_PAIRS.flatMap((p) => [p.a, p.b]))];
  for (const c of codes) { series[c] = await fetchPerCountry(c, realSet); await sleep(350); }
  const items = [];
  for (const p of CORR_PAIRS) {
    const A = series[p.a], B = series[p.b], pairs = [];
    for (const iso of Object.keys(A)) if (iso in B) pairs.push([A[iso], B[iso]]);
    const r = pearson(pairs);
    if (r != null) items.push({ label: p.label, coupling: p.coupling, r: Number(r.toFixed(3)), n: pairs.length,
      strength: Math.abs(r) >= 0.7 ? "strong" : Math.abs(r) >= 0.4 ? "moderate" : "weak",
      direction: r >= 0 ? "positive" : "negative" });
  }
  items.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  if (items.length) corrCache = { at: Date.now(), items };
  return items;
}

// ── cache + public surface ───────────────────────────────────────────────────
const TTL_MS = 24 * 60 * 60 * 1000;
let cache = { at: 0, beliefs: [] };

async function pollFeeds(force = false) {
  if (!force && Date.now() - cache.at < TTL_MS && cache.beliefs.length) return cache.beliefs;
  const results = [];
  for (const b of BELIEFS) { const fused = await fuseBelief(b); if (fused) results.push(fused); }
  if (results.length) cache = { at: Date.now(), beliefs: results };
  return cache.beliefs;
}

async function panel(force = false) {
  const beliefs = await pollFeeds(force);
  const covered = [...new Set(beliefs.map((b) => b.domain))];
  const providers = [...new Set(beliefs.flatMap((b) => b.sources.map((s) => s.provider)))];
  const corroborated = beliefs.filter((b) => b.n_sources >= 2).length;
  return {
    ok: beliefs.length > 0,
    updated_at: cache.at ? new Date(cache.at).toISOString() : null,
    domains: domainScores(beliefs),
    questions: nextQuestions(beliefs),
    beliefs,
    corroboration: { beliefs: beliefs.length, multi_source: corroborated, providers },
    ungrounded_domains: ["universe"].filter((d) => !covered.includes(d)),
    sources: providers,
    note: "Each belief fused from independent sources; agreement tightens its uncertainty, " +
          "disagreement widens it (the External-Reality Rule). Normalization to a flourishing " +
          "score is a value-laden choice, carried as per-source uncertainty.",
  };
}

module.exports = { pollFeeds, panel, domainScores, nextQuestions, correlations, fuseBelief, BELIEFS };

// CLI probe: `node lib/flourishing-feeds.js`
if (require.main === module) {
  (async () => {
    const p = await panel(true);
    console.log("updated:", p.updated_at, "| domains:", p.domains.length, "| multi-source beliefs:",
                p.corroboration.multi_source + "/" + p.corroboration.beliefs);
    for (const d of p.domains) console.log(`  ${d.domain.padEnd(11)} ${(d.score * 100).toFixed(0)}%  ±${(d.uncertainty * 100).toFixed(0)}%  (${d.n} beliefs, ${d.n_sources} sources)`);
    console.log("beliefs (corroboration):");
    for (const b of p.beliefs) console.log(`  ${b.entity.padEnd(28)} ${(b.posterior * 100).toFixed(0)}% ±${(b.uncertainty * 100).toFixed(0)}%  [${b.n_sources} src ${b.agreement}] ${b.sources.map((s) => s.provider + " " + s.raw + (s.unit ? "" : "")).join(" | ")}`);
    console.log("next questions:");
    for (const q of p.questions) console.log("  -", q.hypothesis);
  })();
}
