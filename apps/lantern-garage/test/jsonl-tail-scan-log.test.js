'use strict';
/**
 * jsonl-tail-scan-log.test.js — the stable box's two runaway JSONL files (2026-10-25).
 *
 * data/lantern-garage/trading/agent-log.jsonl reached 430 MB (each scan's rows ~3 times:
 * every /zones poll re-appended them) and data/csf_memory/raw.jsonl 470 MB (97.5 % per-scan
 * signal traces). Both were parsed WHOLE after every append to answer "the last N rows",
 * and the server died at 15:38 ET on 10-19 (heap OOM suspected). Pins:
 *  - readJsonlTail parses only the tail, oldest first, and caches on mtime/size;
 *  - listLogEntries / listOrders with a limit read the tail and hand back a copy;
 *  - recordScanLog writes a scan's rows once, to the trading store only (no CSF record);
 *  - recordNewSignals still writes CSF by default (POST /api/trading/agent-log callers);
 *  - queryRecentTradingRecords still answers newest-first from the registry's tail.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-tail-'));
process.env.CSF_MEMORY_PATH = path.join(DIR, 'csf_memory');
process.env.LANTERN_TRADING_DATA_PATH = path.join(DIR, 'trading');
fs.mkdirSync(process.env.CSF_MEMORY_PATH, { recursive: true });
fs.mkdirSync(process.env.LANTERN_TRADING_DATA_PATH, { recursive: true });

const { readJsonlTail, readJsonlCached } = require('../lib/jsonl-cache');
const tradingStore = require('../lib/trading-store');
const tradingMemory = require('../lib/trading-memory');

const rawPath = () => path.join(process.env.CSF_MEMORY_PATH, 'raw.jsonl');
const lineCount = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0);

test('readJsonlTail returns the last N records of a file far larger than its first read window', () => {
  const f = path.join(DIR, 'big.jsonl');
  const pad = 'x'.repeat(200);
  const rows = []; for (let i = 0; i < 6000; i++) rows.push(JSON.stringify({ i, pad }));   // ~1.3 MB, several windows
  fs.writeFileSync(f, rows.join('\n') + '\n');
  const tail = readJsonlTail(f, 25);
  assert.strictEqual(tail.length, 25);
  assert.deepStrictEqual(tail.map((r) => r.i), Array.from({ length: 25 }, (_, k) => 5975 + k), 'the newest 25, oldest first');
  assert.deepStrictEqual(readJsonlTail(f, 25), tail, 'same answer from the cache');
  assert.strictEqual(readJsonlTail(f, 25), tail, 'unchanged file -> the cached array itself');
  fs.appendFileSync(f, JSON.stringify({ i: 6000, pad }) + '\n');
  assert.strictEqual(readJsonlTail(f, 1)[0].i, 6000, 'an append is seen');
  assert.strictEqual(readJsonlTail(f, 25)[24].i, 6000, 'the cache key moves with mtime/size');
});

test('readJsonlTail: a window cut mid-record drops the partial line; CRLF, bad lines, missing file', () => {
  const f = path.join(DIR, 'crlf.jsonl');
  const body = ['{"a":1}', 'not json', '{"a":2}', '', '{"a":3}'].join('\r\n') + '\r\n';
  fs.writeFileSync(f, body);
  assert.deepStrictEqual(readJsonlTail(f, 10).map((r) => r.a), [1, 2, 3], 'whole small file, bad and blank lines skipped');
  assert.deepStrictEqual(readJsonlTail(path.join(DIR, 'missing.jsonl'), 5), []);
  assert.deepStrictEqual(readJsonlTail(f, 0), []);
  // a byte window too small for the request: only complete records inside it come back
  const g = path.join(DIR, 'window.jsonl');
  const rows = []; for (let i = 0; i < 2000; i++) rows.push(JSON.stringify({ i, pad: 'y'.repeat(500) }));
  fs.writeFileSync(g, rows.join('\n') + '\n');
  const capped = readJsonlTail(g, 1000, { maxBytes: 64 * 1024 });
  assert.ok(capped.length > 0 && capped.length < 1000, `capped window returns some, not all (${capped.length})`);
  assert.strictEqual(capped[capped.length - 1].i, 1999, 'still the newest record last');
  assert.ok(capped.every((r, k) => k === 0 || r.i === capped[k - 1].i + 1), 'contiguous, no partial record');
});

test('listLogEntries({limit}) answers from the tail and returns a copy', async () => {
  for (let i = 0; i < 300; i++) await tradingStore.appendLogEntry({ id: `row_${i}`, agent: 'scanner', action: 'x' });
  const last5 = tradingStore.listLogEntries({ limit: 5 });
  assert.deepStrictEqual(last5.map((r) => r.id), ['row_295', 'row_296', 'row_297', 'row_298', 'row_299']);
  last5.reverse();
  assert.strictEqual(tradingStore.listLogEntries({ limit: 5 })[0].id, 'row_295', 'a caller mutating its result cannot corrupt the cache');
  assert.strictEqual(tradingStore.listLogEntries().length, 300, 'no limit = every row (unchanged contract)');
});

test('recordScanLog writes a scan once, to the trading store only; a new scan writes again', async () => {
  const agentLog = tradingStore.agentLogPath();
  const before = lineCount(agentLog), rawBefore = lineCount(rawPath());
  const rows = [{ id: 'scan_T1_summary', agent: 'scanner', action: 'Scanned 20 tickers - 1 signal', timestamp: 'T1' },
    { id: 'scan_T1_SPY', agent: 'scanner', action: 'BULLISH', symbol: 'SPY', timestamp: 'T1' }];
  assert.strictEqual((await tradingMemory.recordScanLog('T1', rows)).length, 2);
  assert.strictEqual((await tradingMemory.recordScanLog('T1', rows)).length, 0, 'the same scan polled again writes nothing');
  assert.strictEqual((await tradingMemory.recordScanLog('T1', rows)).length, 0);
  assert.strictEqual(lineCount(agentLog), before + 2, 'agent-log holds the scan once');
  assert.strictEqual(lineCount(rawPath()), rawBefore, 'no CSF memory record for scan rows');
  const rows2 = rows.map((r) => ({ ...r, id: r.id.replace('T1', 'T2'), timestamp: 'T2' }));
  assert.strictEqual((await tradingMemory.recordScanLog('T2', rows2)).length, 2, 'the next scan is written');
  assert.strictEqual(lineCount(rawPath()), rawBefore, 'still no CSF record');
});

test('recordNewSignals keeps writing CSF by default (POSTed agent-log entries)', async () => {
  const rawBefore = lineCount(rawPath());
  await tradingMemory.recordNewSignals({ logs: [{ id: 'posted_1', agent: 'grok', action: 'AAPL bullish', symbol: 'AAPL' }] });
  assert.strictEqual(lineCount(rawPath()), rawBefore + 1, 'one CSF trace for the posted signal');
  await tradingMemory.recordNewSignals({ logs: [{ id: 'posted_2', agent: 'grok', action: 'x' }] }, { toCsf: false });
  assert.strictEqual(lineCount(rawPath()), rawBefore + 1, 'toCsf:false skips it');
});

test('queryRecentTradingRecords answers newest-first from the registry tail', async () => {
  for (let i = 0; i < 5; i++) await tradingMemory.recordOrder({ id: `ord_tail_${i}`, symbol: 'SPY', side: 'buy', qty: 1, status: 'filled' });
  const recent = tradingMemory.queryRecentTradingRecords(3, 'order');
  assert.strictEqual(recent.length, 3);
  assert.deepStrictEqual(recent.map((r) => r.content.order_id), ['ord_tail_4', 'ord_tail_3', 'ord_tail_2']);
  const signals = tradingMemory.queryRecentTradingRecords(10, 'signal');
  assert.ok(signals.every((r) => r.tags.includes('signal')) && signals.some((r) => r.content.signal_id === 'posted_1'));
  assert.ok(readJsonlCached(rawPath()).length >= 6, 'the registry itself is intact');
});
