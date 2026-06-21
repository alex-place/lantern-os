---
author: Alex Place
created: 2026-06-08
updated: 2026-06-20
---

# Keystone OS — UX & Wording Standards

Applied to all pages. Updated 2026-06-08.

---

## Visual Design Standards

### Spacing & Layout
- **Hero section:** 56px top padding, 40px bottom padding
- **Section labels:** 44px top margin, 16px bottom margin
- **Section blocks:** 40-44px bottom margin
- **Grid gaps:** 12px for cards, 16px for larger blocks
- **Max width:** 880px content area
- **Padding:** 20px horizontal on all sides

### Typography
- **Hero title:** 1.9rem–2.8rem (responsive), 800 weight, -0.03em letter spacing
- **Section labels:** 0.72rem, 700 weight, 0.1em letter spacing, UPPERCASE
- **Card titles:** 1.05rem, 700 weight
- **Card descriptions:** 0.84rem, muted color
- **Labels/small text:** 0.75-0.76rem, 600 weight, 0.05-0.08em letter spacing

### Interactive Elements
- **Panel hover:** Border changes to accent color, background to surface2, translateY(-2px), shadow-hover
- **Metric cards:** Hover border-color to accent
- **Links:** Color is accent (cyan), no underline by default, underline on hover
- **Buttons:** Smooth transitions (0.15s), clear hover states

### Color Palette (Current)
- **Accent (Light):** #0ea5e9 (sky blue)
- **Accent (Dark):** #06b6d4 (cyan)
- **Accent Hover (Light):** #06b6d4
- **Accent Hover (Dark):** #0891b2
- **Accent Dim (Light):** #cffafe
- **Accent Dim (Dark):** #164e63
- **Green:** #10b981 (light), #34d399 (dark) — for positive status
- **Muted:** #6b7280 (light), #9ca3af (dark)
- **Surface:** #f8f9fa (light), #111827 (dark)

---

## Wording Standards

### Tone & Voice
✓ **Hopeful, not toxic** — acknowledge challenges, highlight solutions and progress
✓ **Action-oriented** — "What would you like to do?" not "Here's what you should know"
✓ **Conversational** — avoid jargon, explain concepts simply
✓ **Evidence-based** — all claims can be linked to sources or research
✓ **Present-tense and relatable** — "Right Now" not "Dashboard Status"
✓ **Lead with benefits** — "Conservation works" before "Species are declining"

### Section Naming
- **Hero section:** Positive, question-driven
  - ✓ "Is the world flourishing?" 
  - ✓ "Your dreams. Your data. Your Lantern."
  - ✗ "System Status" or "Current Status"

- **Action sections:** User-focused
  - ✓ "What would you like to do?"
  - ✓ "Start here"
  - ✗ "Features" or "Available Tools"

- **Info sections:** Present-tense
  - ✓ "Right Now" (measurements)
  - ✓ "How Different Groups Are Doing"
  - ✗ "Live Data" or "Current Metrics"

### Description Format
**Max 2-3 sentences per panel.** Structure:

1. **Lead with benefit or action** — Why should the user engage?
2. **Clarify the experience** — What will they find or do?
3. **Optional tagline or emotion** — How will it feel?

Examples:
- ✓ "Record what you remember, talk to an AI companion, and build your private dream archive. Everything stays on your computer."
- ✓ "Real-time data on human wellbeing, animal welfare, and ecosystem health—updated every few seconds."
- ✗ "View the current system status and metrics dashboard with live telemetry"

### Label Capitalization
- **Section labels:** UPPERCASE (0.72rem, accent color)
- **Card labels:** UPPERCASE (0.65-0.68rem, accent color)
- **Titles:** Title Case (normal H2/H3)

### Framing Challenges
When discussing problems, pair with solutions:

| Problem | Framing |
|---------|---------|
| Wildlife declining 68% | "Wildlife down 68% since 1970. Conservation actually works—species recover when protected." |
| Mental health rising | "Mental health challenges increasing in wealthy nations. Improving in some younger demographics." |
| Inequality growing | "Inequality growing, limiting real freedom. But extreme poverty is declining globally." |

---

## Component Standards

### Panels (Clickable Cards)
```
Icon (28px)
Label (0.65rem, UPPERCASE, cyan)
Title (1.05rem, 700)
Description (0.84rem, muted, 1.55 line-height)
Arrow (0.8rem, cyan, "→" or "Visit →")
```
**Hover:** Border cyan, background surface2, translateY(-2px), shadow-hover

### Metric Cards
```
Label (0.75rem, UPPERCASE)
Value (2.2rem, 800, accent)
Note (0.76rem, muted, with link)
```
**Hover:** Border cyan, shadow-hover

### Section Label
```
0.72rem, 700 weight
0.1em letter spacing
UPPERCASE
Accent color (cyan)
44px top margin
16px bottom margin
```

### Hero Section
```
Icon (52px)
Title (1.9-2.8rem responsive, 800, -0.03em spacing)
Tagline (1rem, muted, max 540px)
CTA buttons (if applicable)
```

---

## Testing Checklist

- [ ] All text is scannable (headings stand out, descriptions are brief)
- [ ] Color contrast passes WCAG AA (4.5:1 minimum for text)
- [ ] Hover states are obvious and smooth
- [ ] Typography hierarchy is clear (title > subtitle > body > note)
- [ ] Links are labeled and underlined on hover
- [ ] Spacing is consistent (multiples of 4px or 8px)
- [ ] Tone is hopeful and action-oriented
- [ ] No jargon without explanation
- [ ] Descriptions are 2-3 sentences max
- [ ] All claims link to evidence

---

## When to Deviate

Okay to deviate when:
- ✓ Accessibility requires it (contrast, sizing, etc.)
- ✓ Brand identity demands it (logo, hero style, special pages)
- ✓ Technical constraints force it (mobile, performance)

Not okay to deviate when:
- ✗ "It looks nicer"
- ✗ "I prefer this wording"
- ✗ Readability or tone suffers

**When in doubt, ask:** Does this improve clarity, accessibility, or action? If yes, consider deviating. If no, follow standards.

---

**Last updated:** 2026-06-08  
**Applied to:** Flourishing Dashboard (initial pass), Index.html (pending)
