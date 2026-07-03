#!/usr/bin/env node
/**
 * ibkr-probe.js — one-shot IBKR Web API connectivity check (READ-ONLY).
 *
 * Reads IBKR_API_KEY (+ optional IBKR_ACCOUNT_ID / IBKR_BASE_URL) from the env
 * and prints the honest status: reachable, authenticated, account + mode, and —
 * if connected — equity/cash + open positions. Also shows the order-gate posture
 * (dry vs armed). It NEVER places an order.
 *
 * Usage (PowerShell):
 *   $env:IBKR_API_KEY='your_token'; $env:IBKR_ACCOUNT_ID='U1234567'
 *   node scripts/ibkr-probe.js
 * Usage (bash):
 *   IBKR_API_KEY=your_token node scripts/ibkr-probe.js
 *
 * Point at a local Client Portal Gateway instead of the hosted API with:
 *   IBKR_BASE_URL=https://localhost:5000/v1/api
 *
 * Dependency-free (built-ins only) — no npm install needed to run it.
 */
'use strict';

const path = require('path');
const LIB = path.join(__dirname, '..', 'apps', 'lantern-garage', 'lib');
const IbkrCpapi = require(path.join(LIB, 'ibkr-cpapi.js'));
const { orderGate } = require(path.join(LIB, 'trading-guard.js'));

function mask(s) {
  if (!s) return '(unset)';
  const t = String(s);
  return t.length <= 8 ? '••••' : `${t.slice(0, 4)}…${t.slice(-4)}`;
}
function usd(n) {
  return n == null ? 'n/a' : `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

async function main() {
  const client = new IbkrCpapi({ timeoutMs: 8000, statusTtlMs: 0 });

  console.log('IBKR Web API probe (read-only)');
  console.log('──────────────────────────────');
  console.log('base URL     :', client.baseUrl);
  console.log('IBKR_API_KEY :', mask(process.env.IBKR_API_KEY || process.env.IBKR_OAUTH_TOKEN));
  console.log('account id   :', process.env.IBKR_ACCOUNT_ID || '(auto-discover)');
  console.log('');

  const status = await client.getStatus();
  console.log('connected     :', status.connected);
  console.log('reachable     :', status.reachable);
  console.log('authenticated :', status.authenticated);
  console.log('reads usable  :', status.readsOk);
  console.log('session cookie:', client._sessionToken ? 'captured (/tickle)' : '(none)');
  console.log('account       :', status.accountId || '(none)', status.accountId ? `(${status.mode})` : '');
  console.log('evidence:');
  for (const e of status.evidence) console.log('  •', e);
  console.log('');

  if (status.reachable && (status.authenticated || status.readsOk)) {
    const summary = await client.getAccountSummary().catch(() => null);
    if (summary) {
      console.log('account summary:');
      console.log('  equity       :', usd(summary.equity));
      console.log('  cash         :', usd(summary.cash));
      console.log('  buying power :', usd(summary.buyingPower));
      console.log('  unrealized   :', usd(summary.unrealizedPnl));
    } else {
      console.log('account summary: (none returned)');
    }
    const positions = await client.getPositions().catch(() => []);
    console.log('positions    :', positions.length);
    for (const p of positions.slice(0, 10)) {
      console.log(
        `  ${String(p.symbol).padEnd(8)} qty ${p.qty}  @ ${usd(p.avgPrice)}  mkt ${usd(p.currentPrice)}  uPnL ${usd(p.unrealizedPnl)}`,
      );
    }
    console.log('');
  }

  // Order-gate posture — evaluated only, NO order is placed.
  const gate = orderGate({ mode: status.mode, qty: 1, price: 100 });
  console.log('order gate    :', gate.allowed ? `ARMED (${gate.mode}) — real orders WOULD place` : `DRY — ${gate.reason}`);
  console.log('  TRADER_LIVE               :', process.env.TRADER_LIVE || '0');
  console.log('  TRADER_ALLOW_LIVE_ACCOUNT :', process.env.TRADER_ALLOW_LIVE_ACCOUNT || '0');
  console.log('  caps                      : qty', gate.caps.maxQty, '/ notional', usd(gate.caps.maxNotional));
  console.log('');

  // Verdict + next step.
  if (!process.env.IBKR_API_KEY && !process.env.IBKR_OAUTH_TOKEN) {
    console.log('✗ No IBKR_API_KEY set — export it and re-run.');
  } else if (!status.reachable) {
    console.log(`✗ Could not reach ${client.baseUrl} — check network / IBKR_BASE_URL.`);
  } else if (status.authenticated || status.readsOk) {
    console.log('✓ Connected — the bearer key authenticates and reads work.');
  } else {
    console.log('✗ Reachable but NOT authenticated. The token may be expired, may need a brokerage');
    console.log('  session (/tickle login), or your access uses OAuth 1.0a request-signing rather');
    console.log('  than a bearer token. See the evidence above; share it and I can adjust the client.');
  }
  process.exit(status.reachable ? 0 : 1);
}

main().catch((e) => {
  console.error('probe error:', e && e.message ? e.message : e);
  process.exit(1);
});
