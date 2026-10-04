/**
 * entry_requote_score.js — score the entry re-quote shadow (2026-10-04, journal-only; TRADER_ENTRY_REQUOTE=shadow)
 *
 * The brain buys on the SCAN's quote, up to a tick old by the time the order goes out. The shadow fetches a fresh
 * print beside every market buy and journals `entry_requote` {decision_px, requote_px, drift_bps, cap_bps, limit_px,
 * would_refuse, decision_age_ms}; when the broker's basis arrives the `entry_fill` row carries fill_vs_requote_bps and
 * limit_would_fill. Joined to each entry's exit, this answers, before any order path changes:
 *   1. THE GUARD: how often would "refuse an entry whose price ran more than the cap since the decision" have fired,
 *      and how did THOSE trades do vs the rest (the guard is only worth it if the refused ones were the bad ones)?
 *   2. THE MARKETABLE LIMIT: how often does the fill sit above quote + cap (the limit would NOT have filled at once),
 *      what did those entries overpay, and how did the trades a limit would have missed do?
 *   3. The staleness itself: mean age of the decision quote and the drift it carried.
 *
 * Usage: node experiments/entry_requote_score.js [journal.jsonl ...] [--since 2026-10-05]
 * Default journals: the stable box's autopilot-trades.jsonl and the engine's S/M/C journals.
 */
"use strict";
const fs = require("fs");

const args = process.argv.slice(2);
const files = args.filter((a) => a.endsWith(".jsonl"));
const since = args.includes("--since") ? args[args.indexOf("--since") + 1] : "2026-10-05";
const DEFAULT = ["C:/dev/lantern-os-stable/data/lantern-garage/trading/autopilot-trades.jsonl",
  "C:/dev/two-sleeve-armed/S.autopilot-trades.jsonl", "C:/dev/two-sleeve-armed/M.autopilot-trades.jsonl", "C:/dev/two-sleeve-armed/C.autopilot-trades.jsonl"];
const srcs = (files.length ? files : DEFAULT).filter((f) => fs.existsSync(f));
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "-");
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const fmt = (x, d = 1) => (x == null ? "-" : x.toFixed(d));

const episodes = [];
for (const file of srcs) {
  const rows = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter((r) => r && r.ts && r.ts.slice(0, 10) >= since && r.symbol);
  const bySym = {};
  for (const r of rows) (bySym[r.symbol] = bySym[r.symbol] || []).push(r);
  for (const [sym, list] of Object.entries(bySym)) {
    let cur = null;
    for (const r of list) {
      if (r.event === "entry") { cur = { file, sym, entry: r, requote: null, fill: null, exit: null }; episodes.push(cur); }
      else if (!cur) continue;
      else if (r.event === "entry_requote") cur.requote = r;
      else if (r.event === "entry_fill") cur.fill = r;
      else if (r.event === "exit" && !cur.exit) { cur.exit = r; cur = null; }
    }
  }
}
const shadowed = episodes.filter((e) => e.requote);
console.log(`entries since ${since}: ${episodes.length}, shadowed ${shadowed.length}, of which with a fill row ${shadowed.filter((e) => e.fill).length} and an exit ${shadowed.filter((e) => e.exit).length}`);
if (!shadowed.length) process.exit(0);
const drift = shadowed.map((e) => Number(e.requote.drift_bps)).filter(Number.isFinite);
const age = shadowed.map((e) => Number(e.requote.decision_age_ms)).filter(Number.isFinite);
console.log(`\nSTALENESS: decision quote age mean ${fmt(mean(age) / 1000)} s; drift decision -> fresh quote mean ${fmt(mean(drift))} bp, share > cap ${pct(shadowed.filter((e) => e.requote.would_refuse).length, shadowed.length)}`);
const ret = (e) => (e.exit && Number.isFinite(Number(e.exit.pnl_pct)) ? Number(e.exit.pnl_pct) * 100 : null);
const group = (label, list) => { const rs = list.map(ret).filter((x) => x != null); console.log(`  ${label.padEnd(34)} n=${String(list.length).padStart(3)}  closed ${String(rs.length).padStart(3)}  mean return ${fmt(mean(rs), 3)}%  WR ${pct(rs.filter((x) => x > 0).length, rs.length)}`); };
console.log(`\n1. THE GUARD (refuse when the price ran more than the cap since the decision):`);
group("would have been refused", shadowed.filter((e) => e.requote.would_refuse));
group("would have been taken", shadowed.filter((e) => !e.requote.would_refuse));
const withFill = shadowed.filter((e) => e.fill && Number.isFinite(Number(e.fill.fill_vs_requote_bps)));
console.log(`\n2. THE MARKETABLE LIMIT (quote + cap):`);
if (withFill.length) {
  const missed = withFill.filter((e) => e.fill.limit_would_fill === false), filled = withFill.filter((e) => e.fill.limit_would_fill !== false);
  console.log(`  fills against the fresh quote: mean ${fmt(mean(withFill.map((e) => Number(e.fill.fill_vs_requote_bps))))} bp; above the cap (limit misses at once) ${pct(missed.length, withFill.length)}; overpay on those ${fmt(mean(missed.map((e) => Number(e.fill.fill_vs_requote_bps) - Number(e.fill.cap_bps))))} bp beyond the cap`);
  group("limit would have filled", filled);
  group("limit would have MISSED", missed);
} else console.log("  no entry_fill rows with the re-quote join yet");
console.log(`\nPER FAMILY (drift bp / fill vs fresh bp / n):`);
const fam = (s) => (["SOXL", "TNA", "SPXL", "TQQQ", "UPRO"].includes(s) ? "3x long" : ["SQQQ", "SOXS", "SPXS", "TZA"].includes(s) ? "3x inverse" : ["NUGT", "JNUG", "UCO"].includes(s) ? "3x commodity" : ["SPY", "QQQ", "IWM", "DIA", "SMH", "XLK"].includes(s) ? "index ETF" : "commodity/bond");
const byFam = {};
for (const e of shadowed) (byFam[fam(e.sym)] = byFam[fam(e.sym)] || []).push(e);
for (const [k, list] of Object.entries(byFam)) console.log(`  ${k.padEnd(14)} drift ${fmt(mean(list.map((e) => Number(e.requote.drift_bps)).filter(Number.isFinite)))}  fill-vs-fresh ${fmt(mean(list.filter((e) => e.fill).map((e) => Number(e.fill.fill_vs_requote_bps)).filter(Number.isFinite)))}  n=${list.length}`);
