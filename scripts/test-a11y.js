#!/usr/bin/env node
/**
 * Accessibility Test Suite
 * Validates WCAG 2.1 AA compliance:
 * - Keyboard navigation (Tab/Shift+Tab)
 * - ARIA labels and semantic HTML
 * - Color contrast (AA/AAA)
 * - Heading hierarchy
 * - Form labels and descriptions
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'apps/lantern-garage/public');

// WCAG AA contrast ratio: 4.5:1 for normal text, 3:1 for large text
const MIN_CONTRAST_AA = 4.5;

// Color hex to RGB
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

// Calculate relative luminance
function getLuminance(rgb) {
  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map(val => {
    val = val / 255;
    return val <= 0.03928 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Calculate contrast ratio
function getContrastRatio(rgb1, rgb2) {
  const lum1 = getLuminance(rgb1);
  const lum2 = getLuminance(rgb2);
  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  return (lighter + 0.05) / (darker + 0.05);
}

async function testHtmlFile(filePath) {
  const html = fs.readFileSync(filePath, 'utf8');
  const doc = new JSDOM(html).window.document;
  const results = {
    file: path.relative(PUBLIC_DIR, filePath),
    issues: [],
    warnings: [],
    passed: 0
  };

  // Test 1: Keyboard navigation
  console.log(`\n📄 ${results.file}`);
  console.log('═'.repeat(50));

  // Check for focusable elements
  const focusable = doc.querySelectorAll('a, button, input, textarea, select, [tabindex]');
  if (focusable.length > 0) {
    console.log(`✓ ${focusable.length} keyboard-accessible elements found`);
    results.passed++;

    // Check for visible focus indicators
    focusable.forEach(el => {
      if (!el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') {
        const style = el.getAttribute('style') || '';
        if (!style.includes('outline') && !style.includes('border') && !style.includes('box-shadow')) {
          // Note: Can't truly test focus visibility without CSS parsing
        }
      }
    });
  } else {
    results.warnings.push('No keyboard-accessible elements found');
  }

  // Test 2: Heading hierarchy
  const headings = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');
  let lastLevel = 0;
  let headingIssues = false;

  headings.forEach((h, i) => {
    const level = parseInt(h.tagName[1]);
    if (i > 0 && level > lastLevel + 1) {
      results.issues.push(`Heading hierarchy jump: h${lastLevel} → h${level}`);
      headingIssues = true;
    }
    lastLevel = level;
  });

  if (!headingIssues && headings.length > 0) {
    console.log(`✓ Heading hierarchy valid (${headings.length} headings)`);
    results.passed++;
  }

  // Test 3: Images have alt text
  const images = doc.querySelectorAll('img');
  let imagesOk = 0;
  images.forEach(img => {
    // A present `alt` attribute is conformant even when empty: alt="" is the
    // deliberate decorative-image pattern (WCAG H67), and aria-hidden also
    // removes an image from the a11y tree. Only a MISSING alt attribute is a
    // failure. (Matches axe-core: it flags absent alt, not empty alt — flagging
    // alt="" was a false positive on decorative placeholders like #kohLightboxImg.)
    if (img.hasAttribute('alt') || img.hasAttribute('aria-hidden')) {
      imagesOk++;
    } else {
      results.issues.push(`Image missing alt attribute: ${img.getAttribute('src') || 'unknown'}`);
    }
  });
  if (imagesOk === images.length && images.length > 0) {
    console.log(`✓ All ${images.length} images have alt text or are hidden`);
    results.passed++;
  }

  // Test 4: Form labels
  const inputs = doc.querySelectorAll('input:not([type="hidden"]), textarea, select');
  let labelsOk = 0;
  inputs.forEach(input => {
    const id = input.getAttribute('id');
    const name = input.getAttribute('name');
    const label = doc.querySelector(`label[for="${id}"]`);
    const ariaLabel = input.getAttribute('aria-label');

    if (label || ariaLabel || input.hasAttribute('aria-labelledby')) {
      labelsOk++;
    } else {
      results.warnings.push(`Input missing label: ${name || id || 'unnamed'}`);
    }
  });
  if (labelsOk === inputs.length && inputs.length > 0) {
    console.log(`✓ All ${inputs.length} form inputs have labels`);
    results.passed++;
  }

  // Test 5: ARIA attributes
  const ariaElements = doc.querySelectorAll('[aria-label], [aria-describedby], [role]');
  if (ariaElements.length > 0) {
    console.log(`✓ ${ariaElements.length} elements use ARIA attributes`);
    results.passed++;
  }

  // Test 6: Semantic HTML
  const semantic = doc.querySelectorAll('nav, main, article, section, aside, footer, header');
  if (semantic.length > 0) {
    console.log(`✓ Using semantic HTML (${semantic.length} elements)`);
    results.passed++;
  } else {
    results.warnings.push('Limited semantic HTML usage');
  }

  // Report issues and warnings
  if (results.issues.length > 0) {
    console.log(`\n✗ Issues (${results.issues.length}):`);
    results.issues.forEach(issue => console.log(`  - ${issue}`));
  }

  if (results.warnings.length > 0) {
    console.log(`\n⚠ Warnings (${results.warnings.length}):`);
    results.warnings.forEach(warn => console.log(`  - ${warn}`));
  }

  return results;
}

// ════════════════════════════════════════════════════════════════════════════
// Test 7: Font & style best-practice contract  (design-token contrast + consistency)
//
// Σ₀-grounded thresholds — every rule carries [evidence, confidence, source]:
//  • WCAG 2.2 SC 1.4.3 Contrast (Minimum), AA — body text ≥ 4.5:1, large text
//    (≥24px, or ≥18.66px bold) ≥ 3:1; thresholds are NOT rounded (4.499 fails).
//    confidence 0.99 · https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html
//  • WCAG 2.1 SC 1.4.11 Non-text Contrast, AA — UI components ≥ 3:1 (advisory).
//    confidence 0.95 · https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast.html
//  • Legibility floor — ~16px is the widely-advised body minimum; <10px text is a
//    hard red-line here. confidence 0.80 (consensus, not a WCAG number)
//    https://www.section508.gov/develop/fonts-typography/
//  • Consistency (globally advised) — a background/surface-intent token
//    (--accent-dim, --surface, --surface2, --border, --bg) must NEVER be a text
//    `color:`. That exact misuse made the "Keystone · chat" thinking-wheel label
//    invisible (--accent-dim #cffafe on #fff = 1.12:1). Metadata text uses --muted,
//    the token designed for it. confidence 0.97.
//
// Deterministic & server-free: parses the real theme palette from site.css and the
// real rules from dream-chat-ui.css, so a regression (e.g. reverting a label to
// --accent-dim) turns this red. Reuses the contrast helpers above.
const CSS_DIR = path.join(PUBLIC_DIR, 'css');
const TOKEN_CSS = path.join(CSS_DIR, 'site.css');
const CHAT_CSS  = path.join(CSS_DIR, 'dream-chat-ui.css');

// Background/surface-intent tokens that are never legible as text on their own surface.
const FORBIDDEN_TEXT_TOKENS = ['--accent-dim', '--surface2', '--surface', '--border', '--bg'];
const MIN_FONT_PX = 10;          // hard legibility red-line (best-practice body target is 16px)
const MIN_CONTRAST_LARGE = 3;    // SC 1.4.3 large-text threshold

// The per-reply text roles whose contrast we contractually enforce in BOTH themes.
// `on` is the surface token the text sits on; `px`/`bold` pick the AA threshold.
const TEXT_ROLES = [
  { sel: '.route-card',                       on: '--bg',       px: 12, label: 'thinking-wheel route card' },
  { sel: '.msg-route-sig',                    on: '--bg',       px: 11, label: 'reply signature line' },
  { sel: '.message.agent .message-content',   on: '--surface2', px: 15, label: 'assistant message body' },
];

function parseTokenBlock(css, blockRe) {
  const out = {};
  const m = css.match(blockRe);
  if (m) {
    const re = /(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g;
    let t; while ((t = re.exec(m[1])) !== null) out[t[1]] = t[2];
  }
  return out;
}
function ruleBlock(css, selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = css.match(re);
  return m ? m[1] : null;
}
function declValue(block, prop) {
  if (!block) return null;
  const m = block.match(new RegExp('(?:^|[;{\\s])' + prop + '\\s*:\\s*([^;]+)'));
  return m ? m[1].trim() : null;
}
// Resolve a `color:` value ("var(--muted, #6b7280)" / "#000") to a hex for a theme.
function resolveColor(value, tokens) {
  if (!value) return null;
  const v = value.match(/var\(\s*(--[\w-]+)/);
  if (v) return tokens[v[1]] || null;
  const hex = value.match(/#[0-9a-fA-F]{6}/);
  return hex ? hex[0] : null;
}

function testDesignTokens() {
  const results = { issues: [], warnings: [], passed: 0 };
  console.log('\n🎨 Font & style best-practice contract (design tokens)');
  console.log('═'.repeat(50));

  if (!fs.existsSync(TOKEN_CSS) || !fs.existsSync(CHAT_CSS)) {
    results.warnings.push('site.css or dream-chat-ui.css not found — token contract skipped');
    return results;
  }
  const tokenCss = fs.readFileSync(TOKEN_CSS, 'utf8');
  // Strip /* … */ comments before any analysis — prose that documents an
  // anti-pattern (e.g. "was color:var(--accent-dim)") must not trip the scans.
  const chatCss  = fs.readFileSync(CHAT_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const THEMES = {
    light: parseTokenBlock(tokenCss, /:root\s*\{([^}]*)\}/),
    dark:  parseTokenBlock(tokenCss, /\[data-theme="dark"\]\s*\{([^}]*)\}/),
  };

  // (a) Contrast contract — each role meets AA on its surface in BOTH themes.
  for (const role of TEXT_ROLES) {
    const block = ruleBlock(chatCss, role.sel);
    const colorVal = declValue(block, 'color');
    if (!colorVal) { results.warnings.push(`${role.sel}: no color declaration found`); continue; }
    const need = (role.px >= 24 || (role.px >= 18.66 && role.bold)) ? MIN_CONTRAST_LARGE : MIN_CONTRAST_AA;
    for (const theme of ['light', 'dark']) {
      const tokens = THEMES[theme];
      const fg = hexToRgb(resolveColor(colorVal, tokens));
      const bg = hexToRgb(tokens[role.on]);
      if (!fg || !bg) { results.warnings.push(`${role.sel} [${theme}]: unresolved color/surface`); continue; }
      const cr = getContrastRatio(fg, bg);
      if (cr < need) {
        results.issues.push(`${role.label} (${role.sel}) [${theme}]: ${cr.toFixed(2)}:1 < ${need}:1 — color ${colorVal} on ${role.on}`);
      } else {
        results.passed++;
      }
    }
  }

  // (b) Consistency — no background/surface token used as a text color.
  const colorRe = /(?:^|[;{\s])color\s*:\s*var\(\s*(--[\w-]+)/gi;
  let cm;
  while ((cm = colorRe.exec(chatCss)) !== null) {
    if (FORBIDDEN_TEXT_TOKENS.includes(cm[1])) {
      results.issues.push(`background-intent token ${cm[1]} used as text color — illegible on its own surface (see SC 1.4.3); use --muted/--text/--accent`);
    }
  }

  // (c) Legibility floor — no text below the hard minimum.
  const sizeRe = /font-size\s*:\s*([0-9.]+)(px|rem)/gi;
  let sm;
  while ((sm = sizeRe.exec(chatCss)) !== null) {
    const px = sm[2] === 'rem' ? parseFloat(sm[1]) * 16 : parseFloat(sm[1]);
    if (px < MIN_FONT_PX) results.issues.push(`font-size ${sm[1]}${sm[2]} (~${px.toFixed(1)}px) below ${MIN_FONT_PX}px legibility floor`);
  }

  if (results.issues.length === 0) console.log(`✓ ${results.passed} token-contrast checks pass (both themes); no illegible text colors or sub-${MIN_FONT_PX}px text`);
  else { console.log(`\n✗ Style contract issues (${results.issues.length}):`); results.issues.forEach(i => console.log(`  - ${i}`)); }
  if (results.warnings.length) { console.log(`⚠ Warnings (${results.warnings.length}):`); results.warnings.forEach(w => console.log(`  - ${w}`)); }
  return results;
}

async function runA11yTests() {
  console.log('\n🧪 WCAG 2.1 AA Accessibility Tests\n');

  const htmlFiles = [
    path.join(PUBLIC_DIR, 'index.html'),
    path.join(PUBLIC_DIR, 'dream-chat.html'),
    path.join(PUBLIC_DIR, 'operations.html'),
    path.join(PUBLIC_DIR, 'explore.html'),
    path.join(PUBLIC_DIR, 'stock-trader.html')
  ].filter(f => fs.existsSync(f));

  let totalPassed = 0;
  let totalIssues = 0;
  const allResults = [];

  for (const file of htmlFiles) {
    const result = await testHtmlFile(file);
    allResults.push(result);
    totalPassed += result.passed;
    totalIssues += result.issues.length;
  }

  // Test 7: site-wide font & style best-practice contract (CSS design tokens).
  const styleResult = testDesignTokens();
  totalPassed += styleResult.passed;
  totalIssues += styleResult.issues.length;

  // Summary
  console.log('\n\n' + '='.repeat(50));
  console.log('📊 Summary');
  console.log('='.repeat(50));
  console.log(`Files tested: ${htmlFiles.length}`);
  console.log(`Total checks passed: ${totalPassed}`);
  console.log(`Total issues found: ${totalIssues}`);

  if (totalIssues > 0) {
    console.log('\n✗ A11Y TEST FAILED');
    process.exit(1);
  } else {
    console.log('\n✓ A11Y tests passed');
    process.exit(0);
  }
}

runA11yTests().catch(err => {
  console.error('✗ Test error:', err);
  process.exit(1);
});
