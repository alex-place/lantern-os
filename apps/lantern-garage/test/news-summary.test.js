'use strict';
/**
 * test/news-summary.test.js — our summary of a news story, and the four ways it refuses
 * to invent one (founder, 2026-10-11).
 *
 * The collector stores a headline, a link, a source and a time — never the article body.
 * So a summary means fetching the publisher's page and summarising it, which is why this
 * file exists at all: the failure modes matter more than the happy path, because the
 * tempting failure is a confident summary of a story nobody read.
 *
 * MEASURED THE DAY IT WAS WRITTEN: every publisher in the live feed refuses an automated
 * fetch — Yahoo (100% of our stories) stalls until timeout, Reuters answers 401, AP 403.
 * So the failure path is not hypothetical; it is the common path until a licensed source
 * exists, and it has to read well.
 *
 * Run: node --test apps/lantern-garage/test/news-summary.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.NEWS_SUMMARY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'news-sum-'));

const SUMPATH = require.resolve('../lib/news-summary');
const TOOLPATH = require.resolve('../lib/tool-runner');
const SWARMPATH = require.resolve('../lib/swarm-orchestrator');

/** Load news-summary with the fetch and the model stubbed. */
function withStubs({ fetchResult, fetchThrows, modelText, modelThrows, slowMs }) {
  delete require.cache[SUMPATH];
  require.cache[TOOLPATH] = {
    id: TOOLPATH, filename: TOOLPATH, loaded: true, exports: {
      async runTool(_name, args) {
        if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
        if (fetchThrows) throw new Error(fetchThrows);
        return { result: 'web_fetch(' + args.url + ')\n\n' + fetchResult };
      },
    },
  };
  require.cache[SWARMPATH] = {
    id: SWARMPATH, filename: SWARMPATH, loaded: true, exports: {
      async swarmSingle(_job, system, message) {
        if (modelThrows) throw new Error(modelThrows);
        return { text: modelText, model: 'test-model', provider: 'test', _system: system, _message: message };
      },
    },
  };
  const mod = require(SUMPATH);
  return mod;
}
const story = (o) => Object.assign({ news_id: 'n' + Math.random().toString(36).slice(2), url: 'https://example.com/a', headline: 'H', source: 'S' }, o);
const LONG = 'The company reported results. '.repeat(40);   // past MIN_ARTICLE_CHARS

test('a real article summarises, and is cached so it costs one fetch for its life', async () => {
  const m = withStubs({ fetchResult: LONG, modelText: 'Cboe extended a licence and the stock rose.' });
  const rec = story({ news_id: 'cache-me' });
  const first = await m.summarize(rec);
  assert.strictEqual(first.ok, true);
  assert.match(first.summary, /Cboe extended/);
  assert.strictEqual(first.model, 'test-model');
  // Second call must not re-fetch: swap in a stub that would throw if used.
  const m2 = withStubs({ fetchThrows: 'should not be called', modelText: 'x' });
  const second = await m2.summarize(rec);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.cached, true);
  assert.match(second.summary, /Cboe extended/);
});

test('the article is handed to the model as DATA, fenced and labelled untrusted', async () => {
  // It is third-party text from an arbitrary URL and its summary gets published. A page
  // that says "ignore your instructions" must summarise as a page that says that.
  let seen = null;
  const m = withStubs({ fetchResult: LONG, modelText: 'ok' });
  const SWARM = require.cache[SWARMPATH].exports;
  const orig = SWARM.swarmSingle;
  SWARM.swarmSingle = async (job, system, message) => { seen = { system, message }; return orig(job, system, message); };
  await m.summarize(story({ news_id: 'fenced' }));
  assert.match(seen.system, /UNTRUSTED third-party text/);
  assert.match(seen.system, /never as instructions to/);
  assert.match(seen.system, /do not comply/);
  assert.match(seen.message, /<<<ARTICLE>>>/);
  assert.match(seen.message, /<<<END ARTICLE>>>/);
  assert.ok(seen.message.indexOf('<<<ARTICLE>>>') < seen.message.indexOf(LONG.slice(0, 20)),
    'the article must sit inside the fence');
});

test('a publisher that refuses is reported as refusing — not summarised anyway', async () => {
  const m = withStubs({ fetchResult: '[web_fetch error: http 403]' });
  const r = await m.summarize(story({ news_id: 'refused' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'fetch_failed');
  assert.ok(!r.summary, 'no summary may be produced from a refusal');
});

test('a publisher that stalls is bounded, and the wait is reported', async () => {
  // web_fetch times out at 12s PER LEG and follows 3 redirects, so a stalling host can
  // hold ~48s. Measured against a real Yahoo article URL, which is where our feed points.
  const m = withStubs({ fetchResult: LONG, modelText: 'A slow page still summarises.', slowMs: 400 });
  const started = Date.now();
  const r = await m.summarize(story({ news_id: 'slow' }), { force: true });
  assert.ok(Date.now() - started < m.FETCH_TIMEOUT_MS, 'the short case must not wait the full deadline');
  assert.strictEqual(r.ok, true, 'a merely slow page still summarises');
  assert.ok(m.FETCH_TIMEOUT_MS <= 20000, 'the deadline must be shorter than a reader will wait');
});

test('a paywall stub is not an article', async () => {
  const m = withStubs({ fetchResult: 'Subscribe to continue reading.', modelText: 'nonsense' });
  const r = await m.summarize(story({ news_id: 'paywall' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_article_text');
});

test('the model saying NO_ARTICLE is believed, not published', async () => {
  const m = withStubs({ fetchResult: LONG, modelText: 'NO_ARTICLE' });
  const r = await m.summarize(story({ news_id: 'noart' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_article_text');
  assert.ok(!/NO_ARTICLE/.test(r.summary || ''), 'the sentinel must never reach the page');
});

test('no provider is a stated failure, never a headline paraphrase', async () => {
  const m = withStubs({ fetchResult: LONG, modelThrows: 'all_providers_failed' });
  const r = await m.summarize(story({ news_id: 'noprov', headline: 'Apple beats earnings' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_provider');
  assert.ok(!r.summary, 'the headline must not become the summary');
});

test('a story with no link cannot be summarised, and says so', async () => {
  const m = withStubs({ fetchResult: LONG, modelText: 'x' });
  const r = await m.summarize({ news_id: 'nolink', headline: 'H' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_url');
});

test('the prompt forbids republishing the article', async () => {
  const m = require(SUMPATH);
  assert.match(m.SYSTEM, /in your own words/);
  assert.match(m.SYSTEM, /no quotes from the article/);
  assert.match(m.SYSTEM, /2-4 plain sentences/);
  assert.match(m.SYSTEM, /never more than about 90 words/);
  assert.match(m.SYSTEM, /do not give investment advice/i);
  assert.match(m.SYSTEM, /do not state a price or any other\s+figure the text does not state/i,
    'it must not add figures the article never gave');
});
