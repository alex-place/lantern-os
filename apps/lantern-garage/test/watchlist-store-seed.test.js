"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

// watchlist-store resolves paths from its own __dirname up to data/.../trading, so we
// can't repoint its ROOT per-test. Instead we exercise the seed PRECEDENCE against the
// tracked repo seed file, which is the exact regression from #2376: a fresh user (no
// per-user file, no legacy global file) must seed from watchlist.seed.json — NOT collapse
// to the 5-symbol hardcoded DEFAULT. (#trader-seed)
const ROOT = path.join(__dirname, "..", "..", "..", "data", "lantern-garage", "trading");
const SEED_FILE = path.join(ROOT, "watchlist.seed.json");
const LEGACY = path.join(ROOT, "watchlist.json");
const DIR = path.join(ROOT, "watchlists");

test("the tracked ideal-trader seed file exists and is broad (index + equities + crypto)", () => {
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, "utf8")).tickers;
  assert.ok(Array.isArray(seed) && seed.length >= 10,
    `seed should be the broad ideal-trader list, got ${seed && seed.length} symbols`);
  for (const sym of ["SPY", "AAPL", "NVDA", "GLD", "BTCUSD"]) {
    assert.ok(seed.includes(sym), `seed should include ${sym}`);
  }
});

test("a fresh user seeds from the seed file, not the 5-symbol hardcoded fallback", (t) => {
  // Only run when the box is genuinely 'fresh' (no legacy global list, no per-user files) —
  // otherwise a real operator's persisted list would be a false failure. Guard, don't mutate.
  if (fs.existsSync(LEGACY)) { t.skip("legacy global watchlist.json present — migration path, not seed path"); return; }
  if (fs.existsSync(DIR) && fs.readdirSync(DIR).some((f) => f.endsWith(".json"))) {
    t.skip("per-user watchlists already exist — persisted, not re-seeded"); return;
  }
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, "utf8")).tickers;
  // Use a throwaway user id and clean it up so we never leave state behind.
  const uid = "seed-test-" + process.pid;
  const store = require("../lib/watchlist-store");
  const target = path.join(DIR, encodeURIComponent(uid) + ".json");
  try {
    const list = store.getWatchlist(uid);
    assert.ok(list.length >= 10, `fresh seed should be the broad list, got ${list.length}`);
    assert.deepEqual([...list].sort(), [...seed.map((s) => s.toUpperCase())].sort());
    assert.ok(store.allTickers().includes("GLD"), "the union should include the full seed for collectors");
  } finally {
    try { fs.rmSync(target, { force: true }); } catch (_e) { /* best effort */ }
  }
});
