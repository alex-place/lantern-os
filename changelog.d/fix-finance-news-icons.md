### Fixed — finance news card icons no longer zoomed/pixelated

Two issues on the Explore Finance feed:
- **Generic Yahoo banner used as an "article image".** Yahoo RSS attaches a ~354×50
  `yahoo_finance_en-US_…png` wordmark as the item image; rendered as a cover it upscaled +
  cropped into an ugly zoom. `financeCards` now rejects these (and other `default`/`logo`
  placeholders) via `JUNK_NEWS_IMAGE`, falling back to the ticker logo or generated cover.
- **Company logos rendered cover-cropped.** The logo-tile classifier tagged opaque logos
  `is-logo-filled` → `object-fit: cover`, upscale-cropping small marks (the "zoomed in and
  pixelated" look). Logos now always CONTAIN; only the tile shade is chosen from the logo's
  background brightness (`is-logo-ownbg` for opaque marks). Verified in preview: 0 cover
  logos, 0 junk banners.
