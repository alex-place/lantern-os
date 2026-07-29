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
  const GLYPHS = {
    // Direxion — the slanted bold X with a speed cut. Brand black + gold accent.
    direxion: {
      bg: 'linear-gradient(135deg,#1c1e22,#3a3d44)',
      svg: '<path d="M6 6 L18 18 M18 6 L6 18" stroke="#f2b100" stroke-width="3.2" stroke-linecap="round"/>',
    },
    // ProShares — upward arrow-head trio (bull/bear family mark simplified).
    proshares: {
      bg: 'linear-gradient(135deg,#0d4f8b,#062f54)',
      svg: '<path d="M12 5 L19 19 L12 15 L5 19 Z" fill="#fff"/>',
    },
    // SPDR / State Street — the S in a web arc.
    spdr: {
      bg: 'linear-gradient(135deg,#00694e,#003d2d)',
      svg: '<path d="M16.5 8.2c-.8-1.4-2.4-2.2-4.3-2.2-2.6 0-4.4 1.4-4.4 3.4 0 4.4 9 2.3 9 6.4 0 2-1.9 3.4-4.6 3.4-2.1 0-3.8-.9-4.6-2.4" stroke="#fff" stroke-width="2.1" fill="none" stroke-linecap="round"/>',
    },
    // Invesco — the mountain/peak mark.
    invesco: {
      bg: 'linear-gradient(135deg,#0b2f5e,#071c39)',
      svg: '<path d="M4 17 L10 8 L14 13 L17 9.5 L20 17 Z" fill="#fff"/>',
    },
    // iShares (BlackRock) — the lowercase i with a bold dot.
    ishares: {
      bg: 'linear-gradient(135deg,#111,#333)',
      svg: '<circle cx="12" cy="6.6" r="2.2" fill="#ffce00"/><rect x="10.2" y="10.2" width="3.6" height="8" rx="1.5" fill="#fff"/>',
    },
    // VanEck — angular double-V.
    vaneck: {
      bg: 'linear-gradient(135deg,#0057b8,#00317a)',
      svg: '<path d="M5 7 L9.5 17 L12 11.5 L14.5 17 L19 7" stroke="#fff" stroke-width="2.4" fill="none" stroke-linejoin="round" stroke-linecap="round"/>',
    },
    // Select Sector SPDRs — shield with a sector slice.
    sector: {
      bg: 'linear-gradient(135deg,#155e46,#0a3a2a)',
      svg: '<path d="M12 4 L19 7 V13 C19 17 16 19.5 12 20.5 C8 19.5 5 17 5 13 V7 Z" stroke="#fff" stroke-width="1.8" fill="none"/><path d="M12 8 V13 H16.5" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
    },
  };

  // Ticker → issuer for the traded universe (static: these don't churn).
  const ISSUER = {
    SOXL: 'direxion', SOXS: 'direxion', SPXL: 'direxion', SPXS: 'direxion',
    TNA: 'direxion', TZA: 'direxion', LABU: 'direxion', LABD: 'direxion',
    TQQQ: 'proshares', SQQQ: 'proshares', SH: 'proshares', SDS: 'proshares',
    UPRO: 'proshares', QLD: 'proshares', SSO: 'proshares', SPXU: 'proshares',
    SPY: 'spdr', DIA: 'spdr', GLD: 'spdr', SPMO: 'spdr', XMMO: 'spdr', MDY: 'spdr',
    QQQ: 'invesco', QQQM: 'invesco', RSP: 'invesco',
    IWM: 'ishares', IVV: 'ishares', EFA: 'ishares', TLT: 'ishares', AGG: 'ishares',
    SMH: 'vaneck', GDX: 'vaneck',
    XLK: 'sector', XLE: 'sector', XLF: 'sector', XLV: 'sector', XLI: 'sector',
    XLP: 'sector', XLU: 'sector', XLY: 'sector', XLB: 'sector', XLRE: 'sector', XLC: 'sector',
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
    return '<span class="tb-badge ' + (cls || '') + '" style="background:' + bg +
      (small ? ';font-size:7px;letter-spacing:0' : '') + '">' + text + '</span>';
  }

  /**
   * The badge for a symbol. `meta.assetClass` ('crypto'|'index'|…) refines the
   * choice when the caller knows it; pure ticker heuristics otherwise.
   */
  function tickerBadgeHtml(symbol, meta) {
    const t = String(symbol || '').toUpperCase();
    const m = meta || {};
    // 1. crypto → currency glyph (SOLUSD / SOL both resolve)
    const base = t.replace(/USD$/, '');
    if (CRYPTO[base] && (m.assetClass === 'crypto' || /USD$/.test(t) || m.assetClass === undefined && CRYPTO[base] && t !== base)) {
      const c = CRYPTO[base];
      return textBadge(c.bg, c.ch, 'tb-glyph');
    }
    // 2. known issuer → designed mark
    const iss = ISSUER[t];
    if (iss && GLYPHS[iss]) return svgBadge(GLYPHS[iss].bg, GLYPHS[iss].svg, 'tb-' + iss);
    // 3. index (^GSPC-style) → squiggle
    if (t.startsWith('^') || m.assetClass === 'index') {
      return svgBadge('linear-gradient(135deg,#3b4252,#20242c)',
        '<path d="M4 15 L9 10 L12.5 13 L20 6" stroke="#4a9eff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>');
    }
    // 4. fallback — the deterministic gradient monogram (single stocks etc.)
    const h = tickerBadgeHue(t);
    const label = base.slice(0, 4);
    return textBadge(
      'linear-gradient(135deg,hsl(' + h + ',62%,46%),hsl(' + ((h + 42) % 360) + ',68%,30%))',
      label, '', label.length > 3);
  }

  window.tickerBadgeHue = tickerBadgeHue;
  window.tickerBadgeHtml = tickerBadgeHtml;
})();
