/**
 * archive-grounding.js — safe archive.org grounding source (#940 / #919.5).
 *
 * Fetching/reading archive.org snapshots as grounding evidence is ALLOWED and
 * encouraged. Auto Save-Page-Now (SPN) pinning is BLOCKED without operator
 * consent because it leaks the URL of every read to a third party, violating
 * the local-first invariant.
 *
 * Public API:
 *   fetchArchiveSnapshot(url, options)  — fetch a Wayback Machine snapshot (allowed)
 *   requestSavePageNow(url, options)    — gate any SPN request through consent + redact
 *   isSavePinUrl(url)                  — returns true if the URL is a SPN endpoint
 *
 * Any code that makes a raw fetch to web.archive.org/save/* MUST use
 * requestSavePageNow() instead. The consent gate will reject it unless the
 * operator has explicitly approved the pinning action.
 */

"use strict";

const { redactPII } = require("./redact");

// ── Constants ─────────────────────────────────────────────────────────────────

const WAYBACK_BASE = "https://web.archive.org";
const SPN_PATH_PATTERN = /^\/save\//i;
const SPN_DIRECT_PATTERNS = [
  /https?:\/\/web\.archive\.org\/save\//i,
  /https?:\/\/pragma\.archivelab\.org/i, // alternative SPN endpoint
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if `url` is a Save-Page-Now pinning endpoint.
 * Used to intercept any accidental direct SPN calls.
 */
function isSavePinUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (SPN_DIRECT_PATTERNS.some((re) => re.test(url))) return true;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("archive.org") && SPN_PATH_PATTERN.test(parsed.pathname)) {
      return true;
    }
  } catch {
    // malformed URL — not a SPN endpoint
  }
  return false;
}

/**
 * Build the Wayback Machine CDX API URL to find the closest snapshot.
 */
function cdxUrl(targetUrl, timestamp = null) {
  const cdx = new URL(`${WAYBACK_BASE}/cdx/search/cdx`);
  cdx.searchParams.set("url", targetUrl);
  cdx.searchParams.set("output", "json");
  cdx.searchParams.set("fl", "timestamp,statuscode,original,mimetype,digest");
  cdx.searchParams.set("limit", "1");
  cdx.searchParams.set("filter", "statuscode:200");
  if (timestamp) cdx.searchParams.set("closest", timestamp);
  return cdx.toString();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch the latest available Wayback Machine snapshot of `url`.
 * This is a READ operation — no data leaves the node except the URL lookup,
 * which is the same as a normal HTTP request to a cached resource.
 *
 * @param {string} url             Target URL to retrieve from Wayback.
 * @param {object} [options]
 * @param {string} [options.timestamp]   YYYYMMDDHHMMSS — prefer snapshot near this time.
 * @param {Function} [options.fetchFn]   Injected fetch for testing (defaults to global fetch).
 * @returns {Promise<{ok: boolean, snapshotUrl: string|null, content: string|null, error: string|null}>}
 */
async function fetchArchiveSnapshot(url, { timestamp = null, fetchFn = null } = {}) {
  if (!url || typeof url !== "string") {
    return { ok: false, snapshotUrl: null, content: null, error: "url is required" };
  }

  if (isSavePinUrl(url)) {
    return {
      ok: false, snapshotUrl: null, content: null,
      error: "SPN pinning URLs must go through requestSavePageNow(), not fetchArchiveSnapshot()",
    };
  }

  const doFetch = fetchFn || (typeof fetch !== "undefined" ? fetch : null);
  if (!doFetch) {
    return { ok: false, snapshotUrl: null, content: null, error: "fetch not available" };
  }

  // Step 1: look up the CDX index to find the snapshot timestamp
  try {
    const cdx = cdxUrl(url, timestamp);
    const cdxResp = await doFetch(cdx);
    if (!cdxResp.ok) {
      return { ok: false, snapshotUrl: null, content: null, error: `CDX lookup failed: ${cdxResp.status}` };
    }
    const cdxData = await cdxResp.json();
    // cdxData[0] = headers row, cdxData[1] = first result
    if (!Array.isArray(cdxData) || cdxData.length < 2) {
      return { ok: false, snapshotUrl: null, content: null, error: "no snapshot found in Wayback" };
    }
    const [headers, row] = [cdxData[0], cdxData[1]];
    const tsIdx = headers.indexOf("timestamp");
    const snapTs = tsIdx >= 0 ? row[tsIdx] : null;
    if (!snapTs) {
      return { ok: false, snapshotUrl: null, content: null, error: "malformed CDX response" };
    }

    // Step 2: fetch the actual snapshot
    const snapshotUrl = `${WAYBACK_BASE}/web/${snapTs}/${url}`;
    const snapResp = await doFetch(snapshotUrl);
    if (!snapResp.ok) {
      return { ok: false, snapshotUrl, content: null, error: `snapshot fetch failed: ${snapResp.status}` };
    }
    const content = await snapResp.text();
    return { ok: true, snapshotUrl, content, error: null };
  } catch (e) {
    return { ok: false, snapshotUrl: null, content: null, error: e.message };
  }
}

/**
 * Request a Save-Page-Now pin — gates through the consent layer.
 *
 * The URL and any context content are redacted via redact.js BEFORE the consent
 * record is written. If the operator has not pre-approved SPN pinning, the request
 * is rejected with {ok: false, reason: "consent_required"} and nothing is sent.
 *
 * Implementing a full async consent flow is out of scope here; this function
 * enforces the gate so no SPN call can fire without going through it.
 *
 * @param {string} url   The URL to pin.
 * @param {object} [options]
 * @param {boolean} [options.operatorApproved=false]  Must be true to proceed.
 * @param {Function} [options.fetchFn]  Injected fetch for testing.
 * @returns {Promise<{ok: boolean, reason: string}>}
 */
async function requestSavePageNow(url, { operatorApproved = false, fetchFn = null } = {}) {
  if (!url || typeof url !== "string") {
    return { ok: false, reason: "url is required" };
  }

  // Redact any PII in the URL before any logging or consent record
  const redactedUrl = redactPII(url);

  if (!operatorApproved) {
    // Log the rejected attempt (redacted URL only — nothing sensitive leaves)
    console.warn(
      `[archive-grounding] SPN pin blocked for ${redactedUrl} — operator consent required (#940)`
    );
    return { ok: false, reason: "consent_required", url: redactedUrl };
  }

  // Operator explicitly approved: proceed with the SPN request
  const spnUrl = `${WAYBACK_BASE}/save/${url}`;
  const doFetch = fetchFn || (typeof fetch !== "undefined" ? fetch : null);
  if (!doFetch) {
    return { ok: false, reason: "fetch not available" };
  }

  try {
    const resp = await doFetch(spnUrl, { method: "GET" });
    if (!resp.ok) {
      return { ok: false, reason: `SPN returned ${resp.status}` };
    }
    return { ok: true, reason: "pinned", url: redactedUrl };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

module.exports = {
  fetchArchiveSnapshot,
  requestSavePageNow,
  isSavePinUrl,
};
