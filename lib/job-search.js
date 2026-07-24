"use strict";
/**
 * job-search.js — live job-openings search for the chat assistant's `job_search` tool.
 *
 * A useful job search needs (1) a real title/keyword and (2) a location context. We
 * default to REMOTE roles open to US applicants (geo=usa) and also accept a location
 * (US city/state/ZIP, or a region like uk/europe/canada). Postings come from real,
 * keyless boards — Jobicy (geo + keyword filtering) as primary, Remotive as a
 * US-eligible fallback. Listings are REAL with real apply URLs; never fabricated
 * (Σ₀ External Reality Rule). If the boards are unreachable it says so.
 *
 * Loop stage: Observe (real external job data) + Act (search on the user's behalf).
 * One capability behind the ADR-0008 tool registry — no new subsystem, no per-user store.
 */

const https = require("https");

function _httpGetJson(urlStr, timeoutMs = 8000, redirects = 3) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let u;
    try { u = new URL(urlStr); } catch { return finish({ error: "bad_url" }); }
    const req = https.get(
      { hostname: u.hostname, path: u.pathname + u.search, headers: { "User-Agent": "KeystoneOS-JobSearch/1.0", Accept: "application/json" } },
      (res) => {
        const sc = res.statusCode || 0;
        if (sc >= 300 && sc < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return finish(_httpGetJson(new URL(res.headers.location, u).toString(), timeoutMs, redirects - 1));
        }
        if (sc !== 200) { res.resume(); return finish({ error: `http_${sc}` }); }
        let b = "";
        res.on("data", (c) => { b += c; if (b.length > 12e6) req.destroy(); });
        res.on("end", () => { try { finish({ ok: true, data: JSON.parse(b) }); } catch { finish({ error: "bad_json" }); } });
      }
    );
    req.on("error", () => finish({ error: "unreachable" }));
    req.setTimeout(timeoutMs, () => { req.destroy(); finish({ error: "timeout" }); });
  });
}

function _tokens(q) {
  return String(q || "").toLowerCase().split(/[^a-z0-9+#.]+/).filter((t) => t.length > 2);
}
function _relevant(hay, tokens) {
  if (!tokens.length) return true;
  const h = String(hay || "").toLowerCase();
  return tokens.some((t) => h.includes(t));
}
// Map a free-text location to Jobicy's region `geo`. A US city/state/ZIP → "usa".
function _geoFromLocation(location) {
  const l = String(location || "").toLowerCase().trim();
  if (!l || l === "remote") return "usa";
  if (/(united kingdom|\buk\b|england|scotland|london|britain)/.test(l)) return "uk";
  if (/(canada|toronto|vancouver|ontario)/.test(l)) return "canada";
  if (/(europe|\beu\b|germany|france|spain|netherlands|berlin|munich|amsterdam|paris)/.test(l)) return "europe";
  if (/(australia|sydney|melbourne)/.test(l)) return "australia";
  return "usa"; // US state/city/ZIP or anything else → US-eligible remote
}
// Remote postings that a US applicant can take: explicit US, North America, or open-to-all.
function _usEligible(loc) {
  const l = String(loc || "").toLowerCase();
  return /(usa|u\.s|united states|north america|americas|anywhere|worldwide|remote)/.test(l) &&
    !/only\)?\s*$/.test(l.replace(/usa only/, "usa")); // keep "USA Only", drop "Europe Only" etc.
}

function _salaryStr(min, max) {
  const k = (n) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`);
  if (min && max) return `${k(min)}–${k(max)}`;
  if (min) return `${k(min)}+`;
  return null;
}

async function _jobicy(q, geo, toks, n) {
  const tag = q ? `&tag=${encodeURIComponent(q)}` : "";
  let r = await _httpGetJson(`https://jobicy.com/api/v2/remote-jobs?count=${Math.min(50, n * 4)}&geo=${encodeURIComponent(geo)}${tag}`);
  // A too-narrow tag can return nothing — retry geo-only and filter client-side.
  let jobs = r.ok ? (r.data && r.data.jobs) || [] : null;
  if (r.ok && q && jobs.length === 0) {
    r = await _httpGetJson(`https://jobicy.com/api/v2/remote-jobs?count=${Math.min(50, n * 4)}&geo=${encodeURIComponent(geo)}`);
    jobs = r.ok ? (r.data && r.data.jobs) || [] : null;
  }
  if (!r.ok) return { error: r.error };
  const mapped = jobs
    .map((j) => ({
      title: j.jobTitle, company: j.companyName,
      location: j.jobGeo || "Remote",
      url: j.url, category: Array.isArray(j.jobIndustry) ? j.jobIndustry[0] : j.jobIndustry || null,
      salary: _salaryStr(j.annualSalaryMin, j.annualSalaryMax), posted: (j.pubDate || "").slice(0, 10),
    }))
    .filter((j) => _relevant(`${j.title} ${j.category || ""}`, toks));
  return { ok: true, jobs: mapped };
}

async function _remotive(q, geo, toks) {
  const r = await _httpGetJson("https://remotive.com/api/remote-jobs?limit=150");
  if (!r.ok) return { error: r.error };
  const jobs = ((r.data && r.data.jobs) || [])
    .map((j) => ({
      title: j.title, company: j.company_name,
      location: j.candidate_required_location || "Remote",
      url: j.url, category: j.category || null,
      salary: j.salary || null, posted: (j.publication_date || "").slice(0, 10),
    }))
    .filter((j) => _relevant(`${j.title} ${j.category || ""}`, toks))
    .filter((j) => (geo === "usa" ? _usEligible(j.location) : true));
  return { ok: true, jobs };
}

/**
 * Search live postings for `query` (a title/keyword — required for a useful search).
 * Defaults to remote roles open to US applicants; `location` narrows the region. Returns
 * { ok, query, geo, location, source, count, jobs[] } or { error } if all boards are down,
 * or { needQuery:true } if no title/keyword was supplied.
 */
async function searchJobs({ query, location, limit } = {}) {
  const q = String(query || "").trim();
  if (!q) return { needQuery: true };
  const geo = _geoFromLocation(location);
  const n = Math.max(1, Math.min(15, parseInt(limit, 10) || 6));
  const toks = _tokens(q);

  const [job, rem] = await Promise.all([_jobicy(q, geo, toks, n), _remotive(q, geo, toks)]);
  if (!job.ok && !rem.ok) return { error: job.error || rem.error || "unreachable" };

  const seen = new Set();
  const jobs = [];
  for (const j of [].concat(job.ok ? job.jobs : [], rem.ok ? rem.jobs : [])) {
    if (!j.url || !j.title || seen.has(j.url)) continue;
    seen.add(j.url);
    jobs.push(j);
    if (jobs.length >= n) break;
  }
  const source = [
    job.ok && job.jobs.length ? "jobicy" : null,
    rem.ok && rem.jobs.length ? "remotive" : null,
  ].filter(Boolean).join("+") || (job.ok ? "jobicy" : "remotive");
  return { ok: true, query: q, geo, location: location || null, source, count: jobs.length, jobs };
}

module.exports = { searchJobs };
