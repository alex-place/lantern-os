// Watch and Trade each carry their own copy of the ticker-card renderer.
//
// That duplication is the real defect behind #3351: aff7adf4 removed the
// "Nearest: S $534.38 · 8T" support/resistance line from stock-trader.html and
// nothing else, so watch.html kept rendering it for months. A fix applied to one
// page silently misses the other, and nothing failed.
//
// This locks the fields the two pages are supposed to agree on. It is deliberately
// a SHORT list -- the pages legitimately differ (Watch has no order ticket, no
// drawing tools, no indicators) -- so this asserts parity only where divergence is
// a bug rather than a design choice.
//
// The right long-term fix is extracting one shared renderer. Until then this fails
// loudly instead of drifting quietly.
//
// Run: node apps/lantern-garage/test/card-renderer-parity.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const trade = fs.readFileSync(path.join(PUB, 'stock-trader.html'), 'utf8');
const watch = fs.readFileSync(path.join(PUB, 'watch.html'), 'utf8');

let failures = 0;
const check = (name, fn) => {
  try { fn(); process.stdout.write('  ok  - ' + name + '\n'); }
  catch (e) { failures++; process.stderr.write('  FAIL- ' + name + '\n      ' + e.message + '\n'); }
};

// Each entry: a card feature, and whether both pages should render it.
// `both: false` means "removed from the product" -- neither page may carry it.
const CARD_FEATURES = [
  {
    name: 'nearest support/resistance line',
    // The exact string aff7adf4 deleted. If someone re-adds it to either page,
    // that is a product decision that should be made on both at once.
    probe: 'Nearest:',
    both: false,
  },
  {
    name: 'pattern chip',
    // Kept on BOTH, opt-in behind the Patterns menu on each. Asymmetry here would
    // mean one page started showing detections the other hides.
    probe: 'patternChipHtml',
    both: true,
  },
  {
    name: 'signal confidence badge',
    probe: 'sigBadge',
    both: true,
  },
];

for (const f of CARD_FEATURES) {
  check(`${f.name}: ${f.both ? 'present on both pages' : 'absent from both pages'}`, () => {
    const inTrade = trade.includes(f.probe);
    const inWatch = watch.includes(f.probe);
    if (f.both) {
      assert.ok(inTrade && inWatch,
        `expected on both — trade:${inTrade} watch:${inWatch}. One page dropped it; decide for both.`);
    } else {
      assert.ok(!inTrade && !inWatch,
        `expected on neither — trade:${inTrade} watch:${inWatch}. It was removed from the product; a page still renders it.`);
    }
  });
}

check('the duplication itself is still flagged for extraction', () => {
  // Not a behaviour assertion: a reminder that this test exists because two files
  // hand-roll the same card. Delete this whole file when a shared renderer lands.
  assert.ok(trade.includes('patternChipHtml') && watch.includes('patternChipHtml'),
    'if either page stopped hand-rolling the card, revisit whether this guard is still the right shape');
});

process.exit(failures ? 1 : 0);
