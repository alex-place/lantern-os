#!/usr/bin/env node
/**
 * verify-exits.mjs — did the stalled exits actually FILL?
 *
 * Reads the autopilot ledger + the broker's own order/position truth and reports,
 * per exit decision: decided → order status → is the position actually gone.
 * Written after 2026-07-27, when 13 exit decisions produced 0 executions
 * (needs_confirmation on every IBKR order). Run any time after 09:35 ET.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
for (const f of ['.env', '.env.local']) {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      // LAST wins, and an EMPTY value never shadows a real one — the server loads these
      // two files in the same order. (First-wins let `.env`'s empty
      // LANTERN_TEST_AUTH_TOKEN= mask the real token in .env.local, so every API call
      // silently 302'd to /auth.html and this script drew conclusions from no data.)
      if (m && m[2].trim() !== '') process.env[m[1]] = m[2].trim();
    }
  } catch { /* optional */ }
}

const LEDGER = path.join(ROOT, 'data', 'lantern-garage', 'trading', 'autopilot-trades.jsonl');
const rows = fs.existsSync(LEDGER)
  ? fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];

const day = process.argv[2] || new Date().toISOString().slice(0, 10);
const exits = rows.filter((r) => r.event === 'exit' && String(r.ts || '').slice(0, 10) >= day);

const base = 'http://127.0.0.1:4178';
async function api(p) {
  // Authed like the repo's other API checks: X-Test-Auth + role (docs/TEST-AUTH.md).
  // Without it the server 302s to /auth.html and the body is HTML, not JSON.
  const headers = { 'x-keystone-user': 'local-owner', 'x-test-role': 'admin' };
  if (process.env.LANTERN_TEST_AUTH_TOKEN) headers['x-test-auth'] = process.env.LANTERN_TEST_AUTH_TOKEN;
  const r = await fetch(base + p, { headers, redirect: 'manual' });
  if (!r.ok) return null;
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) return null;   // an auth redirect / HTML page, not data
  return r.json();
}
// NO DATA MUST NEVER READ AS SUCCESS. The first cut of this script reported every exit
// "CLOSED" and printed a clean bill of health purely because the positions call had
// 302'd — the exact false-success shape this whole review is about. Refuse to draw any
// conclusion without broker truth.
const pos = await api('/api/trading/positions');
if (!pos || !Array.isArray(pos.positions)) {
  console.error('ABORT: could not read positions from the broker — nothing can be verified.');
  console.error('       (server down, or auth failed — check LANTERN_TEST_AUTH_TOKEN)');
  process.exit(2);
}
const held = new Map(pos.positions.map((p) => [String(p.symbol).toUpperCase(), p]));
const orders = (await api('/api/trading/orders?limit=200')) || [];
const byStatus = {};
for (const o of Array.isArray(orders) ? orders : []) byStatus[o.status] = (byStatus[o.status] || 0) + 1;

console.log(`EXIT VERIFICATION — decisions since ${day}\n`);
if (!exits.length) console.log('  (no exit decisions logged)');
let stillOpen = 0, gone = 0;
for (const e of exits) {
  const sym = String(e.symbol).toUpperCase();
  const p = held.get(sym);
  const state = p ? `STILL OPEN (${(Number(p.unrealized_plpc || 0) * 100).toFixed(1)}%)` : 'CLOSED';
  if (p) stillOpen++; else gone++;
  console.log(`  ${sym.padEnd(6)} decided ${String(e.reason).padEnd(16)} order=${String(e.status).padEnd(20)} → ${state}`);
}
console.log(`\n  closed: ${gone}   still open: ${stillOpen}`);
console.log(`  broker order statuses: ${JSON.stringify(byStatus)}`);
const stalled = exits.filter((e) => e.status === 'needs_confirmation' && held.has(String(e.symbol).toUpperCase()));
if (stalled.length) {
  console.log(`\n  ⚠ ${stalled.length} exit(s) STILL stalled on confirmation — the fix did NOT take effect:`);
  for (const s of stalled) console.log(`      ${s.symbol} (${s.reason})`);
  process.exitCode = 1;
} else if (exits.length) {
  console.log('\n  ✓ no exit is stalled on confirmation');
}
