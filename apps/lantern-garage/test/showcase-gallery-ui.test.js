// Behavioral regression for the Explore showcase gallery (Kingdome of Hearts /
// Three Doors) in apps/lantern-garage/public/explore.html.
//
// Loads the real page in jsdom, stubs the manifest fetch, runs the inline gallery
// script, and asserts the rendered DOM + lightbox. Covers the bugs we actually hit:
//   1. Manifest-driven sections — door/hero/world render from `cat`; review items
//      go to the collapsed <details> with no caption.
//   2. base + key composition — img src = manifest.base + item.thumb (so flipping
//      base to the R2 URL re-points every image with one field).
//   3. NO loading="lazy" on showcase images — lazy never fired in the preview and
//      rendered black/alt-text tiles. Lock it out.
//   4. Shared lightbox — clicking any .showcase-tile[data-full] opens it; Esc closes.
//
// Run: node apps/lantern-garage/test/showcase-gallery-ui.test.js
// (jsdom is a root devDependency; self-skips if absent.)
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const out = (s) => process.stdout.write(s + "\n");
const err = (s) => process.stderr.write(s + "\n");

let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch (e) { out("SKIP showcase-gallery-ui: jsdom not installed — " + e.message); process.exit(0); }

const HTML = fs.readFileSync(path.resolve(__dirname, "../public/explore.html"), "utf8");

const MANIFEST = (base) => ({
  title: "Kingdome of Hearts — Three Doors",
  base,
  count: 4,
  items: [
    { id: "d1", title: "The Green Door", cat: "door", status: "auto", tags: ["door"], src: "uuid-a.png", full: "d1.webp", thumb: "d1-t.webp" },
    { id: "h1", title: "The Fool & Fein", cat: "hero", status: "auto", tags: ["hero"], src: "uuid-b.png", full: "h1.webp", thumb: "h1-t.webp" },
    { id: "w1", title: "City of Doors", cat: "world", status: "auto", tags: ["world"], src: "uuid-c.png", full: "w1.webp", thumb: "w1-t.webp" },
    { id: "r1", title: null, cat: null, status: "review", tags: [], src: "0310c882-uuid.png", full: "r1.webp", thumb: "r1-t.webp" },
  ],
});

function fetchStub(base) {
  return (url) => {
    const u = String(url);
    if (u.includes("/assets/content/koh/manifest.json"))
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MANIFEST(base)) });
    if (u.includes("/api/health"))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    // feed page + interaction beacons → succeed empty
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ cards: [], cycled: false }) });
  };
}

let failures = 0;
const check = (name, fn) => {
  try { fn(); out("  ok  - " + name); }
  catch (e) { failures++; err("  FAIL- " + name + "\n       " + (e && e.message)); }
};

async function buildDom(base) {
  const dom = new JSDOM(HTML, {
    runScripts: "dangerously", pretendToBeVisual: true,
    url: "https://lantern-os.net/explore.html",
    beforeParse(win) { win.fetch = fetchStub(base); },
  });
  await new Promise((r) => setTimeout(r, 200)); // let async gallery render settle
  return dom;
}

async function run() {
  // ── default (local) base ──
  const dom = await buildDom("/assets/content/koh/");
  const doc = dom.window.document;

  check("door/hero/world sections each render their auto items", () => {
    assert.strictEqual(doc.querySelectorAll("#kohDoors .showcase-tile").length, 1);
    assert.strictEqual(doc.querySelectorAll("#kohHeroes .showcase-tile").length, 1);
    assert.strictEqual(doc.querySelectorAll("#kohWorld .showcase-tile").length, 1);
  });
  check("section headers unhide when populated; loading text hidden", () => {
    assert.strictEqual(doc.getElementById("kohDoorsHead").hidden, false);
    assert.strictEqual(doc.getElementById("kohHeroesHead").hidden, false);
    assert.strictEqual(doc.getElementById("kohWorldHead").hidden, false);
    assert.strictEqual(doc.getElementById("kohEmpty").hidden, true);
  });
  check("img src = base + thumb key (composition)", () => {
    const img = doc.querySelector("#kohDoors .showcase-tile img");
    assert.strictEqual(img.getAttribute("src"), "/assets/content/koh/d1-t.webp");
    const btn = doc.querySelector("#kohDoors .showcase-tile");
    assert.strictEqual(btn.getAttribute("data-full"), "/assets/content/koh/d1.webp");
    assert.strictEqual(btn.getAttribute("data-cap"), "The Green Door");
  });
  check("REGRESSION: no loading=lazy on any showcase image", () => {
    assert.strictEqual(doc.querySelectorAll(".koh-gallery img[loading='lazy']").length, 0);
    assert.strictEqual(doc.querySelectorAll(".sprite-gallery img[loading='lazy']").length, 0);
  });
  check("review item → collapsed section, untitled, caption falls back to filename", () => {
    const wrap = doc.getElementById("kohReviewWrap");
    assert.strictEqual(wrap.hidden, false);
    assert.strictEqual(doc.getElementById("kohReviewCount").textContent, "1");
    const tile = doc.querySelector("#kohReview .showcase-tile");
    assert.ok(tile.classList.contains("untitled"));
    assert.strictEqual(tile.querySelector(".showcase-cap"), null, "review tile has no caption label");
    assert.strictEqual(tile.getAttribute("data-cap"), "0310c882-uuid.png");
  });

  // ── lightbox behavior ──
  check("clicking a tile opens the shared lightbox with the full image", () => {
    const win = dom.window;
    const btn = doc.querySelector("#kohDoors .showcase-tile");
    btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const box = doc.getElementById("kohLightbox");
    assert.ok(box.classList.contains("open"), "lightbox should be open");
    assert.strictEqual(doc.getElementById("kohLightboxImg").getAttribute("src"), "/assets/content/koh/d1.webp");
    assert.strictEqual(doc.getElementById("kohLightboxCap").textContent, "The Green Door");
  });
  check("Escape closes the lightbox", () => {
    const win = dom.window;
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.strictEqual(doc.getElementById("kohLightbox").classList.contains("open"), false);
  });

  // ── R2 base re-points every image (one-field flip) ──
  const domR2 = await buildDom("https://media.lantern-os.net/koh/");
  check("REGRESSION: R2 base prefixes every image url", () => {
    const img = domR2.window.document.querySelector("#kohHeroes .showcase-tile img");
    assert.strictEqual(img.getAttribute("src"), "https://media.lantern-os.net/koh/h1-t.webp");
    const btn = domR2.window.document.querySelector("#kohHeroes .showcase-tile");
    assert.strictEqual(btn.getAttribute("data-full"), "https://media.lantern-os.net/koh/h1.webp");
  });

  // Close jsdom windows — their inline setInterval()s (status/feed polling) would
  // otherwise keep the event loop alive and hang the process after tests pass.
  try { dom.window.close(); domR2.window.close(); } catch (_) {}

  if (failures) { err(`\n${failures} FAILED`); process.exit(1); }
  out("\nshowcase-gallery-ui: all passed");
  process.exit(0);
}

run().catch((e) => { err("ERROR " + (e && e.stack || e)); process.exit(1); });
