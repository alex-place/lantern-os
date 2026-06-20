#!/usr/bin/env node
/**
 * screenshot.js — capture a page screenshot using the system browser
 * (Chrome, then Edge), with NO Playwright browser download required.
 * Falls back to Playwright's bundled Chromium only if a system browser
 * isn't found.
 *
 * Usage:
 *   node scripts/screenshot.js [url] [outPath]
 *   npm run screenshot -- http://127.0.0.1:4178/dream-chat.html shot.png
 *
 * Defaults: url=http://127.0.0.1:4178/dream-chat.html, outPath=preview.png
 */
const path = require("path");

const url = process.argv[2] || "http://127.0.0.1:4178/dream-chat.html";
const outPath = path.resolve(process.argv[3] || "preview.png");

(async () => {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    console.error("playwright not installed. Run: npm install (it is a devDependency).");
    process.exit(2);
  }

  // Prefer an already-installed system browser → no multi-hundred-MB download.
  const attempts = [
    { channel: "chrome" },
    { channel: "msedge" },
    {}, // bundled chromium (only if `npx playwright install` was run)
  ];
  let browser = null;
  for (const opts of attempts) {
    try {
      browser = await chromium.launch(opts);
      console.error(`[screenshot] using ${opts.channel || "bundled chromium"}`);
      break;
    } catch { /* try next */ }
  }
  if (!browser) {
    console.error("[screenshot] no usable browser. Install Chrome/Edge, or run `npx playwright install chromium`.");
    process.exit(3);
  }

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    // 'load' (not 'networkidle') — chat pages hold open SSE/poll connections.
    await page.goto(url, { waitUntil: "load", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.screenshot({ path: outPath });
    console.error(`[screenshot] saved ${outPath}`);
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error("[screenshot] error:", e.message);
  process.exit(1);
});
