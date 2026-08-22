/**
 * limit_shadow_score.js — score the live limit shadow (#3424)
 *
 * Joins each real entry → its exit with the limit_shadow rows the engine
 * journaled for it, and answers, per depth, the two questions the backtest
 * could not settle forward:
 *   1. FILLED: when the limit would have filled, what would the SAME exit have
 *      returned from the limit price vs from the actual entry?
 *   2. UNFILLED: how did the signals whose limit never filled actually do?
 *      (The lab says these are the weak ones — the "fallback trap".)
 *
 * Usage: node experiments/limit_shadow_score.js [ledger.jsonl] [--since 2026-08-24]
 * Default ledger: the stable box's autopilot-trades.jsonl.
 */
"use strict";
const fs = require("fs");

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith(".jsonl")) || "C:/dev/lantern-os-stable/data/lantern-garage/trading/autopilot-trades.jsonl";
const since = args.includes("--since") ? args[args.indexOf("--since") + 1] : "2026-08-24";
const rows = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
  .filter((r) => r && r.ts && r.ts.slice(0, 10) >= since);

// sequence per symbol: entry -> shadow fills -> shadow close -> exit
const bySym = {};
for (const r of rows) (bySym[r.symbol] = bySym[r.symbol] || []).push(r);
const episodes = [];
for (const [sym, list] of Object.entries(bySym)) {
  let cur = null;
  for (const r of list) {
    if (r.event === "entry") { cur = { sym, entry: Number(r.entry || r.price), entryTs: r.ts, fills: {}, exit: null }; }
    else if (!cur) continue;
    else if (r.event === "limit_shadow_fill") cur.fills[String(r.depth)] = r.fill_px;
    else if (r.event === "limit_shadow_close") { for (const [k, v] of Object.entries(r.fills || {})) if (v != null) cur.fills[k] = v; }
    else if (r.event === "exit" && typeof r.exit === "number") { cur.exit = Number(r.exit); cur.reason = String(r.reason || "").split(" ")[0]; episodes.push(cur); cur = null; }
  }
}
console.log(`${episodes.length} completed entry→exit episodes since ${since} in ${file.split(/[\\/]/).pop()}`);
if (!episodes.length) process.exit(0);
const depths = ["0.0025", "0.005", "0.0075", "0.01"];
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (x) => (x * 100).toFixed(2) + "%";
const actual = episodes.map((e) => e.exit / e.entry - 1);
console.log(`actual (touch entries): n=${episodes.length} WR ${(episodes.filter((e) => e.exit > e.entry).length / episodes.length * 100).toFixed(0)}% avg ${pct(avg(actual))}\n`);
console.log("depth   filled   filled: actual avg → at-limit avg    unfilled: n / WR / avg   (unfilled = the fallback-trap check)");
for (const d of depths) {
  const f = episodes.filter((e) => e.fills[d] != null), u = episodes.filter((e) => e.fills[d] == null);
  const aF = avg(f.map((e) => e.exit / e.entry - 1)), lF = avg(f.map((e) => e.exit / e.fills[d] - 1));
  const aU = avg(u.map((e) => e.exit / e.entry - 1)), wrU = u.length ? u.filter((e) => e.exit > e.entry).length / u.length : 0;
  console.log(`  ${(Number(d) * 100).toFixed(2)}%   ${String(f.length).padStart(3)}/${episodes.length}   ${pct(aF).padStart(7)} → ${pct(lF).padStart(7)}        ${String(u.length).padStart(3)} / ${(wrU * 100).toFixed(0).padStart(3)}% / ${pct(aU).padStart(7)}`);
}
console.log("\nRead: at-limit avg > actual avg on the filled set = the price improvement is real; an unfilled set");
console.log("with a low WR = the lab's finding that signals which never extend are the weak ones (skip, do not fall back).");
