'use strict';
/**
 * session_review_replay.js — run the post-close reviewer over past sessions.
 *
 * The bar this feature has to clear is not "does it say something plausible" —
 * it is "does it independently surface defects we already found by hand". Run it
 * over a stretch of history and check its findings against what you know:
 *
 *   node experiments/session_review_replay.js                # dry run: digests only, no calls
 *   TRADER_SESSION_REVIEW=1 node experiments/session_review_replay.js
 *   DAYS=2026-08-17,2026-08-18 TRADER_SESSION_REVIEW=1 node experiments/session_review_replay.js
 *
 * Each call is one capable-model request (~$0.06). DAYS defaults to every session
 * in the ledger, so pass it explicitly when you only want a couple.
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.env.LANTERN_ROOT || path.join(__dirname, '..');
const LEDGER = process.env.TRADER_TRADES_LOG
  || path.join(ROOT, 'data', 'lantern-garage', 'trading', 'autopilot-trades.jsonl');
const sr = require(path.join(ROOT, 'apps', 'lantern-garage', 'lib', 'session-review'));

(async () => {
  let ledgerText;
  try { ledgerText = fs.readFileSync(LEDGER, 'utf8'); }
  catch (e) { console.log(`cannot read ledger at ${LEDGER}: ${e.message}`); return; }

  const sessions = ledgerText.split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter((x) => x && x.event === 'session' && x.date);
  const days = process.env.DAYS ? process.env.DAYS.split(',').map((s) => s.trim()) : sessions.map((s) => s.date);

  console.log(`sessions in ledger: ${sessions.length} (${sessions.map((s) => s.date).join(', ')})`);
  console.log(`reviewing: ${days.join(', ')}\n`);

  if (!sr.enabled()) {
    console.log('DRY RUN (TRADER_SESSION_REVIEW is not 1) — no calls made.');
    for (const day of days) {
      const d = sr.buildDigest(ledgerText, day);
      const size = JSON.stringify(d).length;
      console.log(`  ${day}  entries ${d.entries.length}  exits ${d.exits.length}  `
        + `skip-kinds ${Object.keys(d.skip_distribution_today).length}  `
        + `new-reasons ${d.skip_reasons_new_today.length}  baseline ${d.prior_sessions.length}  `
        + `digest ~${Math.round(size / 3.7)} tok`);
    }
    console.log('\nRe-run with TRADER_SESSION_REVIEW=1 to score them for real.');
    return;
  }

  let calls = 0, findings = 0, tokIn = 0, tokOut = 0;
  for (const day of days) {
    const r = await sr.review({ ledgerText, day });
    calls++;
    if (r.usage) { tokIn += r.usage.in || 0; tokOut += r.usage.out || 0; }
    console.log(`── ${day} ${'─'.repeat(56)}`);
    if (r.degraded) { console.log(`   (no review: ${r.reason})\n`); continue; }
    console.log(`   ${r.summary || ''}`);
    if (!r.findings.length) { console.log('   no findings — an unremarkable session\n'); continue; }
    for (const f of r.findings) {
      findings++;
      console.log(`   [${String(f.severity).toUpperCase()}] ${f.category}`);
      console.log(`      ${f.claim}`);
      console.log(`      evidence: ${f.evidence}`);
      if (f.check) console.log(`      check:    ${f.check}`);
    }
    console.log('');
  }

  // Opus 5 list price; adjust if TRADER_REVIEW_MODEL points elsewhere.
  const cost = (tokIn * 5 + tokOut * 25) / 1e6;
  console.log(`${calls} review(s), ${findings} finding(s), ${tokIn} in / ${tokOut} out tokens, ~$${cost.toFixed(3)}`);
  console.log(`journal: ${sr.logFile()}`);
})();
