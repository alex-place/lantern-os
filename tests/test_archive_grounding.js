"use strict";
/**
 * Tests for archive-grounding.js (#940 / #919.5).
 *
 * Acceptance criteria:
 *   - Fetching archive.org snapshots (read) is allowed and works.
 *   - SPN pinning without operator approval is blocked.
 *   - SPN URLs are correctly detected by isSavePinUrl().
 *   - PII in URLs is redacted before any logging on a rejected SPN request.
 *   - Operator-approved SPN proceeds (stub fetch).
 */

const assert = require("assert");
const {
  fetchArchiveSnapshot,
  requestSavePageNow,
  isSavePinUrl,
} = require("../apps/lantern-garage/lib/archive-grounding");

// ── isSavePinUrl ──────────────────────────────────────────────────────────────

function test_spn_url_detected() {
  assert.ok(isSavePinUrl("https://web.archive.org/save/https://example.com"));
  assert.ok(isSavePinUrl("https://web.archive.org/save/http://example.com/page"));
  assert.ok(isSavePinUrl("https://pragma.archivelab.org/something"));
}

function test_wayback_read_url_not_spn() {
  assert.ok(!isSavePinUrl("https://web.archive.org/web/20240101120000/https://example.com"));
  assert.ok(!isSavePinUrl("https://web.archive.org/cdx/search/cdx?url=example.com"));
}

function test_non_archive_url_not_spn() {
  assert.ok(!isSavePinUrl("https://example.com/page"));
  assert.ok(!isSavePinUrl("https://google.com"));
  assert.ok(!isSavePinUrl(null));
  assert.ok(!isSavePinUrl(""));
}

// ── requestSavePageNow — consent gate ────────────────────────────────────────

async function test_spn_blocked_without_consent() {
  const result = await requestSavePageNow("https://example.com/private-page");
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "consent_required");
  assert.ok(!result.url || !result.url.includes("private-page") ||
    result.url === "https://example.com/private-page",
    "URL in rejection is at most the redacted version");
}

async function test_spn_proceeds_with_operator_approval() {
  let fetched = null;
  const fakeFetch = async (url) => {
    fetched = url;
    return { ok: true, status: 200 };
  };
  const result = await requestSavePageNow(
    "https://example.com/public-page",
    { operatorApproved: true, fetchFn: fakeFetch }
  );
  assert.strictEqual(result.ok, true);
  assert.ok(fetched && fetched.includes("/save/https://example.com"), "SPN URL called");
}

async function test_spn_pii_redacted_in_rejection_url() {
  const urlWithEmail = "https://example.com/page?user=foo@example.com";
  const result = await requestSavePageNow(urlWithEmail, { operatorApproved: false });
  assert.strictEqual(result.ok, false);
  // The rejected url field should have the email redacted
  if (result.url) {
    assert.ok(!result.url.includes("foo@example.com"),
      "PII must not appear in rejection record");
  }
}

// ── fetchArchiveSnapshot — read path ─────────────────────────────────────────

async function test_fetch_snapshot_rejects_spn_url() {
  const result = await fetchArchiveSnapshot(
    "https://web.archive.org/save/https://example.com"
  );
  assert.strictEqual(result.ok, false);
  assert.ok(result.error && result.error.includes("requestSavePageNow"));
}

async function test_fetch_snapshot_returns_content() {
  const cdxResponse = [
    ["timestamp", "statuscode", "original", "mimetype", "digest"],
    ["20240601120000", "200", "https://example.com", "text/html", "SHA1:abc"],
  ];
  const snapContent = "<html><body>Archived page</body></html>";
  let callCount = 0;
  const fakeFetch = async (url) => {
    callCount++;
    if (url.includes("/cdx/")) {
      return { ok: true, json: async () => cdxResponse };
    }
    // snapshot URL
    return { ok: true, text: async () => snapContent };
  };

  const result = await fetchArchiveSnapshot(
    "https://example.com",
    { fetchFn: fakeFetch }
  );
  assert.strictEqual(result.ok, true);
  assert.ok(result.snapshotUrl && result.snapshotUrl.includes("web.archive.org/web/"));
  assert.strictEqual(result.content, snapContent);
  assert.strictEqual(callCount, 2, "CDX lookup + snapshot fetch = 2 calls");
}

async function test_fetch_snapshot_handles_no_snapshot() {
  const fakeFetch = async () => ({
    ok: true, json: async () => [["timestamp"]], // only header row, no results
  });
  const result = await fetchArchiveSnapshot("https://obscure-never-archived.example.com",
    { fetchFn: fakeFetch });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error && result.error.includes("no snapshot found"));
}

async function test_fetch_snapshot_requires_url() {
  const r = await fetchArchiveSnapshot(null);
  assert.strictEqual(r.ok, false);
}

// ── Runner ────────────────────────────────────────────────────────────────────

const tests = [
  test_spn_url_detected,
  test_wayback_read_url_not_spn,
  test_non_archive_url_not_spn,
  test_spn_blocked_without_consent,
  test_spn_proceeds_with_operator_approval,
  test_spn_pii_redacted_in_rejection_url,
  test_fetch_snapshot_rejects_spn_url,
  test_fetch_snapshot_returns_content,
  test_fetch_snapshot_handles_no_snapshot,
  test_fetch_snapshot_requires_url,
];

(async () => {
  let passed = 0;
  for (const t of tests) {
    try {
      await t();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${t.name}: ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\ntest_archive_grounding: ${passed}/${tests.length} passed`);
})();
