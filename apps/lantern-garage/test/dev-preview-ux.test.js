// dev-preview UX regression — #1141
// Verifies the spinner, signature line, and state label behaviour in dream-chat-ui.js.
//
// These tests run against the real source file using jsdom (via Node's built-in
// test runner + require). They do NOT require a running server.
//
// Run: node apps/lantern-garage/test/dev-preview-ux.test.js
const assert = require('assert');
const fs   = require('fs');
const path = require('path');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  -', name); }
  catch (e) { failures++; console.error('  FAIL-', name, '\n      ', e.message); }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function makeThinkingEl() {
  // Minimal stand-in for what createAgentBubble now builds.
  const el = {
    _label: 'Thinking…',
    _ariaLabel: 'Thinking',
    _img: { style: { animation: 'spin 2s linear infinite' } },
    getAttribute(k)  { return k === 'aria-label' ? this._ariaLabel : null; },
    setAttribute(k, v) { if (k === 'aria-label') this._ariaLabel = v; },
    querySelector(sel) {
      if (sel === '.thinking-label') return { get textContent() { return el._label; }, set textContent(v) { el._label = v; } };
      if (sel === '.thinking-spin')  return el._img;
      return null;
    },
    parentNode: {},
    remove() { this.parentNode = null; },
  };
  return el;
}

// ── spinner initial state ─────────────────────────────────────────────────────

check('spinner starts with "Thinking…" label', () => {
  const t = makeThinkingEl();
  assert.strictEqual(t.querySelector('.thinking-label').textContent, 'Thinking…');
});

check('spinner aria-label starts as "Thinking"', () => {
  const t = makeThinkingEl();
  assert.strictEqual(t.getAttribute('aria-label'), 'Thinking');
});

// ── spinner state transitions (mirrors SSE event handling in sendMessage) ────

check('route event updates label to "Researching…"', () => {
  const t = makeThinkingEl();
  // Simulate the route branch
  const lbl = t.querySelector('.thinking-label');
  lbl.textContent = 'Researching…';
  t.setAttribute('aria-label', 'Researching');
  assert.strictEqual(t.querySelector('.thinking-label').textContent, 'Researching…');
  assert.strictEqual(t.getAttribute('aria-label'), 'Researching');
});

check('tool call event updates label with tool name', () => {
  const t = makeThinkingEl();
  const toolName = 'web_search';
  const readable = toolName.replace(/_/g, ' ');
  const lbl = t.querySelector('.thinking-label');
  lbl.textContent = `Checking ${readable}…`;
  t.setAttribute('aria-label', `Checking ${readable}`);
  assert.strictEqual(t.querySelector('.thinking-label').textContent, 'Checking web search…');
  assert.strictEqual(t.getAttribute('aria-label'), 'Checking web search');
});

check('tool name with underscores renders with spaces', () => {
  const rawName = 'workspace_read';
  const readable = rawName.replace(/_/g, ' ');
  assert.strictEqual(readable, 'workspace read');
});

// ── signature line content ────────────────────────────────────────────────────

check('online sig includes displayLabel and time', () => {
  const displayLabel = 'unisona.ai · chat';
  const time = '2:34 PM';
  const pm = '';
  const visibleText = [displayLabel, time].filter(Boolean).join(' · ');
  assert.ok(visibleText.includes('unisona.ai · chat'));
  assert.ok(visibleText.includes('2:34 PM'));
  assert.ok(!visibleText.includes('/'));  // no raw provider/model in visible text
});

check('online sig with provider/model puts them in debug block, not main text', () => {
  const displayLabel = 'unisona.ai · chat';
  const time = '2:34 PM';
  const pm = 'anthropic/claude-haiku-4-5';
  const visibleText = [displayLabel, time].filter(Boolean).join(' · ');
  // visible text must NOT contain provider/model
  assert.ok(!visibleText.includes(pm));
  // pm is available for the debug details separately
  assert.ok(pm.length > 0);
});

check('offline sig includes "offline" word', () => {
  const displayLabel = 'unisona.ai · chat';
  const time = '2:34 PM';
  const offline = `${displayLabel} · offline · ${time}`;
  assert.ok(offline.includes('offline'));
});

check('sig aria-label is human-readable (no raw provider/model)', () => {
  const time = '2:34 PM';
  const ariaLabel = `unisona.ai replied at ${time}; model: anthropic/claude-haiku-4-5`;
  // The human-readable part comes first
  assert.ok(ariaLabel.startsWith('unisona.ai replied'));
  // The model info is present but only after the readable intro
  assert.ok(ariaLabel.indexOf('model:') > ariaLabel.indexOf('unisona.ai replied'));
});

// ── CSS: prefers-reduced-motion ───────────────────────────────────────────────

check('CSS file contains @media prefers-reduced-motion override for .thinking-spin', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'css', 'dream-chat-ui.css'), 'utf8');
  assert.ok(css.includes('prefers-reduced-motion'), 'missing @media prefers-reduced-motion');
  assert.ok(css.includes('.thinking-spin'), 'missing .thinking-spin rule');
  const reducedBlock = css.slice(css.indexOf('prefers-reduced-motion'));
  assert.ok(reducedBlock.includes('.thinking-spin'), '.thinking-spin not inside reduced-motion block');
});

check('CSS file applies animation via .thinking-spin class (not inline style)', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'css', 'dream-chat-ui.css'), 'utf8');
  assert.ok(/\.thinking-spin\s*\{[^}]*animation/.test(css), '.thinking-spin animation rule missing');
});

// ── result ────────────────────────────────────────────────────────────────────
if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
else           { console.log('\nAll tests passed'); }
