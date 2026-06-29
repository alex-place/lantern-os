// Regression: static content-type contract (lib/http-utils.contentTypeForPath).
//
// The Explore showcases serve .webp images and .mp4 video. If those fall back to
// application/octet-stream, the browser refuses to decode <img>/<video> under
// X-Content-Type-Options: nosniff — exactly the "black tile / no poster" bug we
// hit. Lock the mapping so it can't silently regress.
//
// Run: node apps/lantern-garage/test/static-mime.test.js
const assert = require("assert");
const { contentTypeForPath, CONTENT_TYPES } = require("../lib/http-utils");

let failures = 0;
const check = (name, fn) => {
  try { fn(); process.stdout.write("  ok  - " + name + "\n"); }
  catch (e) { failures++; process.stderr.write("  FAIL- " + name + "\n      " + e.message + "\n"); }
};

check("webp → image/webp (gallery thumbnails + full)", () => {
  assert.strictEqual(contentTypeForPath("/assets/content/koh/abc123.webp"), "image/webp");
});
check("mp4 → video/mp4 (BFDM episodes)", () => {
  assert.strictEqual(contentTypeForPath("/assets/gage/bfdm/ep1.mp4"), "video/mp4");
});
check("gif → image/gif (animated sprites)", () => {
  assert.strictEqual(contentTypeForPath("eraser-rpg-ball.gif"), "image/gif");
});
check("extension match is case-insensitive", () => {
  assert.strictEqual(contentTypeForPath("BANNER.WEBP"), "image/webp");
  assert.strictEqual(contentTypeForPath("Clip.Mp4"), "video/mp4");
});
check("json/html/css still correct", () => {
  assert.strictEqual(contentTypeForPath("manifest.json"), "application/json; charset=utf-8");
  assert.ok(contentTypeForPath("x.html").startsWith("text/html"));
  assert.ok(contentTypeForPath("x.css").startsWith("text/css"));
});
check("unknown extension → octet-stream (safe default)", () => {
  assert.strictEqual(contentTypeForPath("x.bin"), "application/octet-stream");
  assert.strictEqual(contentTypeForPath("noext"), "application/octet-stream");
});
check("media types never resolve to octet-stream (the regression itself)", () => {
  for (const ext of [".webp", ".mp4", ".gif", ".png", ".jpg", ".mp3", ".webm"]) {
    assert.notStrictEqual(CONTENT_TYPES[ext], undefined, ext + " missing from map");
    assert.notStrictEqual(CONTENT_TYPES[ext], "application/octet-stream", ext + " must be a real type");
  }
});

if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
process.stdout.write("\nstatic-mime: all passed\n");
