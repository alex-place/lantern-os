'use strict';
/**
 * test/trader-trade-gate.test.js — the order ticket and the chat are not open for readers
 * who cannot use them (founder, 2026-09-28).
 *
 * Measured on the shipped page at 1600px before this: a LOGGED-OUT visitor got
 * #ticketDock at 320px and the chat at 359px — 680px of the screen spent on two panels
 * they cannot use, and the same for a signed-in reader with no broker connected.
 * `body.guest` had hidden the per-card BUY/SELL buttons and the #otBg overlay since the
 * ticket was an overlay; it never covered the docked COLUMN the ticket lives in now.
 *
 * Three refusals, because "log in" is the wrong instruction for two of them, and a
 * fourth state that is NOT a refusal:
 *
 *   unknown   the broker answer is still in flight  → show it; gating on the wait would
 *                                                     blink the ticket shut every load
 *                                                     for the one reader entitled to it
 *   signin    no session at all                     → /auth.html
 *   upgrade   signed in, no trade tier              → /pricing.html (sign-in is a dead
 *                                                     end for someone already signed in)
 *   broker    entitled, no broker connected         → /settings.html#connections
 *
 * Run: node --test apps/lantern-garage/test/trader-trade-gate.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');
const fn = (name) => {
  const a = PAGE.indexOf('function ' + name + '(');
  assert.ok(a > 0, name + ' not found');
  return PAGE.slice(a, PAGE.indexOf('\n}\n', a) + 3);
};
const decl = (name) => {
  const a = PAGE.indexOf('\nconst ' + name + ' =');
  assert.ok(a > 0, name + ' not found');
  return PAGE.slice(a + 1, PAGE.indexOf('\n', PAGE.indexOf(';', a)) + 1);
};

/** The gate, with the two facts it reads injected. `nav` records a redirect. */
function gate({ GUEST, AUTHED, brokerOk = null }) {
  const win = { GUEST, AUTHED };
  const nav = [];
  const src = 'let _brokerOk = ' + JSON.stringify(brokerOk) + ';\n'
    + PAGE.slice(PAGE.indexOf('const _GATE_DEST = {'), PAGE.indexOf('function _refreshTradeGate'))
    + '\nreturn { _tradeGate, _canTrade, _chatAllowed, _gateBlocked, _GATE_DEST };';
  return Object.assign(
    new Function('window', 'location', src)(win, { set href(v) { nav.push(v); }, get href() { return nav[nav.length - 1]; } }),
    { nav });
}

test('the four states are told apart', () => {
  assert.strictEqual(gate({ GUEST: undefined })._tradeGate(), 'unknown', 'before the session answers');
  assert.strictEqual(gate({ GUEST: true, AUTHED: false })._tradeGate(), 'signin', 'no session → sign in');
  assert.strictEqual(gate({ GUEST: true, AUTHED: true })._tradeGate(), 'upgrade', 'signed in, no tier → upgrade');
  assert.strictEqual(gate({ GUEST: false, AUTHED: true, brokerOk: null })._tradeGate(), 'unknown', 'broker not answered yet');
  assert.strictEqual(gate({ GUEST: false, AUTHED: true, brokerOk: false })._tradeGate(), 'broker');
  assert.strictEqual(gate({ GUEST: false, AUTHED: true, brokerOk: true })._tradeGate(), 'ok');
});

test('an unanswered broker is not a refusal — the ticket must not blink shut on load', () => {
  // The whole reason 'unknown' exists. _brokerOk arrives with the first positions poll;
  // treating the wait as "no" would close the ticket on every load for a real trader.
  assert.strictEqual(gate({ GUEST: false, AUTHED: true, brokerOk: null })._canTrade(), true);
  assert.strictEqual(gate({ GUEST: undefined })._canTrade(), true, 'before the session answers, either');
  assert.strictEqual(gate({ GUEST: false, AUTHED: true, brokerOk: false })._canTrade(), false, 'a real "no" closes it');
});

test('the chat needs an account, not a broker', () => {
  // Signed in with no broker is a perfectly good reason to ask the assistant about a
  // market, so the chat gate reads AUTHED and never _brokerOk.
  assert.strictEqual(gate({ GUEST: false, AUTHED: true, brokerOk: false })._chatAllowed(), true);
  assert.strictEqual(gate({ GUEST: true, AUTHED: true })._chatAllowed(), true, 'a supporter can still chat');
  assert.strictEqual(gate({ GUEST: true, AUTHED: false })._chatAllowed(), false, 'logged out cannot');
  assert.strictEqual(gate({ GUEST: undefined })._chatAllowed(), true, 'unknown does not close it');
});

test('each refusal lands on the page that would fix it', () => {
  const signedOut = gate({ GUEST: true, AUTHED: false });
  assert.strictEqual(signedOut._gateBlocked('ticket'), true);
  assert.strictEqual(signedOut.nav.pop(), '/auth.html?returnTo=%2Fstock-trader.html');

  const noTier = gate({ GUEST: true, AUTHED: true });
  assert.strictEqual(noTier._gateBlocked('ticket'), true);
  const dest = noTier.nav.pop();
  assert.strictEqual(dest, '/pricing.html');
  assert.doesNotMatch(dest, /auth\.html/, 'telling someone already signed in to sign in is a dead end');

  const noBroker = gate({ GUEST: false, AUTHED: true, brokerOk: false });
  assert.strictEqual(noBroker._gateBlocked('ticket'), true);
  assert.strictEqual(noBroker.nav.pop(), '/settings.html#connections');
});

test('a reader who may trade is not redirected anywhere', () => {
  const ok = gate({ GUEST: false, AUTHED: true, brokerOk: true });
  assert.strictEqual(ok._gateBlocked('ticket'), false);
  assert.strictEqual(ok._gateBlocked('chat'), false);
  assert.deepStrictEqual(ok.nav, [], 'nothing navigated');
  // ...and neither is one whose broker answer has not arrived.
  const waiting = gate({ GUEST: false, AUTHED: true, brokerOk: null });
  assert.strictEqual(waiting._gateBlocked('ticket'), false);
  assert.deepStrictEqual(waiting.nav, []);
});

test('the chat button sends only a LOGGED-OUT reader away', () => {
  const noBroker = gate({ GUEST: false, AUTHED: true, brokerOk: false });
  assert.strictEqual(noBroker._gateBlocked('chat'), false, 'no broker is not a chat problem');
  const out = gate({ GUEST: true, AUTHED: false });
  assert.strictEqual(out._gateBlocked('chat'), true);
  assert.strictEqual(out.nav.pop(), '/auth.html?returnTo=%2Fstock-trader.html');
});

test('the gate is DERIVED — it never writes the reader’s own preference', () => {
  // _ticketOpen / _leftOpen stay whatever the reader chose, so both panels come back
  // exactly as they left them the moment they sign in or connect a broker. Verified in
  // the browser: setting _brokerOk = true reopened the ticket at its saved 320px with
  // no action from the reader.
  const apply = fn('_applyDocks');
  assert.match(apply, /const ticketShown = _ticketOpen && _canTrade\(\);/);
  assert.match(apply, /const chatShown\s+= _leftOpen && _chatAllowed\(\);/);
  assert.doesNotMatch(apply, /_ticketOpen\s*=/, '_applyDocks must not assign the preference');
  assert.doesNotMatch(apply, /_leftOpen\s*=/, 'nor this one');
  assert.doesNotMatch(apply, /_saveDocks\(\)/, 'and it must not persist a refusal as a choice');
});

test('every way into the ticket asks the gate', () => {
  assert.match(fn('openOrderTicket'), /if\(_gateBlocked\('ticket'\)\) return;/, 'the per-card BUY/SELL and the B/S keys');
  assert.match(fn('toggleTicketDock'), /if \(_gateBlocked\('ticket'\)\) return;/, 'the rail tab');
  assert.match(PAGE, /function toggleLeftDock\(\) \{ if \(_gateBlocked\('chat'\)\) return;/, 'the chat rail tab');
  assert.match(PAGE, /if \(wantsOpen && _gateBlocked\('chat'\)\) return;/, 'and dcToggle');
  // Closing must stay possible whatever the gate says, or a reader could be stuck.
  assert.match(PAGE, /Opening is gated; closing is always allowed/);
});

test('the phone does not slip past it', () => {
  // Two independent bypasses, both measured at 375px: the wrapper switched VIEW before
  // delegating, and a CSS !important re-showed the ticket in the trade view.
  const wrapper = PAGE.slice(PAGE.indexOf('var _ttd = window.toggleTicketDock;'), PAGE.indexOf('function fromHash()'));
  assert.match(wrapper, /_gateBlocked\('ticket'\)/, 'the phone tap must ask the gate itself');
  assert.ok(wrapper.indexOf('_gateBlocked') < wrapper.indexOf("setMobileView(document.querySelector('.layout.mv-trade')"),
    'and ask BEFORE switching view');
  assert.match(PAGE, /body\.trade-locked \.layout\.mv-trade #ticketDock\{ display:none !important; \}/,
    'a refusal must outrank the phone trade view');
  assert.match(fn('_applyDocks'), /classList\.toggle\('trade-locked', !_canTrade\(\)\)/,
    'and something must set that class');
});

test('the two facts the gate waits on are actually published', () => {
  // window.AUTHED is separate from window.GUEST: a supporter is a GUEST for trading and
  // is emphatically not logged out.
  assert.match(fn('detectGuestMode'), /window\.AUTHED = authed;/);
  assert.match(fn('detectGuestMode'), /_refreshTradeGate\(\);/, 'and the panels settle when it lands');
  // _brokerOk comes from the endpoint whose available:false exists to say exactly this.
  assert.match(PAGE, /_brokerOk = false; _refreshTradeGate\(\);/);
  assert.match(PAGE, /_brokerOk = true; _refreshTradeGate\(\);/);
});
