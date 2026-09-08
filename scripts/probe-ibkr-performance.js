#!/usr/bin/env node
'use strict';
/**
 * probe-ibkr-performance.js — capture ONE real /pa/performance response and show what
 * lib/ibkr-cpapi.js makes of it.
 *
 * Why this exists: IBKR does not publish this endpoint's response schema (their Web API
 * reference lists it in the pacing table and says not all endpoints are documented yet),
 * and it is rate limited to 1 request per 15 minutes. So the parser in ibkr-cpapi.js
 * DISCOVERS the NAV series rather than asserting a field path, and it has never met a
 * real response -- when this was written the gateway was unauthenticated.
 *
 * Run this once a session is up. It prints the raw shape, saves the full body, and says
 * whether the parser found the series. If it did not, the saved JSON is exactly what the
 * parser needs to be taught, and belongs in test/ibkr-portfolio-history.test.js as one
 * more case.
 *
 *   node scripts/probe-ibkr-performance.js [outfile.json]
 *
 * READ-ONLY: /pa/performance reports performance. It places nothing.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IbkrCpapi = require(path.join(ROOT, 'apps/lantern-garage/lib/ibkr-cpapi.js'));
const OUT = process.argv[2] || path.join(ROOT, 'ibkr-performance-sample.json');

(async () => {
  const c = new IbkrCpapi();

  const st = await c.getStatus().catch((e) => ({ error: e.message }));
  console.log('gateway   :', st && st.gatewayUrl);
  console.log('reachable :', !!(st && st.reachable), ' authenticated:', !!(st && st.authenticated));
  if (!st || !st.authenticated) {
    console.log('\nNot authenticated — stopping WITHOUT spending the 15-minute rate limit.');
    console.log('Bring the gateway up / re-auth the session, then run this again.');
    process.exit(2);
  }

  const acct = await c.resolveAccountId().catch(() => null);
  console.log('account   :', acct);
  if (!acct) { console.log('No account id — stopping.'); process.exit(2); }

  console.log('\nPOST /pa/performance  { acctIds: ["' + acct + '"], freq: "D" }   (1 req / 15 min)');
  const r = await c._request('POST', '/pa/performance', { acctIds: [acct], freq: 'D' });
  console.log('-> ok=' + r.ok + ' status=' + r.status + (r.error ? ' error=' + r.error : ''));

  fs.writeFileSync(OUT, JSON.stringify({ status: st, accountId: acct, response: r.json }, null, 2));
  console.log('raw body saved ->', OUT);

  if (r.json && typeof r.json === 'object') {
    console.log('top-level keys:', Object.keys(r.json).join(', '));
  }

  // What does the shipped parser make of it?
  const parsed = await c.getPortfolioHistory(acct).catch((e) => ({ ok: false, reason: e.message }));
  if (parsed && parsed.ok) {
    const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
    console.log('\nPARSER FOUND THE SERIES:');
    console.log('  points     :', parsed.timestamps.length);
    console.log('  first / last:', iso(parsed.timestamps[0]), '->', iso(parsed.timestamps[parsed.timestamps.length - 1]));
    console.log('  base_value :', parsed.base_value, parsed.base_is_window_start ? '(window start, NOT the account opening balance)' : '');
    console.log('\nThe journal will draw this. Add the saved body to');
    console.log('test/ibkr-portfolio-history.test.js so the shape stays pinned.');
  } else {
    console.log('\nPARSER DID NOT FIND A SERIES:', parsed && parsed.reason);
    console.log('The saved body is what it needs to be taught. Add it as a case in');
    console.log('test/ibkr-portfolio-history.test.js, then widen _findNavSeries to match.');
  }
})();
