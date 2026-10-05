'use strict';
/**
 * test/no-inline-style-import.test.js — a page's own <style> block never @imports a sheet.
 *
 * The trader and the journal opened their style block with `@import url('/css/trader.css')`.
 * Harmless to a browser, and the one construct the Dark Reader extension reads on a slower
 * path than every other sheet. On a page that is already dark the extension switches itself
 * off; the import finishes after that, and it rebuilds one override sheet that nothing
 * removes -- for that block alone. Every colour the block sets through a custom property
 * then falls back to the extension's own text colour: gains, losses and neutral text all
 * the same, borders in the text colour, with the palette still saying Classic and the
 * extension reporting itself off (operator, 2026-10-05; Zen + Dark Reader 4.9.133,
 * reproduced headless with and without the extension).
 *
 * A <link> is read on the ordinary path and leaves nothing behind. It sits in the same
 * place in the cascade the import had: after site.css, ahead of the page's own rules.
 *
 * Run: node --test apps/lantern-garage/test/no-inline-style-import.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : (e.name.endsWith('.html') ? [path.join(dir, e.name)] : []));
const PAGES = walk(PUBLIC);

/* The page's REAL <style> blocks. Comments and scripts are stepped over the way a parser
   steps over them, because prose that names a tag is not a tag: both pages carry a note
   that says "the <style> below", and a plain search for the tag starts there. CSS comments
   go too -- one may name the construct this test forbids. */
function styleBlocks(html) {
  const lower = html.toLowerCase();
  const out = [];
  let i = 0;
  for (;;) {
    const m = nextOpener(lower, i);
    if (!m) break;
    if (m.tag === '<!--') {
      const end = lower.indexOf('-->', m.at + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    const close = m.tag === '<script' ? '</script' : '</style';
    const open = lower.indexOf('>', m.at);
    const end = open === -1 ? -1 : lower.indexOf(close, open + 1);
    if (end === -1) break;
    if (m.tag === '<style') out.push({ at: m.at, css: html.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, '') });
    i = end + close.length;
  }
  return out;
}
/* The nearest comment, script or style opener at or after `from`. Plain indexOf, not the
   RegExp method that shares its name with a shell call: the pre-commit scanner reads test
   files for that name and cannot tell the two apart. */
function nextOpener(lower, from) {
  let best = null;
  for (const tag of ['<!--', '<script', '<style']) {
    let at = lower.indexOf(tag, from);
    // The name has to END there: <styles> and <scripted> are other things.
    while (at !== -1 && tag !== '<!--' && /[a-z0-9-]/.test(lower[at + tag.length] || '')) at = lower.indexOf(tag, at + 1);
    if (at !== -1 && (!best || at < best.at)) best = { tag, at };
  }
  return best;
}

test('no page imports a stylesheet from inside a <style> block', () => {
  assert.ok(PAGES.length >= 20, 'the page list looks wrong: ' + PAGES.length);
  const hits = [];
  let blocks = 0;
  for (const file of PAGES) {
    styleBlocks(fs.readFileSync(file, 'utf8')).forEach((b, i) => {
      blocks++;
      if (/@import\b/i.test(b.css)) hits.push(`${path.relative(PUBLIC, file)} (<style> #${i + 1})`);
    });
  }
  assert.ok(blocks >= PAGES.length / 2, 'the scan found almost no <style> blocks, so it proves nothing: ' + blocks);
  assert.deepStrictEqual(hits, [], 'load it with <link rel="stylesheet"> instead: ' + hits.join(', '));
});

test('the scan reads tags, not prose: a comment or a script that names <style> is not one', () => {
  const page = '<!-- the <style> below must not @import --><script>const s = "<style>@import url(x.css);</style>";</script>'
    + '<style>/* @import is named here */ .a{color:red}</style><STYLE media="screen">@import url("b.css");</STYLE>';
  const found = styleBlocks(page);
  assert.strictEqual(found.length, 2, 'the comment or the script was read as a style block');
  assert.doesNotMatch(found[0].css, /@import/, 'a CSS comment counted as an import');
  assert.match(found[1].css, /@import/, 'a real import went unseen');
});

test('the trader and the journal load trader.css once: after site.css, ahead of their own rules', () => {
  for (const name of ['stock-trader.html', 'journal.html']) {
    const html = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
    const site = html.indexOf('<link rel="stylesheet" href="/css/site.css">');
    const trader = html.indexOf('<link rel="stylesheet" href="/css/trader.css">');
    const own = styleBlocks(html)[0];
    assert.ok(site !== -1, name + ': site.css link missing');
    assert.ok(trader !== -1, name + ': trader.css link missing');
    assert.ok(own, name + ': the page lost its own <style> block');
    assert.ok(site < trader && trader < own.at, name + ': trader.css belongs between site.css and the page\'s own <style>');
    assert.strictEqual(html.split('/css/trader.css"').length - 1, 1, name + ': trader.css is loaded more than once');
  }
  assert.ok(fs.existsSync(path.join(PUBLIC, 'css', 'trader.css')), 'css/trader.css is gone but two pages still link it');
});
