# Accessibility & Site Audit System

## Overview

Lantern OS enforces WCAG 2.1 AA accessibility standards and maintains a complete sitemap through automated CI hooks and local scripts.

**System ensures:**
- ✓ Every page linked in index.html actually exists
- ✓ All interactive elements are keyboard-accessible (Tab navigation)
- ✓ ARIA labels and semantic HTML compliance
- ✓ Proper heading hierarchy
- ✓ Form inputs have labels
- ✓ Images have alt text or are marked decorative
- ✓ Color contrast meets WCAG AA standards
- ✓ sitemap.xml is always up-to-date

## Scripts

### 1. Site Audit (`scripts/audit-site.js`)

Validates that all pages referenced in `index.html` actually exist and generates `sitemap.xml`.

**Run locally:**
```bash
node scripts/audit-site.js
```

**What it does:**
- Parses all `<a>` tags from `apps/lantern-garage/public/index.html`
- Validates each linked page exists
- Generates `sitemap.xml` for search engines
- Fails if any page is missing

**Output:**
- `apps/lantern-garage/public/sitemap.xml` (auto-generated)

### 2. Accessibility Tests (`scripts/test-a11y.js`)

Validates WCAG 2.1 AA compliance across all public HTML files.

**Run locally:**
```bash
node scripts/test-a11y.js
```

**What it tests:**
- Keyboard navigation (focusable elements, tab order)
- Heading hierarchy (no level jumps like h1→h3)
- Image alt text (all images labeled or hidden)
- Form labels (all inputs have associated labels)
- ARIA attributes (proper use of ARIA roles/labels)
- Semantic HTML (nav, main, article, section, etc.)

**Tested files:**
- `index.html` (homepage)
- `dream-chat.html` (journal interface)
- `operations.html` (dashboard)

## GitHub Actions CI

Workflow: `.github/workflows/a11y-audit.yml`

Runs on every PR and push to `master` when public HTML files change.

**Steps:**
1. **Site Audit** — Validates all pages exist, generates sitemap
2. **A11y Tests** — WCAG compliance check
3. **Report** — Comments results on PR

**Comment includes:**
- ✓/✗ Test results
- Coverage checklist
- Link to generated sitemap

## Making Changes

### Adding a new page

1. Create the HTML file: `apps/lantern-garage/public/new-page.html`
2. Add link to `index.html`: `<a href="/new-page.html">Page Title</a>`
3. **Run locally first:**
   ```bash
   node scripts/audit-site.js
   node scripts/test-a11y.js
   ```
4. Push your PR — CI will validate

### Adding a new link to index.html

The page must exist. If linking to:
- **Local page** (e.g., `/settings.html`) — file must exist
- **External URL** (e.g., `https://example.com`) — automatically allowed
- **Redirect** (e.g., `/flourishing`) — add to `IGNORED_PATHS` in `audit-site.js`

### Fixing a11y issues

Common issues and fixes:

| Issue | Fix |
|-------|-----|
| Missing alt text on image | Add `alt="description"` or `aria-hidden="true"` |
| Input without label | Add `<label for="input-id">Label</label>` |
| Heading hierarchy jump (h1→h3) | Use h2 between them |
| Non-semantic HTML | Use `<nav>`, `<main>`, `<article>`, `<section>` |
| No ARIA labels on button | Add `aria-label="action"` |
| Images aren't tabbable | Use `<a href="..."><img .../></a>` or `<button>` |

## Standards & Compliance

### WCAG 2.1 Level AA

Covers:
- **Perceivable** — Content is perceivable (alt text, contrast, captions)
- **Operable** — Fully keyboard navigable, no keyboard traps
- **Understandable** — Clear language, consistent navigation
- **Robust** — Valid HTML, works with assistive technology

### Required for Lantern OS

- [ ] All pages reachable from homepage
- [ ] All interactive elements keyboard-accessible
- [ ] Heading hierarchy without jumps
- [ ] All images labeled or hidden
- [ ] All form inputs have associated labels
- [ ] Color contrast ≥4.5:1 (AA) for normal text
- [ ] Semantic HTML where applicable
- [ ] ARIA used correctly, not as substitute for semantic HTML

## Sitemap

**Generated:** `apps/lantern-garage/public/sitemap.xml`  
**Updated:** On every commit to public HTML files  
**Used by:** Search engines, automated crawlers

The sitemap lists all pages from `index.html` with:
- URL
- Last modified date
- Priority (1.0 for home, 0.8 for others)

## CI Integration

### Run tests locally before pushing

```bash
# Full audit
node scripts/audit-site.js
node scripts/test-a11y.js

# Both together
npm run audit 2>/dev/null || node scripts/audit-site.js && node scripts/test-a11y.js
```

### CI will fail the PR if:
- ✗ Index.html links to non-existent page
- ✗ Required heading levels are missing
- ✗ Form inputs lack labels
- ✗ Images lack alt text (unless marked decorative)
- ✗ Semantic HTML is not used where appropriate

### To unblock a PR

Fix the reported issue, commit, and push again. CI runs automatically.

## See Also

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
