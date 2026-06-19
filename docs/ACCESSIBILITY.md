# Accessibility (WCAG 2.1 AA) Standards

## Overview

Lantern OS is committed to WCAG 2.1 Level AA compliance, ensuring usability for all people, including those with disabilities.

## Current Status (Phase 1 Complete)

### ✅ Implemented

- **Skip-to-content link**: Visible on focus, jumps to main content
- **Focus indicators**: 3px solid outline with 2px offset (high contrast)
- **Keyboard navigation**: All interactive elements accessible via Tab/Enter/Escape
- **ARIA labels**: Status indicators, live regions for updates
- **Prefers-reduced-motion**: Respects user animation preferences
- **Semantic HTML**: Proper heading hierarchy, nav landmarks, role attributes
- **Color contrast**: WCAG AA minimum (4.5:1) in light/dark modes

### ⚠️ In Progress (Phase 2)

- [ ] Form validation feedback (clear error messages)
- [ ] Alt text for decorative vs. meaningful icons
- [ ] Color-not-only status indicators (paired with text)
- [ ] Link purpose clarity (full text labels)
- [ ] Heading structure validation (h1 per page)

### 📋 Planned (Phase 3)

- [ ] High-contrast mode support
- [ ] Dyslexia-friendly font option (OpenDyslexic)
- [ ] Adjustable text size (user setting)
- [ ] Captions for video content

## WCAG 2.1 Checklist

### Perceivable

- [x] Text contrast ≥4.5:1 (AA standard)
- [x] Images have alt text or are decorative (aria-hidden)
- [x] Color is not the only way to convey information
- [x] Content is readable and clear

### Operable

- [x] Keyboard accessible (Tab, Enter, Escape)
- [x] Focus visible and logical order
- [x] No keyboard traps
- [x] Skip links for navigation

### Understandable

- [x] Language declared (lang="en")
- [x] Consistent navigation (Work, Trade, Create)
- [x] Clear page labels and sections
- [ ] Form errors identified (in progress)

### Robust

- [x] Valid semantic HTML
- [x] ARIA roles and labels
- [x] Works with assistive technology

## Testing Guide

### Keyboard-Only Testing

1. Disconnect/disable mouse
2. Tab through all interactive elements
3. Use Enter to activate buttons/links
4. Use Escape to close dialogs/modals
5. Verify focus order makes sense (left-to-right, top-to-bottom)

**Tools:**
- Browser DevTools: Tab key, check focus outline
- Screen readers: NVDA (Windows), Narrator (Windows), VoiceOver (Mac)

### Color Contrast

Use [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/):
- Foreground color: Copy from DevTools Inspector
- Background color: Check both light and dark modes
- Ratio should be ≥4.5:1 for normal text, ≥3:1 for large text

**Browser Extension:**
- WAVE (Web Accessibility Evaluation Tool)
- Axe DevTools
- Lighthouse (Chrome DevTools)

### Screen Reader Testing

**NVDA (Windows):**
```bash
# Download: https://www.nvaccess.org/
# Start: Just run the downloaded file
# Browse mode: Tab through content
# Read page: Insert+Down arrow
```

**VoiceOver (Mac):**
```bash
# Enable: System Settings > Accessibility > VoiceOver
# Use: VO+U to open rotor, navigate with arrow keys
```

### Automated Tools

Run in Chrome DevTools:

```javascript
// Lighthouse accessibility audit
// DevTools > Lighthouse > Accessibility
```

## Common Accessibility Issues & Fixes

### Issue: Focus indicators not visible

**Fix:**
```css
*:focus-visible {
  outline: 3px solid #0891b2;
  outline-offset: 2px;
}
```

### Issue: Buttons not keyboard accessible

**Fix:**
```html
<!-- Use <button> instead of <div> -->
<button onclick="handleClick()">Click me</button>

<!-- Or add role + keyboard handler -->
<div role="button" tabindex="0" onclick="handleClick()" onkeydown="if(event.key==='Enter') handleClick()">
```

### Issue: Icon buttons with no text label

**Fix:**
```html
<!-- Add aria-label -->
<button aria-label="Toggle theme">🌙</button>

<!-- Or use title attribute -->
<button title="Toggle light / dark mode">🌙</button>
```

### Issue: Status messages ignored by screen readers

**Fix:**
```html
<!-- Use aria-live="polite" -->
<div aria-live="polite" aria-atomic="true">
  <span id="status-label">Server online</span>
</div>
```

## Checklist for PR Review

Before submitting a PR with UI changes:

- [ ] Tab navigation works (no keyboard traps)
- [ ] Focus indicators visible on all interactive elements
- [ ] Link text is descriptive ("Click here" → "Open Dream Chat")
- [ ] All images have alt text (or aria-hidden if decorative)
- [ ] Color contrast ≥4.5:1 in light AND dark modes
- [ ] Form errors are associated with inputs
- [ ] Status updates use aria-live regions
- [ ] No auto-playing media or animations
- [ ] Respects prefers-reduced-motion
- [ ] Works with screen reader (tested or documented)

## Resources

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [WebAIM: Screen Readers](https://webaim.org/articles/screenreader_testing/)
- [MDN: ARIA](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA)
- [The A11Y Project](https://www.a11yproject.com/)

## Questions?

Contact: open a GitHub issue
Open an issue: https://github.com/alex-place/lantern-os/issues
