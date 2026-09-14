'use strict';
/**
 * test/settings-error-words.test.js — the settings page speaks in sentences, not codes
 * (QA, 2026-09-14).
 *
 * The change-email modal printed "invalid_email", a rejected AI key alerted
 * "invalid_key_value", a cancel with no billing alerted "billing_not_configured". One table
 * (SAID) and one helper (saidBy) now serve every modal and alert on the page.
 *
 * Run: node --test apps/lantern-garage/test/settings-error-words.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.html'), 'utf8').replace(/\r\n/g, '\n');
const start = PAGE.indexOf('  const SAID = {');
const end = PAGE.indexOf('\n  }\n', PAGE.indexOf('function saidBy(o, fallback)')) + 4;
assert.ok(start > 0 && end > start, 'SAID / saidBy not found');
const saidBy = new Function(PAGE.slice(start, end) + '\nreturn saidBy;')();

test('known codes become sentences', () => {
  assert.strictEqual(saidBy({ ok: false, body: { error: 'invalid_email' } }, 'x'), "That doesn't look like an email address.");
  assert.strictEqual(saidBy({ ok: false, body: { error: 'email_taken' } }, 'x'), 'That email is already used by another account.');
  assert.strictEqual(saidBy({ ok: false, body: { error: 'invalid_key_value' } }, 'x'), "That doesn't look like a valid API key for this provider.");
  assert.strictEqual(saidBy({ ok: false, body: { error: 'billing_not_configured' } }, 'x'), "Billing isn't set up on this server.");
  assert.strictEqual(saidBy({ ok: false, body: { error: 'wrong_password' } }, 'x'), 'That current password is incorrect.');
  assert.strictEqual(saidBy({ ok: false, body: { error: 'weak_password', detail: 'min 8 chars' } }, 'x'), 'Pick a longer password (at least 8 characters).');
});

test('a bare unknown code falls back to the caller\'s words; a sentence from the server is kept', () => {
  assert.strictEqual(saidBy({ ok: false, body: { error: 'some_new_code' } }, 'Could not save key.'), 'Could not save key.');
  assert.strictEqual(saidBy({ ok: false, body: {} }, 'Could not change email.'), 'Could not change email.');
  assert.strictEqual(saidBy({ ok: false }, 'fallback'), 'fallback');
  assert.strictEqual(saidBy(null, 'fallback'), 'fallback');
  const alpaca = 'Alpaca rejected those keys. Double-check you pasted a PAPER API key + secret.';
  assert.strictEqual(saidBy({ ok: false, body: { error: 'invalid_keys', message: alpaca } }, 'x'), alpaca);
});

test('every modal and alert on the page goes through the table', () => {
  assert.doesNotMatch(PAGE, /return \(o\.body && \(o\.body\.error \|\| o\.body\.message\)\) \|\|/, 'change-email still shows the raw code');
  assert.doesNotMatch(PAGE, /alert\(\(o\.body && \(o\.body\.error \|\| o\.body\.detail\)\)/, 'an alert still shows the raw code');
  assert.match(PAGE, /return saidBy\(o, "Could not change email\."\)/);
  assert.match(PAGE, /return saidBy\(o, "Could not update your password\."\)/);
  assert.match(PAGE, /alert\(saidBy\(o, "Could not cancel here/);
  assert.match(PAGE, /alert\(saidBy\(o, "Could not save key\."\)\)/);
});

test('changing the email to the address already on the account is refused before any request', () => {
  assert.match(PAGE, /return "That is already the address on your account\.";/);
  const at = PAGE.indexOf('That is already the address on your account.');
  const fetchAt = PAGE.indexOf('api("/api/profiles/me/change-email"', at);
  assert.ok(fetchAt > at, 'the guard must run before the request');
});
