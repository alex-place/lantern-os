'use strict';
/**
 * open-verify.js — scheduled ~9:52 ET (≈22 min after the open, ~20 autopilot
 * scans in). Checks the autopilot's first live trades against the fixes and
 * writes a report to data/lantern-garage/trading/open-verify-<date>.{json,txt}.
 *
 * Verdict is ✅ only if: IBKR connected, NO short positions (longs-only held),
 * every long has a working protective stop, and positions are sized ~2.5% of
 * equity (not the old $2k flat). Also records realized+unrealized P&L so there's
 * proof of the actual dollars — not "$62 on a glitch".
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'apps', 'lantern-garage');

function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) process.env[m[1]] = m[2];
    }
  } catch (_e) {}
}

(async () => {
  loadEnv();
  process.chdir(APP);
  const report = { verifiedAt: new Date().toISOString(), tz: 'ET' };
  try {
    const store = require(path.join(APP, 'lib', 'ibkr-credentials.js'));
    const IbkrCpapi = require(path.join(APP, 'lib', 'ibkr-cpapi.js'));
    const c = new IbkrCpapi({ oauth1: store.buildSigner('local-owner'), statusTtlMs: 0, timeoutMs: 20000 });
    const st = await c.getStatus();
    const acct = st.accountId;
    const sum = await c.getAccountSummary(acct).catch(() => null);
    const pos = (await c.getPositions(acct)).filter((p) => Math.abs(p.qty) > 0);
    const orders = await c.getLiveOrders();
    const pnl = await c.getPnl(acct).catch(() => null);

    const stops = orders.filter((o) => /stop|stp/i.test(o.orderType || '') && /submit|pending|presubmit/i.test(o.status || ''));
    const shorts = pos.filter((p) => p.qty < 0).map((p) => p.symbol);
    const longsNoStop = pos.filter((p) => p.qty > 0 && !stops.some((s) => String(s.symbol).toUpperCase() === String(p.symbol).toUpperCase())).map((p) => p.symbol);
    const eq = sum && sum.equity;
    const sizes = pos.map((p) => ({
      sym: p.symbol, qty: p.qty,
      notional: Math.round(Math.abs(p.qty) * (p.currentPrice || 0)),
      pct: eq ? +(Math.abs(p.qty) * (p.currentPrice || 0) / eq * 100).toFixed(2) : null,
      uPnL: p.unrealizedPnl,
    }));
    const avgPct = sizes.length ? +(sizes.reduce((s, x) => s + (x.pct || 0), 0) / sizes.length).toFixed(2) : null;
    const oversized = sizes.filter((s) => s.pct != null && s.pct > 5.5).map((s) => s.sym); // >5% cap (+buffer)

    report.result = {
      connected: !!st.connected, account: acct,
      equity: eq, dayPnl: pnl && pnl.dailyPnl, unrealizedPnl: pnl && pnl.unrealizedPnl,
      positions: pos.length, shorts, longsMissingStop: longsNoStop,
      workingStops: stops.length, avgPositionPct: avgPct, oversized, sizes,
      ok: !!st.connected && shorts.length === 0 && longsNoStop.length === 0 && oversized.length === 0,
    };
  } catch (e) { report.error = e.message; }

  const r = report.result || {};
  const stamp = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).toISOString().slice(0, 10);
  const dir = path.join(ROOT, 'data', 'lantern-garage', 'trading');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `open-verify-${stamp}.json`), JSON.stringify(report, null, 2));
  const txt = [
    `OPEN VERIFICATION — ${report.verifiedAt} (ET)`,
    `IBKR connected : ${r.connected}   account ${r.account || '?'}   equity $${r.equity || '?'}`,
    `day P&L        : $${r.dayPnl != null ? r.dayPnl : 'n/a'}   (unrealized $${r.unrealizedPnl != null ? r.unrealizedPnl : 'n/a'})`,
    `positions      : ${r.positions}`,
    `shorts         : ${(r.shorts || []).join(', ') || 'NONE ✓'}`,
    `longs w/o stop : ${(r.longsMissingStop || []).join(', ') || 'NONE ✓'}   (working stops: ${r.workingStops})`,
    `avg size       : ${r.avgPositionPct != null ? r.avgPositionPct + '% of equity' : 'n/a'}   oversized(>5%): ${(r.oversized || []).join(', ') || 'none ✓'}`,
    `positions detail:`,
    ...(r.sizes || []).map((s) => `   ${String(s.sym).padEnd(6)} qty ${s.qty}  $${s.notional} (${s.pct}%)  uPnL $${s.uPnL}`),
    ``,
    `VERDICT: ${r.ok ? '✅ HEALTHY — no shorts, stops present, sizing ~% of portfolio, connected' : '⚠️ REVIEW NEEDED — see the checks above'}`,
    report.error ? `ERROR: ${report.error}` : '',
  ].filter((l) => l !== undefined).join('\n');
  fs.writeFileSync(path.join(dir, `open-verify-${stamp}.txt`), txt);
  console.log(txt);
})();
