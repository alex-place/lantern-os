"use strict";
/**
 * archive.org grounding guard (#940 / #919.5).
 *
 * Reading archive.org for grounding is ALLOWED (search / details / Wayback reads have
 * no side effects). **Save-Page-Now pinning** (`web.archive.org/save`) PUBLISHES
 * content to a third party, so it is default-DENY: it must carry explicit operator
 * consent and have its submitted content PII-redacted first. No SPN code exists in the
 * repo today; this guard + its test keep the invariant from regressing — any future
 * pin MUST go through `pinToArchive`.
 */
const { redactPII } = require("./redact");

const ARCHIVE_HOSTS = new Set(["archive.org", "web.archive.org", "www.archive.org"]);

function _url(u) { try { return new URL(u); } catch { return null; } }

/** Read-only archive grounding URL? (archive host, and NOT the /save pin endpoint). */
function isReadOnlyArchiveUrl(url) {
  const u = _url(url);
  if (!u || !ARCHIVE_HOSTS.has(u.host.toLowerCase())) return false;
  if (u.pathname.toLowerCase().startsWith("/save")) return false; // SPN pin endpoint
  return true;
}

/** Throw unless `url` is a read-only archive grounding URL. */
function assertReadOnlyArchive(url) {
  if (!isReadOnlyArchiveUrl(url)) {
    throw new Error(`not a read-only archive.org grounding URL: ${url}`);
  }
  return url;
}

/**
 * Save-Page-Now PINNING — default-deny. Returns the descriptor for a /save POST only
 * when `operatorApproved === true`; the submitted content is PII-redacted first.
 * Throws otherwise — it never silently pins.
 */
function pinToArchive(url, { operatorApproved = false, content = "" } = {}) {
  if (operatorApproved !== true) {
    throw new Error("Save-Page-Now pinning requires operator consent (#940)");
  }
  const u = _url(url);
  if (!u || !ARCHIVE_HOSTS.has(u.host.toLowerCase())) {
    throw new Error(`refusing to pin a non-archive host: ${url}`);
  }
  // Redact PII from the submitted page content before it leaves the machine. The
  // target URL is preserved (you cannot archive a redacted URL) — callers must not
  // put secrets in archived URLs.
  return {
    saveEndpoint: `https://web.archive.org/save/${url}`,
    redactedContent: redactPII(String(content || "")),
    operatorApproved: true,
  };
}

module.exports = { isReadOnlyArchiveUrl, assertReadOnlyArchive, pinToArchive, ARCHIVE_HOSTS };
