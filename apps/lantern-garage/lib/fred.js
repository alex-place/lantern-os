'use strict';

/**
 * fred.js — the St. Louis Fed's FRED data, through its keyless CSV endpoint (2026-10-11).
 *
 * WHY THIS ENDPOINT. fredgraph.csv needs no API key and carries several series in one
 * request: `id`, `cosd` (start date) and `transformation` each take a comma-separated list,
 * one entry per series. So an economy page is three requests — the monthly figures, the
 * weekly ones and the daily rates — not one per indicator. FRED applies the transformation
 * itself (pc1 = % change from a year earlier, pch = % change, chg = change), so a year-on-
 * year inflation figure is FRED's own, not one recomputed here.
 *
 * IT NAMES ITSELF. FRED never answers a request with no User-Agent, nor a bare
 * "Mozilla/5.0" one: it holds the connection until the client gives up. (That is how
 * lib/sigma-trader's benchmark fetch spent 8 seconds a call on a 4.5% fallback.)
 *
 * Every id and date it is handed comes from a fixed list in the caller, never from a
 * request, and the cache is bounded by that list.
 */

const https = require('https');

const UA = 'Mozilla/5.0 (compatible; unisona.ai/1.0; +https://unisona.ai)';
const TIMEOUT_MS = 15000;
const MAX_BODY = 4 * 1024 * 1024;
const TTL = 3 * 3600e3;       // FRED series move at most daily
const FAIL_TTL = 2 * 60e3;    // a failed request is retried after two minutes, not three hours

function get(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'text/csv,*/*' } }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; if (d.length > MAX_BODY) req.destroy(); });
      res.on('end', () => finish({ status: res.statusCode, body: d }));
      res.on('close', () => finish({ status: 0, body: '' }));
    });
    req.on('error', () => finish({ status: 0, body: '' }));
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
  });
}

/** FRED's CSV: a header "observation_date,ID1,ID2_PC1,…", then a row per date. A blank
 *  (or ".") cell is a date that series has no observation for — mixed frequencies in one
 *  request leave the monthly columns blank on a quarterly date and so on. Columns are
 *  matched to `ids` by POSITION: a transformation renames the header (CPIAUCSL_PC1). */
function parseCsv(text, ids) {
  const lines = String(text || '').trim().split(/\r?\n/);
  if (lines.length < 2 || !/^observation_date,/.test(lines[0])) return null;
  if (lines[0].split(',').length - 1 !== ids.length) return null;
  const out = {};
  for (const id of ids) out[id] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const date = cells[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    for (let k = 0; k < ids.length; k++) {
      const v = cells[k + 1];
      if (v == null || v === '' || v === '.') continue;
      const n = Number(v);
      if (Number.isFinite(n)) out[ids[k]].push([date, n]);
    }
  }
  return out;
}

function isZip(body) { return String(body || '').slice(0, 2) === 'PK'; }

const _cache = new Map();     // request key -> { val, at, ttl }
const _flights = new Map();
function flight(key, fn) {
  if (_flights.has(key)) return _flights.get(key);
  const p = Promise.resolve().then(fn).finally(() => _flights.delete(key));
  _flights.set(key, p);
  return p;
}

/**
 * Several series in one request: { ID: [[YYYY-MM-DD, value], …], … }, or null when FRED
 * did not answer. `transforms` is one FRED transformation code per id ('lin' = as published).
 *
 * FRED joins series into one CSV only when they share a native frequency. Otherwise it
 * answers 200 with a ZIP — one CSV per series and a README — which is not a CSV at all. The
 * caller groups its requests by frequency so that does not happen; if it does anyway, each
 * series is asked for on its own.
 */
async function series(ids, { since, transforms } = {}) {
  if (!Array.isArray(ids) || !ids.length) return null;
  const tr = transforms && transforms.length === ids.length ? transforms : null;
  const key = ids.join(',') + '|' + (since || '') + '|' + (tr ? tr.join(',') : '');
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.val;
  return flight(key, async () => {
    let q = 'id=' + ids.map(encodeURIComponent).join(',');
    if (since) q += '&cosd=' + ids.map(() => since).join(',');
    if (tr) q += '&transformation=' + tr.join(',');
    const r = await get('https://fred.stlouisfed.org/graph/fredgraph.csv?' + q);
    let val = r.status === 200 ? parseCsv(r.body, ids) : null;
    if (!val && ids.length > 1 && r.status === 200 && isZip(r.body)) {
      val = {};
      for (let i = 0; i < ids.length; i++) {
        const one = await series([ids[i]], { since, transforms: tr ? [tr[i]] : undefined });
        if (!one) { val = null; break; }
        val[ids[i]] = one[ids[i]];
      }
    }
    _cache.set(key, { val, at: Date.now(), ttl: val ? TTL : FAIL_TTL });
    return val;
  });
}

module.exports = { series, _parseCsv: parseCsv, _isZip: isZip, _UA: UA, _reset() { _cache.clear(); _flights.clear(); } };
