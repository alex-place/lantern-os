# Internationalization (I18n) & Localization (L10n) Guide

## Overview

Lantern OS supports multiple languages through a JSON-based locale system. This guide explains how to add and maintain translations.

## Supported Languages

- English (en) — Base language
- Spanish (es) — European/Latin American Spanish
- German (de) — German
- Japanese (ja) — Japanese

## File Structure

Locale files are stored in: `apps/lantern-garage/public/locales/[LANG].json`

Each file uses a nested JSON structure:

```json
{
  "nav": {
    "work": "Work label in the language",
    "trade": "Trade label",
    "create": "Create label"
  },
  "hero": {
    "title": "Title",
    "tagline": "Tagline"
  }
}
```

## Adding a New Language

1. **Create locale file**: Copy `locales/en.json` to `locales/[LANG].json`
2. **Translate all strings**: Maintain the exact same key structure
3. **Test**: Verify layout doesn't break (some languages use more space)
4. **Update browser detection**: Add to language selector component
5. **Document**: Update this file with the new language

## Translation Guidelines

- **Tone**: Match original tone (professional, accessible)
- **Context**: Maintain meaning, not literal translation
- **Length**: Account for expansion (German ~20% longer than English)
- **Icons**: Keep emoji consistent across languages
- **Abbreviations**: Use language-appropriate abbreviations

### Examples

**Good Translation:**
```json
{
  "en": "Chat with an AI that remembers your journal",
  "es": "Chatea con una IA que recuerda tu diario"
}
```

**Too Literal:**
```json
{
  "es": "Platica con un inteligencia artificial que memoriza tu diario"
}
```

## Locale-Aware Formatting

Use JavaScript `Intl` API for dates, numbers, currency:

```javascript
// Dates
new Intl.DateTimeFormat('es-ES').format(new Date())
// Output: "15/6/2026"

// Numbers
new Intl.NumberFormat('de-DE').format(1234.56)
// Output: "1.234,56"

// Currency
new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' }).format(1000)
// Output: "¥1,000"
```

## RTL Languages (Future)

For right-to-left languages (Arabic, Hebrew):

1. Add `dir="auto"` to HTML root
2. Use CSS logical properties:
   ```css
   padding-inline-start: 1rem;  /* Instead of padding-left */
   padding-inline-end: 1rem;    /* Instead of padding-right */
   ```
3. Reverse nav direction
4. Test layout thoroughly

## Browser Detection & Language Selection

The system should:
1. Detect browser language via `navigator.language`
2. Fall back to English if language not supported
3. Provide language selector in settings
4. Persist choice to localStorage

## Testing Translations

Before submitting:

1. **Visual test**: Run page in target language, check layout
2. **String length**: Verify no text truncation
3. **Icons**: Ensure emoji render correctly
4. **Links**: Verify all URLs still work
5. **Screen reader**: Test with translator present

## Contributing Translations

If you want to add or improve translations:

1. Fork the repository
2. Create a branch: `feature/i18n-[LANG]`
3. Translate `locales/[LANG].json`
4. Test thoroughly
5. Submit PR with description of your language additions

---

For questions, open a GitHub issue
