// Grounded position-taker (lib/kalshi-event-suggester.js + lib/kalshi-council.js):
// the External-Reality rule in code — only a LIVE web-grounded estimate may assert an
// edge over the market; a knowledge-only guess defers to the market price; and a
// resolved pick is Brier-graded into the council. Pure logic, no network.
//
// Run: node test/kalshi-grounded.test.js
const assert = require("assert");
const { toCard, isGroundableEventMarket } = require("../lib/kalshi-event-suggester");
const { gradeGrounded } = require("../lib/kalshi-council");
const fees = require("../lib/kalshi-fees");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

const NOW = Date.parse("2026-06-30T12:00:00Z");
const mkt = (over = {}) => ({
  ticker: "KXHIGHCHI-26JUL01-T95", title: "Will the high temp in Chicago be <95?",
  yes_ask: 30, no_ask: 70, close_time: "2026-07-01T18:00:00Z",
  rules_primary: "If the NWS high at Chicago Midway is < 95, YES.", ...over,
});

// ── isGroundableEventMarket ─────────────────────────────────────────────────────
check("groundable: near-term, ruled, tradeable band passes", () => {
  assert.strictEqual(isGroundableEventMarket(mkt(), NOW), true);
});
check("groundable: rejects empty rules", () => {
  assert.strictEqual(isGroundableEventMarket(mkt({ rules_primary: "" }), NOW), false);
});
check("groundable: rejects already-resolved price (yes_ask 3c)", () => {
  assert.strictEqual(isGroundableEventMarket(mkt({ yes_ask: 3 }), NOW), false);
});
check("groundable: rejects multivariate parlay (KXMV*)", () => {
  assert.strictEqual(isGroundableEventMarket(mkt({ ticker: "KXMVE-X" }), NOW), false);
});
check("groundable: rejects far-out (>14d)", () => {
  assert.strictEqual(isGroundableEventMarket(mkt({ close_time: "2026-08-30T00:00:00Z" }), NOW), false);
});

// ── toCard: WEB-GROUNDED asserts an edge via the fee-aware EV gate ───────────────
check("web-grounded low p_yes vs high market → BUY NO with correct EV", () => {
  const g = { p_yes: 0.05, confidence: 0.9, web_grounded: true, rationale: "NWS forecasts 97F", sources: ["http://x"], evidence: [], model: "vertex+search" };
  const c = toCard(mkt(), g, NOW);
  assert.strictEqual(c.grounding_status, "done");
  assert.strictEqual(c.favSide, "no");                     // p_yes 0.05 → NO is +EV
  assert.strictEqual(c.favAsk, 70);                        // no_ask
  const expectEv = fees.netEvCents(70, 0.95);              // p_win for NO = 1 - p_yes
  assert.strictEqual(c.sigma0.ev_cents, expectEv);
  assert.ok(expectEv > 0 && c.sigma0.verdict === "STRONG");
});

check("web-grounded picks the higher-EV side (YES when p_yes high)", () => {
  const g = { p_yes: 0.85, confidence: 0.9, web_grounded: true, rationale: "r", sources: ["u"], evidence: [] };
  const c = toCard(mkt({ yes_ask: 17, no_ask: 83 }), g, NOW);
  assert.strictEqual(c.favSide, "yes");
  assert.strictEqual(c.sigma0.ev_cents, fees.netEvCents(17, 0.85));
});

// ── toCard: KNOWLEDGE-ONLY defers to the market — no edge claimed ────────────────
check("knowledge-only estimate does NOT assert an edge", () => {
  const g = { p_yes: 0.87, confidence: 0.4, web_grounded: false, rationale: "climatology", sources: [], evidence: [] };
  const c = toCard(mkt(), g, NOW);
  assert.strictEqual(c.grounding_status, "knowledge-only");
  assert.strictEqual(c.sigma0.verdict, "UNVERIFIED");
  assert.strictEqual(c.sigma0.ev_cents, null);             // no edge number
  assert.ok(/No live sources/i.test(c.reason));
});

// ── toCard: no grounding yet → pending ──────────────────────────────────────────
check("no grounding → pending placeholder", () => {
  const c = toCard(mkt(), null, NOW);
  assert.strictEqual(c.grounding_status, "pending");
});

// ── gradeGrounded: Brier + after-fee net + source tag ───────────────────────────
check("gradeGrounded: confident NO that wins → +net, low Brier, tagged kalshi-grounded", () => {
  const r = gradeGrounded({ ticker: "T", side: "no", entryCents: 70, confidence: 0.95, won: true, recordId: "x" });
  assert.strictEqual(r.won, true);
  assert.strictEqual(r.net_cents, (100 - 70) - fees.takerFeeCents(70)); // +28
  assert.strictEqual(r.row.source, "kalshi-grounded");
  assert.ok(r.row.brier_score < 0.01);                     // (0.95-1)^2 = 0.0025
  assert.deepStrictEqual(r.row.signals, { grounded: 0.95 });
});
check("gradeGrounded: confident pick that LOSES → negative net, high Brier", () => {
  const r = gradeGrounded({ ticker: "T2", side: "no", entryCents: 70, confidence: 0.95, won: false, recordId: "y" });
  assert.ok(r.net_cents < 0);
  assert.ok(r.row.brier_score > 0.9);                      // (0.95-0)^2 = 0.9025
});

// Clean up the council rows this test appended (recordIds x, y) so it leaves no trace.
try {
  const fs = require("fs");
  const { OUTCOMES_PATH } = require("../lib/kalshi-council");
  if (fs.existsSync(OUTCOMES_PATH)) {
    const kept = fs.readFileSync(OUTCOMES_PATH, "utf8").split("\n").filter(Boolean)
      .filter((l) => { try { const r = JSON.parse(l); return r.record_id !== "x" && r.record_id !== "y"; } catch { return true; } });
    fs.writeFileSync(OUTCOMES_PATH, kept.length ? kept.join("\n") + "\n" : "");
  }
} catch { /* best-effort */ }

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
