// PR-review intent router — regression for issue #1738.
//
// A user typed "review pull requests" in dream-chat and got the dead-end
// "AI unavailable. Add a provider key…" fallback: the plural ask has no PR number,
// so it never matched `!review #N` and fell through to the (all-down) LLM path.
// detectPrReviewIntent() now catches that natural-language ask and routes it to the
// deterministic, provider-free open-PR browser instead.
//
// detectPrReviewIntent lives in the browser file dream-chat-ui.js (no exports), so
// we extract its source by name and eval it — exercising the REAL shipped function.
//
// Run: node apps/lantern-garage/test/pr-review-intent.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  -', name); }
  catch (e) { failures++; console.error('  FAIL-', name, '\n      ', e.message); }
}

// Pull `function detectPrReviewIntent(text) { … }` out of the source via brace matching.
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, name + ' not found in dream-chat-ui.js');
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i = j; break; } }
  }
  const body = src.slice(start, i + 1);
  // eslint-disable-next-line no-new-func
  return new Function(body + '\nreturn ' + name + ';')();
}

const src = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dream-chat-ui.js'), 'utf8');
const detectPrReviewIntent = extractFn(src, 'detectPrReviewIntent');

// ── the reported case: plural, no number → list (was the AI-unavailable dead-end) ──
check('"review pull requests" → list', () =>
  assert.deepStrictEqual(detectPrReviewIntent('review pull requests'), { kind: 'list' }));
check('"review prs" → list', () =>
  assert.deepStrictEqual(detectPrReviewIntent('review prs'), { kind: 'list' }));
check('"review the open PRs" → list', () =>
  assert.deepStrictEqual(detectPrReviewIntent('review the open PRs'), { kind: 'list' }));
check('"show open pull requests" → list', () =>
  assert.deepStrictEqual(detectPrReviewIntent('show open pull requests'), { kind: 'list' }));
check('"list prs" → list', () =>
  assert.deepStrictEqual(detectPrReviewIntent('list prs'), { kind: 'list' }));
check('trailing "?" tolerated', () =>
  assert.deepStrictEqual(detectPrReviewIntent('review pull requests?'), { kind: 'list' }));

// ── bang/slash forms ──────────────────────────────────────────────────────────
check('"!prs" → list', () =>
  assert.deepStrictEqual(detectPrReviewIntent('!prs'), { kind: 'list' }));
check('"/prs" → list', () =>
  assert.deepStrictEqual(detectPrReviewIntent('/prs'), { kind: 'list' }));
check('"!pull-requests" → list', () =>
  assert.deepStrictEqual(detectPrReviewIntent('!pull-requests'), { kind: 'list' }));
check('bare "!review" (no number) → list', () =>
  assert.deepStrictEqual(detectPrReviewIntent('!review'), { kind: 'list' }));
check('"!prs #5" → review PR 5', () =>
  assert.deepStrictEqual(detectPrReviewIntent('!prs #5'), { kind: 'one', number: 5 }));

// ── single-PR natural language → route to !review #N ──────────────────────────
check('"review pr #1410" → one/1410', () =>
  assert.deepStrictEqual(detectPrReviewIntent('review pr #1410'), { kind: 'one', number: 1410 }));
check('"review pull request 1410" → one/1410', () =>
  assert.deepStrictEqual(detectPrReviewIntent('review pull request 1410'), { kind: 'one', number: 1410 }));
check('"review #1410" → one/1410', () =>
  assert.deepStrictEqual(detectPrReviewIntent('review #1410'), { kind: 'one', number: 1410 }));

// ── `!review #N` is left to the server reviewer (must NOT be intercepted) ──────
check('"!review #1302" → null (server handles it)', () =>
  assert.strictEqual(detectPrReviewIntent('!review #1302'), null));
check('"/review #1302" → null (server handles it)', () =>
  assert.strictEqual(detectPrReviewIntent('/review #1302'), null));

// ── must NOT hijack ordinary chat turns ───────────────────────────────────────
for (const neg of [
  'review my essay',
  'can you review this code for bugs',
  'review the quarterly numbers',
  'what are pull requests',
  'how do I open a pull request',
  'show me a video of cats',
  'pull up the radio',
  '',
  'review',            // bare word, no PR context, no bang → LLM turn
]) {
  check(`negative: "${neg}" → null`, () =>
    assert.strictEqual(detectPrReviewIntent(neg), null));
}

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log('\nall PR-review intent checks passed');
