// Unit tests for the Creator Intelligence analytics-calibration module.
// Standalone: `node tests/test_creator_calibration.js`. Writes to an isolated
// temp data dir (LANTERN_CI_DATA_DIR) so real data is never touched.

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Isolate storage BEFORE requiring the stores (paths are resolved lazily, but
// set it first to be safe).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ci-calib-"));
process.env.LANTERN_CI_DATA_DIR = TMP;

const importer = require("../src/creator-intelligence/calibration/youtube-analytics-import");
const store = require("../src/creator-intelligence/calibration/outcome-store");
const engine = require("../src/creator-intelligence/calibration/calibration-engine");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n        ${err.message}`); process.exitCode = 1; }
}

// ── CSV parsing ────────────────────────────────────────────────────────────
const SAMPLE_CSV = [
  "Content,Video title,Video publish time,Views,Watch time (hours),Average view duration,Average percentage viewed (%),Impressions,Impressions click-through rate (%),Subscribers",
  "Total,,,12345,210.5,0:24,55.2,90000,4.10,120",
  'abc123,"Insane clutch, 1v4!",2026-05-01,8200,140.2,0:31,71.4,40000,5.20,80',
  "def456,Funny fail montage,2026-05-03,1500,9.1,0:12,28.0,12000,2.10,5",
  ",,,,,,,,,",  // empty row -> skipped
].join("\n");

test("parseAnalyticsCsv maps columns and skips the Total/empty rows", () => {
  const r = importer.parseAnalyticsCsv(SAMPLE_CSV);
  assert.strictEqual(r.rows.length, 2, "should keep 2 real video rows");
  assert.ok(r.skipped.length >= 2, "should skip Total + empty rows");
  assert.ok(r.recognizedMetrics.includes("views"));
  assert.ok(r.recognizedMetrics.includes("avgPercentViewed"));
  assert.ok(r.recognizedMetrics.includes("ctrPercent"));
});

test("parseAnalyticsCsv parses numbers, percents, and m:ss durations", () => {
  const r = importer.parseAnalyticsCsv(SAMPLE_CSV);
  const row = r.rows.find((x) => x.videoId === "abc123");
  assert.strictEqual(row.title, "Insane clutch, 1v4!", "quoted comma preserved");
  assert.strictEqual(row.outcome.views, 8200);
  assert.strictEqual(row.outcome.avgPercentViewed, 71.4);
  assert.strictEqual(row.outcome.avgViewDurationSec, 31, "0:31 -> 31s");
  assert.strictEqual(row.outcome.ctrPercent, 5.2);
  assert.strictEqual(row.outcome.subscribersGained, 80);
});

test("parseNumber / parseDurationToSeconds handle edge cases honestly", () => {
  assert.strictEqual(importer.parseNumber("1,234"), 1234);
  assert.strictEqual(importer.parseNumber("12.3%"), 12.3);
  assert.strictEqual(importer.parseNumber("-"), null);
  assert.strictEqual(importer.parseNumber(""), null);
  assert.strictEqual(importer.parseDurationToSeconds("1:02:03"), 3723);
  assert.strictEqual(importer.parseDurationToSeconds("0:45"), 45);
  assert.strictEqual(importer.parseDurationToSeconds(""), null);
});

// ── Linking ──────────────────────────────────────────────────────────────-─
const ENTRIES = [
  { id: "entry-1", title: "Insane clutch, 1v4!" },
  { id: "entry-2", title: "A totally unrelated cooking video" },
];

test("proposeLinks: exact title -> auto, weak match -> unmatched", () => {
  const parsed = importer.parseAnalyticsCsv(SAMPLE_CSV);
  const props = engine.proposeLinks(parsed.rows, ENTRIES);
  const clutch = props.find((p) => p.videoRef === "abc123");
  assert.strictEqual(clutch.status, "auto");
  assert.strictEqual(clutch.method, "exact_title");
  assert.strictEqual(clutch.entryId, "entry-1");

  const fail = props.find((p) => p.videoRef === "def456");
  assert.strictEqual(fail.status, "unmatched", "no good match -> not linked");
  assert.strictEqual(fail.entryId, null);
});

test("proposeLinks: partial title overlap -> needs_confirmation (never auto)", () => {
  const rows = [{ videoId: "x1", title: "Insane clutch highlight", outcome: { views: 10 } }];
  const props = engine.proposeLinks(rows, ENTRIES);
  assert.strictEqual(props[0].status, "needs_confirmation");
  assert.strictEqual(props[0].entryId, null, "must not auto-write a fuzzy match");
  assert.ok(props[0].confidence > 0 && props[0].confidence < 0.92);
});

// ── Outcome store validation ────────────────────────────────────────────────
test("validateOutcomeRow rejects empty outcomes and bad links", () => {
  const base = {
    id: "o1", entryId: "entry-1", collectedAt: new Date().toISOString(),
    linkMethod: "manual", linkConfidence: 1, outcomeSource: "youtube_studio_csv",
    outcome: { views: 10 },
  };
  assert.ok(store.validateOutcomeRow(base).valid);
  assert.ok(!store.validateOutcomeRow({ ...base, outcome: {} }).valid, "empty outcome rejected");
  assert.ok(!store.validateOutcomeRow({ ...base, linkMethod: "guess" }).valid, "bad linkMethod rejected");
  assert.ok(!store.validateOutcomeRow({ ...base, features: { a: "x" } }).valid, "non-numeric feature rejected");
});

// ── Ingest ──────────────────────────────────────────────────────────────────
test("ingest writes confirmed links only, with features when available", () => {
  const parsed = importer.parseAnalyticsCsv(SAMPLE_CSV);
  const props = engine.proposeLinks(parsed.rows, ENTRIES);
  const res = engine.ingest({
    analyticsRows: parsed.rows,
    links: props,
    featuresByEntryId: { "entry-1": { cutsPerMin: 12, coverage: 0.4 } },
  });
  assert.strictEqual(res.written, 1, "only the auto-linked row is written");
  assert.strictEqual(res.usable, 1, "it has features -> usable");
  assert.ok(res.skipped.some((s) => s.reason === "no confirmed link"));
  // idempotent link saved
  assert.strictEqual(store.readLinks()["abc123"], "entry-1");
});

// ── Thresholds: readiness + correlations ─────────────────────────────────────
test("readiness/correlations honor insufficient_data thresholds", () => {
  // Fresh isolated dir for the threshold scenario.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "ci-calib2-"));
  process.env.LANTERN_CI_DATA_DIR = dir2;

  const addRows = (n) => {
    for (let i = 0; i < n; i++) {
      const k = store.usableRows().length + 1;
      store.appendOutcome({
        id: `o-${k}-${Math.random().toString(36).slice(2, 6)}`,
        entryId: `entry-${k}`, collectedAt: new Date().toISOString(),
        linkMethod: "manual", linkConfidence: 1, outcomeSource: "test",
        usableForCalibration: true,
        features: { cutsPerMin: k },          // perfectly correlated...
        outcome: { avgPercentViewed: 2 * k }, // ...with this metric (r = 1)
      });
    }
  };

  // 0 rows: both insufficient.
  assert.strictEqual(engine.readiness().status, "insufficient_data");
  assert.strictEqual(engine.correlations().status, "insufficient_data");

  // 29 rows: still below correlation floor (30).
  addRows(29);
  assert.strictEqual(engine.correlations().status, "insufficient_data");
  assert.strictEqual(engine.readiness().status, "insufficient_data");

  // 30 rows: correlations available but "directional, not calibrated".
  addRows(1);
  const c30 = engine.correlations();
  assert.strictEqual(c30.status, "ok");
  assert.strictEqual(c30.calibrated, false);
  assert.strictEqual(engine.readiness().status, "insufficient_data");

  // 100 rows: calibrated, and the perfect correlation is detected (r = 1).
  addRows(70);
  const c100 = engine.correlations();
  assert.strictEqual(c100.calibrated, true);
  assert.strictEqual(engine.readiness().status, "ok");
  const top = c100.correlations[0];
  assert.strictEqual(top.feature, "cutsPerMin");
  assert.strictEqual(top.metric, "avgPercentViewed");
  assert.strictEqual(top.r, 1, "perfect positive correlation recovered");
  assert.strictEqual(top.n, 100);

  // Calibrated recommendations unlock only now, and advise the right direction.
  const recs = engine.calibratedRecommendations();
  assert.strictEqual(recs.status, "ok");
  assert.strictEqual(recs.calibrated, true);
  assert.strictEqual(recs.basis, "first_party_outcomes");
  const rec = recs.recommendations.find((r) => r.feature === "cutsPerMin");
  assert.ok(rec, "should recommend on the correlated feature");
  assert.strictEqual(rec.direction, "increase", "higher cuts -> higher % viewed");
});

test("calibratedRecommendations is insufficient_data before calibration size", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-recs-"));
  process.env.LANTERN_CI_DATA_DIR = dir;
  const recs = engine.calibratedRecommendations();
  assert.strictEqual(recs.status, "insufficient_data");
  assert.strictEqual(recs.basis, "first_party_outcomes", "still labels its basis honestly");
});

test("ingest is idempotent: re-importing identical outcomes writes nothing new", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-dedup-"));
  process.env.LANTERN_CI_DATA_DIR = dir;
  const rows = [{ videoId: "v1", title: "clip one", outcome: { views: 100 } }];
  const links = [{ videoRef: "v1", method: "manual", status: "auto", entryId: "e1", confidence: 1 }];
  const a = engine.ingest({ analyticsRows: rows, links, featuresByEntryId: { e1: { cutsPerMin: 5 } } });
  assert.strictEqual(a.written, 1);
  const b = engine.ingest({ analyticsRows: rows, links, featuresByEntryId: { e1: { cutsPerMin: 5 } } });
  assert.strictEqual(b.written, 0, "identical re-import writes nothing");
  assert.strictEqual(b.duplicates, 1);
  // A genuinely-changed metric DOES append (a later snapshot).
  const rows2 = [{ videoId: "v1", title: "clip one", outcome: { views: 250 } }];
  const c = engine.ingest({ analyticsRows: rows2, links, featuresByEntryId: { e1: { cutsPerMin: 5 } } });
  assert.strictEqual(c.written, 1, "changed metrics append as a new snapshot");
});

test("importCsvText rejects a file with no recognizable analytics columns", () => {
  const calib = require("../src/creator-intelligence/calibration");
  const res = calib.importCsvText("foo,bar,baz\n1,2,3\n");
  assert.strictEqual(res.status, "error");
  assert.ok(/no recognizable analytics columns/.test(res.reason));
});

test("pearson computes a known value", () => {
  assert.strictEqual(engine.pearson([1, 2, 3], [2, 4, 6]), 1);
  assert.strictEqual(engine.pearson([1, 2, 3], [6, 4, 2]), -1);
  assert.strictEqual(engine.pearson([1, 1, 1], [1, 2, 3]), null, "constant column -> null");
});

console.log(`\n${passed} checks passed.`);
