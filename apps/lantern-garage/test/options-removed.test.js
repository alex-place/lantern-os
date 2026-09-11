'use strict';
// #3508 -- options trading was removed (#3485). Every option order goes through one
// door, options-shadow.placePaperOrder: the shadow's paper bridge and the overnight
// book's options tier both call it. It must refuse to OPEN a position whatever the old
// switches say, and it must refuse before any broker call is made.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// Arm the old switches on purpose: the refusal must not depend on them being off.
process.env.OPTIONS_PAPER = '1';
process.env.OVERNIGHT_TRADER = '1';
process.env.OVERNIGHT_EXEC = 'options';
const sh = require(path.join(__dirname, '..', 'lib', 'options-shadow'));

test('no new option positions: a buy is refused, and nothing is sent', async () => {
  const r = await sh.placePaperOrder({ contract: 'SPY260918C00700000', side: 'buy', qty: 1, limit: 1.23 });
  assert.ok(r && r.error, 'refused with an error');
  assert.match(r.error, /options trading was removed/);
  assert.ok(!r.order_id, 'no order id: no order reached a broker');
});

test('the refusal cannot be dodged by casing, a missing side, or an unknown side', async () => {
  for (const side of ['BUY', 'Buy', undefined, '', 'buy_to_open']) {
    const r = await sh.placePaperOrder({ contract: 'SPY260918C00700000', side, qty: 1, limit: 1 });
    assert.match(String(r && r.error), /options trading was removed/, `side=${String(side)}`);
  }
});

test('a sell is not refused by the removal (a pre-existing leg can still be closed)', async () => {
  const r = await sh.placePaperOrder({ contract: 'SPY260918C00700000', side: 'sell', qty: 1, limit: 1 });
  assert.doesNotMatch(String(r && r.error), /options trading was removed/);
});
