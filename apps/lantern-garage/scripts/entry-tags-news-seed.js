#!/usr/bin/env node
'use strict';
/**
 * entry-tags-news-seed.js — seeds the news-intensity history the entry tags rank against (lib/entry-tags.js, 2026-11-02).
 *
 * The live news tag ranks today's overnight and session headline rates against the 120 sessions before it. Those
 * sessions come from the research's own archive: the Alpaca News API (Benzinga) headlines tagged SPY/QQQ/SMH/DIA/IWM, one
 * file per month (bz_YYYY-MM.json, rows { t: created_at, h: headline }), deduplicated on t|h as the research did. Every
 * session is counted by entry-tags.sessionRow(), the same function the live refresh uses, so the live terciles are the
 * backtest's (ledger tier0-news-intensity-sleeves-2016-2026).
 *
 * Usage: node scripts/entry-tags-news-seed.js --archive <dir of bz_YYYY-MM.json> --out <TRADER_ENTRY_TAGS_DIR>
 *          [--through YYYY-MM-DD] [--dry]
 *   --through  the last session to seed (default: the last session whose 15:50 ET falls inside the archive's last month).
 *   The history keeps the 200 sessions up to --through. An existing news.json keeps its live rows after --through and
 *   its `today`; nothing older than --through that the live refresh wrote is replaced unless the archive has that day.
 *   No network, no keys.
 */
const fs = require('fs');
const path = require('path');
const et = require('../lib/entry-tags');
const cal = require('../lib/market-calendar');

const KEEP = 200;
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const archive = arg('--archive'), out = arg('--out'), dry = process.argv.includes('--dry');
if (!archive || !out) { console.error('usage: entry-tags-news-seed.js --archive <dir> --out <dir> [--through YYYY-MM-DD] [--dry]'); process.exit(2); }

const files = fs.readdirSync(archive).filter((f) => /^bz_\d{4}-\d{2}\.json$/.test(f)).sort();
if (!files.length) { console.error(`no bz_YYYY-MM.json in ${archive}`); process.exit(2); }
const seen = new Set(); const ts = [];
for (const f of files) {
  for (const n of JSON.parse(fs.readFileSync(path.join(archive, f), 'utf8'))) {
    const k = `${n.t}|${n.h}`; if (seen.has(k)) continue; seen.add(k);
    const t = Date.parse(n.t); if (Number.isFinite(t)) ts.push(t);
  }
}
ts.sort((a, b) => a - b);
// The archive's end: the first instant after its last month file (the fetcher's own month bounds are UTC).
const [ly, lm] = files[files.length - 1].slice(3, 10).split('-').map(Number);
const archiveEnd = Date.UTC(lm === 12 ? ly + 1 : ly, lm === 12 ? 0 : lm, 1);
let through = arg('--through');
if (!through) {
  let d = new Date(archiveEnd).toISOString().slice(0, 10);
  for (let i = 0; i < 30; i++) { d = cal.prevTradingDay(d); if (et.windows(d).dec <= archiveEnd) break; }
  through = d;
}
if (et.windows(through).dec > archiveEnd) { console.error(`--through ${through}: its session ends after the archive (${new Date(archiveEnd).toISOString()})`); process.exit(2); }

const days = [];
for (let d = through; days.length < KEEP && d; d = cal.prevTradingDay(d)) days.unshift(d);
const firstNeeded = et.windows(days[0]).from;
if (!ts.length || ts[0] > firstNeeded) console.warn(`warning: the archive starts at ${ts.length ? new Date(ts[0]).toISOString() : '-'}, after ${days[0]}'s overnight window`);
const seeded = days.map((d) => et.sessionRow(ts, d));

const file = path.join(out, 'news.json');
let prev = null; try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) { prev = null; }
const live = prev && Array.isArray(prev.history) ? prev.history.filter((h) => h.d > through) : [];
const st = { v: 1, history: [...seeded, ...live].slice(-KEEP), today: (prev && prev.today) || null,
  seeded: { from: archive, files: files.length, headlines: ts.length, through, sessions: seeded.length, at: new Date().toISOString() } };

console.info(`headlines ${ts.length} (${files.length} month files) | seeded ${seeded.length} sessions ${days[0]} .. ${through} | live rows kept ${live.length}`);
for (const h of seeded.slice(-5)) console.info(`  ${h.d}  overnight ${h.nOn} (${h.on.toFixed(3)}/h)  session ${h.nSe} (${h.se.toFixed(3)}/h)`);
if (dry) { console.info('--dry: nothing written'); process.exit(0); }
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(file, JSON.stringify(st));
console.info(`wrote ${file}`);
