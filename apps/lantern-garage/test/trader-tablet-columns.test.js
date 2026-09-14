'use strict';
/**
 * test/trader-tablet-columns.test.js — the desk keeps its six columns on tablets (QA, 2026-09-14).
 *
 * The <=1024px tier carried the pre-desk two-column template `var(--sidebar-w,296px) 1fr`
 * (#3044). On the six-column desk (#3360) that put the drawing rail in a 296px column and
 * the ticket + right docks in implicit ~80px slivers. The tier now narrows the docks and
 * leaves the template alone.
 *
 * Run: node --test apps/lantern-garage/test/trader-tablet-columns.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'stock-trader.html'), 'utf8').replace(/\r\n/g, '\n');

function mediaBlock(query) {
  const at = PAGE.indexOf('@media (' + query + '){');
  assert.notStrictEqual(at, -1, 'no ' + query + ' tier');
  let depth = 0, i = PAGE.indexOf('{', at);
  for (; i < PAGE.length; i++) {
    if (PAGE[i] === '{') depth++;
    else if (PAGE[i] === '}' && --depth === 0) break;
  }
  return PAGE.slice(at, i + 1);
}

test('the desk grid has six columns: rail, left dock, chart, ticket, right dock, rail', () => {
  assert.match(PAGE, /\.layout\{display:grid;grid-template-columns:44px var\(--col-l\) minmax\(0,1fr\) var\(--col-t\) var\(--col-r\) 44px;/);
});

test('the tablet tier does not replace the six-column template with the old two-column one', () => {
  const tier = mediaBlock('max-width:1024px');
  assert.doesNotMatch(tier, /\.layout\{grid-template-columns:var\(--sidebar-w/, 'the pre-desk template is back');
  assert.doesNotMatch(tier, /\.layout\s*\{[^}]*grid-template-columns/, 'the tier must not redefine the desk columns');
});

test('the tablet tier narrows the docks instead, so the chart keeps room', () => {
  const tier = mediaBlock('max-width:1024px');
  assert.match(tier, /--col-l:min\(var\(--dockl-w,360px\),30vw\)/);
  assert.match(tier, /--col-t:min\(var\(--ticket-w,320px\),28vw\)/);
  assert.match(tier, /--col-r:min\(340px,28vw\)/);
  // A closed dock is still 0px: the body-level overrides beat the :root tier.
  assert.match(PAGE, /body\.ticket-closed\{--col-t:0px\}/);
  assert.match(PAGE, /body\.rightdock-closed\{--col-r:0px\}/);
  assert.match(PAGE, /body\.leftdock-closed\{--col-l:0px\}/);
});
