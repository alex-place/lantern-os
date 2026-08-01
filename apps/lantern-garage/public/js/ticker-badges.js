/**
 * ticker-badges.js — TradingView-quality instrument badges, zero fetches.
 *
 * The problem (operator, 2026-07-28): fetched issuer logos render as samey,
 * blurry squares-in-circles — every SPDR fund is the same State Street mark,
 * every Direxion fund the same X, and the rasters look bad at 24px. TradingView
 * solves it with DESIGNED glyphs: a stylized issuer mark or asset-class shape,
 * white on a brand-colored circle, vector-crisp.
 *
 * This module does the same with inline SVG:
 *   1. ISSUER glyphs — hand-drawn 24×24 marks for the fund families in our
 *      universe (Direxion X, ProShares arrow, SPDR S, Invesco peak, iShares i,
 *      VanEck V, Select-Sector shield), keyed by a static ticker→issuer map.
 *   2. ASSET-CLASS glyphs — crypto currency signs (₿ Ξ ◎ Ð ✕), an index
 *      squiggle for ^symbols, a candle glyph for unknown ETFs.
 *   3. Fallback — the deterministic gradient MONOGRAM (hue hashed from the
 *      symbol, stable everywhere) for single stocks and anything unmapped.
 *
 * API (global, no module system on these pages):
 *   tickerBadgeHtml(symbol, { size, cls }) → html string (span.tb-badge)
 *   tickerBadgeHue(symbol)                → 0..359 stable hue
 * Pages style .tb-badge via their own CSS (size/border); the badge carries its
 * background + glyph inline so it renders identically on every surface.
 */
(function () {
  'use strict';

  // ── deterministic hue (shared with the pre-existing monogram badges) ──────
  function tickerBadgeHue(t) {
    let h = 0; const s = String(t || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  // ── issuer glyphs (24×24 viewBox, single-color paths drawn for legibility) ─
  // Each: { bg: css background, svg: inner SVG markup (stroke/fill #fff) }.
  // ── tracked-asset badges (TradingView-style, operator 2026-07-28 v3) ──────
  // Funds are badged by WHAT THEY TRACK, not who issues them: the S&P family is
  // a red "500", the Nasdaq-100 family a blue "100", the Dow "30", the Russell
  // family "2000", gold a droplet, long bonds "20+", semiconductors a chip
  // glyph. Numbers and symbols — no letter salad — and the family repeats only
  // as much as the underlying does. Single stocks keep their REAL logos (the
  // page falls back to the fetched brand image when this returns null).
  // MEASURED centering (operator: three rounds of "not centered" — no more
  // eyeballing). Each unique label is rendered once into a hidden probe SVG,
  // its real bounding box is read, and the y offset that puts the box center
  // EXACTLY on 12 is cached and baked into every subsequent render. Sub-pixel
  // correct regardless of font metrics, baseline quirks, or browser.
  const FONT = 'Segoe UI, system-ui, sans-serif';
  let _probe = null;
  const _dyCache = Object.create(null);
  function _measuredDy(ch, size) {
    const key = ch + '|' + size;
    if (key in _dyCache) return _dyCache[key];
    if (typeof document === 'undefined') return { dx: 0, dy: 0 };   // SSR/tests: neutral
    try {
      if (!_probe) {
        _probe = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        _probe.setAttribute('viewBox', '0 0 24 24');
        _probe.style.cssText = 'position:absolute;width:24px;height:24px;left:-9999px;top:-9999px';
        document.body.appendChild(_probe);
      }
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', '12'); t.setAttribute('y', '12');
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('font-family', FONT);
      t.setAttribute('font-size', String(size));
      t.setAttribute('font-weight', '800');
      t.textContent = ch;
      _probe.appendChild(t);
      const bb = t.getBBox();
      _probe.removeChild(t);
      const off = { dx: 12 - (bb.x + bb.width / 2), dy: 12 - (bb.y + bb.height / 2) };
      // Only CACHE once the face is actually loaded — measuring during font
      // fallback poisoned the cache (identical '100' badges rendered 0.6 units
      // apart depending on when they were first measured).
      const ready = !document.fonts || document.fonts.check('800 ' + size + 'px "Segoe UI"');
      if (ready) _dyCache[key] = off;
      return off;
    } catch (_e) { return (_dyCache[key] = { dx: 0, dy: 0 }); }
  }
  function centerText(ch, size, fill) {
    const off = _measuredDy(ch, size);
    return '<text x="' + (12 + off.dx).toFixed(2) + '" y="' + (12 + off.dy).toFixed(2) + '" text-anchor="middle" ' +
      'font-family="' + FONT + '" font-size="' + size + '" ' +
      'font-weight="800" fill="' + (fill || '#fff') + '">' + ch + '</text>';
  }
  const CHIP_SVG = '<rect x="8" y="8" width="8" height="8" rx="1.4" stroke="#fff" stroke-width="1.7" fill="none"/>' +
    '<path d="M10.5 8 V5.6 M13.5 8 V5.6 M10.5 18.4 V16 M13.5 18.4 V16 M8 10.5 H5.6 M8 13.5 H5.6 M18.4 10.5 H16 M18.4 13.5 H16" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>';
  const DROP_SVG = '<path d="M12 5.4 C12 5.4 7 10.8 7 14 C7 16.8 9.2 18.6 12 18.6 C14.8 18.6 17 16.8 17 14 C17 10.8 12 5.4 12 5.4 Z" fill="#fff"/>';
  const GEAR_SVG = '<circle cx="12" cy="12" r="2.4" stroke="#fff" stroke-width="1.7" fill="none"/>' +
    '<path d="M12 6.2 V4.6 M12 19.4 V17.8 M17.8 12 H19.4 M4.6 12 H6.2 M16.2 7.8 L17.3 6.7 M6.7 17.3 L7.8 16.2 M16.2 16.2 L17.3 17.3 M6.7 6.7 L7.8 7.8" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>';
  const TRACKS = {
    // S&P 500 family — TV red "500"
    SPY:  { bg: '#cc2f2f', txt: '500', size: 10 }, SPXL: { bg: '#cc2f2f', txt: '500', size: 10 },
    SPXS: { bg: '#cc2f2f', txt: '500', size: 10 }, UPRO: { bg: '#cc2f2f', txt: '500', size: 10 },
    SSO:  { bg: '#cc2f2f', txt: '500', size: 10 }, SDS:  { bg: '#cc2f2f', txt: '500', size: 10 },
    SH:   { bg: '#cc2f2f', txt: '500', size: 10 }, SPXU: { bg: '#cc2f2f', txt: '500', size: 10 },
    SPMO: { bg: '#cc2f2f', txt: '500', size: 10 }, RSP:  { bg: '#cc2f2f', txt: '500', size: 10 },
    // Nasdaq-100 family — blue "100"
    QQQ:  { bg: '#2962ff', txt: '100', size: 10 }, TQQQ: { bg: '#2962ff', txt: '100', size: 10 },
    SQQQ: { bg: '#2962ff', txt: '100', size: 10 }, QLD:  { bg: '#2962ff', txt: '100', size: 10 },
    QQQM: { bg: '#2962ff', txt: '100', size: 10 },
    // Dow 30 — deep blue "30"
    DIA:  { bg: '#1848c2', txt: '30', size: 12 },
    // Russell 2000 family — teal "2000"
    IWM:  { bg: '#0e8074', txt: '2000', size: 8 }, TNA: { bg: '#0e8074', txt: '2000', size: 8 },
    TZA:  { bg: '#0e8074', txt: '2000', size: 8 }, UWM: { bg: '#0e8074', txt: '2000', size: 8 },
    // MidCap 400 momentum — "400"
    XMMO: { bg: '#8a6d1d', txt: '400', size: 10 }, MDY: { bg: '#8a6d1d', txt: '400', size: 10 },
    // Gold — amber droplet
    GLD:  { bg: 'linear-gradient(135deg,#d99a1b,#8a5c00)', svg: DROP_SVG },
    // 20+ year treasuries
    TLT:  { bg: '#5560d8', txt: '20Y', size: 9.5 },
    // Semiconductors — chip glyph
    SMH:  { bg: '#7a3fd1', svg: CHIP_SVG }, SOXL: { bg: '#7a3fd1', svg: CHIP_SVG }, SOXS: { bg: '#7a3fd1', svg: CHIP_SVG },
    // Tech sector — gear
    XLK:  { bg: '#3d6fb4', svg: GEAR_SVG },
    // Intl developed — globe-ish ring
    EFA:  { bg: '#2b7c4f', txt: 'EAFE', size: 7.5 },
  };
  // Crypto: REAL coin logos where they exist (operator 2026-07-30 — "if it has a
  // logo it should have it"), currency glyph as the fallback. Each CDN path was
  // verified 200/image-png before being relied on; a failed fetch degrades to the
  // glyph via onerror, so a dead CDN never leaves an empty circle.
  const CRYPTO_LOGO = {
    BTC: 'https://assets.coingecko.com/coins/images/1/large/bitcoin.png',
    ETH: 'https://assets.coingecko.com/coins/images/279/large/ethereum.png',
    SOL: 'https://assets.coingecko.com/coins/images/4128/large/solana.png',
    DOGE: 'https://assets.coingecko.com/coins/images/5/large/dogecoin.png',
    XRP: 'https://assets.coingecko.com/coins/images/44/large/xrp-symbol-white-128.png',
    LTC: 'https://assets.coingecko.com/coins/images/2/large/litecoin.png',
  };
  // Crypto currency glyphs — the recognized signs, not letters.
  const CRYPTO = {
    BTC: { ch: '₿', bg: 'linear-gradient(135deg,#f7931a,#b05f00)' },
    ETH: { ch: 'Ξ', bg: 'linear-gradient(135deg,#627eea,#2f4bd0)' },
    SOL: { ch: '◎', bg: 'linear-gradient(135deg,#9945ff,#14f195)' },
    DOGE: { ch: 'Ð', bg: 'linear-gradient(135deg,#c2a633,#8a7420)' },
    XRP: { ch: '✕', bg: 'linear-gradient(135deg,#23292f,#4b5563)' },
    LTC: { ch: 'Ł', bg: 'linear-gradient(135deg,#345d9d,#1e3a68)' },
  };

  function svgBadge(bg, inner, cls) {
    return '<span class="tb-badge ' + (cls || '') + '" style="background:' + bg + '">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true">' + inner + '</svg></span>';
  }
  function textBadge(bg, text, cls, small) {
    // SVG text, not flex+font: dominant-baseline=central centers EXACTLY at any
    // size, where font line-height/descenders made flex-centered glyphs sit
    // visibly high (the "not centered" report).
    const size = small ? 8 : (String(text).length >= 3 ? 9.5 : 13);
    return '<span class="tb-badge ' + (cls || '') + '" style="background:' + bg + '">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<text x="12" y="12.5" text-anchor="middle" dominant-baseline="central" ' +
      'font-family="Segoe UI, system-ui, sans-serif" font-size="' + size + '" font-weight="800" fill="#fff">' +
      text + '</text></svg></span>';
  }

  /**
   * The badge for a symbol. Returns HTML, or NULL for plain single stocks —
   * the caller should show the real brand logo there (with
   * tickerBadgeHtml(sym, {force:true}) as its onerror fallback monogram).
   */
  function tickerBadgeHtml(symbol, meta) {
    const t = String(symbol || '').toUpperCase();
    const m = meta || {};
    const base = t.replace(/USD$/, '');
    // 1. crypto → REAL coin logo, falling back to its currency glyph
    if (CRYPTO[base] && (m.assetClass === 'crypto' || /USD$/.test(t))) {
      const c = CRYPTO[base];
      const glyph = '<span class="tb-badge tb-glyph" style="background:' + c.bg + '">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true">' + centerText(c.ch, 15) + '</svg></span>';
      const src = CRYPTO_LOGO[base];
      if (!src || m.noImage) return glyph;
      const fb = glyph.replace(/"/g, '&quot;');
      return '<img class="tb-badge tb-img" src="' + src + '" alt="" loading="lazy" ' +
        'onerror="this.outerHTML=&quot;' + fb.replace(/&quot;/g, '&amp;quot;') + '&quot;">';
    }
    // 2. tracked index / commodity / sector fund → number or symbol badge
    const tr = TRACKS[t];
    if (tr) {
      const inner = tr.svg || centerText(tr.txt, tr.size || 10);
      return '<span class="tb-badge" style="background:' + tr.bg + '">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true">' + inner + '</svg></span>';
    }
    // 3. index symbols (^GSPC-style) → squiggle
    if (t.startsWith('^') || m.assetClass === 'index') {
      return '<span class="tb-badge" style="background:linear-gradient(135deg,#3b4252,#20242c)">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 15 L9 10 L12.5 13 L20 6" stroke="#4a9eff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
    }
    // 4. single stock → NULL (caller shows the real logo) unless forced
    if (!m.force) return null;
    const h = tickerBadgeHue(t);
    return '<span class="tb-badge" style="background:linear-gradient(135deg,hsl(' + h + ',62%,46%),hsl(' +
      ((h + 42) % 360) + ',68%,30%))"><svg viewBox="0 0 24 24" aria-hidden="true">' +
      centerText(base.slice(0, 4), base.length >= 4 ? 9 : 11.5) + '</svg></span>';
  }

  /**
   * ALWAYS returns renderable HTML — never null. Designed badge where we have
   * one; otherwise the symbol's REAL brand logo (single stocks: Apple, Tesla,
   * NVIDIA…) with the monogram as its onerror fallback.
   *
   * Call sites used to interpolate tickerBadgeHtml()'s null straight into a
   * template, printing the literal string "null" next to every single stock in
   * the search popup. Prefer this helper anywhere a badge must render.
   */
  function tickerBadgeOrLogoHtml(symbol, meta) {
    const badge = tickerBadgeHtml(symbol, meta);
    if (badge) return badge;
    const t = String(symbol || '').toUpperCase();
    const fb = String(tickerBadgeHtml(t, Object.assign({}, meta, { force: true })) || '').replace(/"/g, '&quot;');
    return '<img class="tb-badge tb-img" src="/api/trading/logo?symbol=' + encodeURIComponent(t) +
      '" alt="" loading="lazy" onerror="this.outerHTML=&quot;' + fb.replace(/&quot;/g, '&amp;quot;') + '&quot;">';
  }

  window.tickerBadgeOrLogoHtml = tickerBadgeOrLogoHtml;
  window.tickerBadgeHue = tickerBadgeHue;
  window.tickerBadgeHtml = tickerBadgeHtml;
})();
