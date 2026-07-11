#!/usr/bin/env node
'use strict';
/**
 * verify-sharpe-certificate.js — MACHINE CHECK for docs/UNISONA-SHARPE-CERTIFICATE.md
 *
 * Reads the committed evidence record (data/trading/leaderboard/leaderboard-*.json)
 * and asserts every LOAD-BEARING claim the certificate makes. Deterministic and
 * OFFLINE (no network) so it can't false-fail on a Yahoo hiccup — it checks the
 * artifact the harness already produced. Exit 0 = certificate matches evidence;
 * exit 1 = the document has DRIFTED from the data and must not be trusted until
 * reconciled (same discipline as SIGMA0-COLLAPSE-CERTIFICATE.md).
 *
 * To refresh the underlying evidence:  node scripts/daily-backtest-harness.js
 * To machine-check the certificate:     node scripts/verify-sharpe-certificate.js
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const dir = path.join(REPO, 'data', 'trading', 'leaderboard');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^leaderboard-.*\.json$/.test(f)).sort() : [];
if (!files.length) { console.error('FAIL: no leaderboard evidence record found — run: node scripts/daily-backtest-harness.js'); process.exit(1); }
const rec = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));

const byName = (frag) => rec.strategies.find((s) => s.name.includes(frag));
const li = (frag) => rec.correlation.labels.findIndex((l) => l.includes(frag));
const rho = (a, b) => rec.correlation.matrix[li(a)][li(b)];

let pass = 0, fail = 0;
function check(label, cond, detail) {
  const ok = !!cond;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
}

const SPY = byName('SPY buy & hold');
const C3 = byName('COMBO3');
const C4 = byName('COMBO4');
const GOLD = byName('Gold (GLD)');
const MFT = byName('Multi-market trend');
const MR = byName('Mean-reversion');
const SV = byName('Short-vol');
const LSsec = byName('L/S sector');
const LSstk = byName('L/S single-stock');

console.log(`\nMachine-checking UNISONA-SHARPE-CERTIFICATE against ${files[files.length - 1]}`);
console.log(`window ${rec.window.start} → ${rec.window.end}, benchmark ${rec.benchmark}\n`);

// ── Reason/Verify: Theorem 1 (diversification) fires on our real strategies (E2) ──
check('E2  COMBO3 Sharpe > SPY Sharpe (diversification lift)', C3.sharpe > SPY.sharpe, `${C3.sharpe.toFixed(2)} > ${SPY.sharpe.toFixed(2)}`);
check('E2  COMBO3 max drawdown shallower than SPY', C3.max_dd > SPY.max_dd, `${(C3.max_dd * 100).toFixed(1)}% vs ${(SPY.max_dd * 100).toFixed(1)}%`);
check('E1  COMBO3 Sharpe CI excludes 0 (significant)', C3.sharpe_ci95.lo > 0, `CI lo ${C3.sharpe_ci95.lo.toFixed(2)}`);

// ── the genuine diversifiers are genuinely low-correlation to equity ──
check('Diversifier: Gold ρ↔SPY < 0.20', rho('Gold', 'SPY buy & hold') < 0.20, `ρ=${rho('Gold', 'SPY buy & hold').toFixed(2)}`);
check('Diversifier: Multi-market trend ρ↔SPY < 0.40', rho('Multi-market trend', 'SPY buy & hold') < 0.40, `ρ=${rho('Multi-market trend', 'SPY buy & hold').toFixed(2)}`);

// ── rejected-on-(a): correlated-in-disguise (fail the ρ<0.4 gate) ──
check('Reject(a): Mean-reversion ρ↔SPY ≥ 0.40 (long-equity in disguise)', rho('Mean-reversion', 'SPY buy & hold') >= 0.40, `ρ=${rho('Mean-reversion', 'SPY buy & hold').toFixed(2)}`);
check('Reject(a): Short-vol ρ↔SPY ≥ 0.40 (long-equity in disguise)', rho('Short-vol', 'SPY buy & hold') >= 0.40, `ρ=${rho('Short-vol', 'SPY buy & hold').toFixed(2)}`);

// ── rejected-on-(b): genuinely uncorrelated but no significant edge ──
check('Reject(b): L/S sector uncorrelated (ρ<0.4) AND edge CI spans 0', Math.abs(rho('L/S sector', 'SPY buy & hold')) < 0.40 && LSsec.sharpe_ci95.lo < 0, `ρ=${rho('L/S sector', 'SPY buy & hold').toFixed(2)}, CIlo ${LSsec.sharpe_ci95.lo.toFixed(2)}`);
check('Reject(b): L/S single-stock uncorrelated (ρ<0.4) AND edge CI spans 0', Math.abs(rho('L/S single-stock', 'SPY buy & hold')) < 0.40 && LSstk.sharpe_ci95.lo < 0, `ρ=${rho('L/S single-stock', 'SPY buy & hold').toFixed(2)}, CIlo ${LSstk.sharpe_ci95.lo.toFixed(2)}`);

// ── Converge: adding a gate-failing sleeve does NOT raise the blend Sharpe ──
check('Gate works: COMBO4 (+failed sleeve) Sharpe ≤ COMBO3', C4.sharpe <= C3.sharpe, `${C4.sharpe.toFixed(2)} ≤ ${C3.sharpe.toFixed(2)}`);

// ── every sleeve carries a Sharpe CI (Act: sizing needs it) ──
check('All strategies carry a 95% Sharpe CI', rec.strategies.every((s) => s.sharpe_ci95 && Number.isFinite(s.sharpe_ci95.lo)), `${rec.strategies.length} strategies`);

console.log(`\n${fail === 0 ? '✅ CERTIFIED' : '❌ DRIFT'} — ${pass} passed, ${fail} failed.`);
if (fail) { console.log('The certificate no longer matches the evidence record. Reconcile before trusting it.'); process.exit(1); }
console.log('Every load-bearing claim in UNISONA-SHARPE-CERTIFICATE.md matches the committed evidence.\n');
process.exit(0);
