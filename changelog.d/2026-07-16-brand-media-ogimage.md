### Added

- brand/media: README demo screenshots + a real og-image, and the missing brand asset restored (1.11 polish pass).
  - **`sigma0-mandala.svg` restored** (#2528): the brand guidelines' documented hero motif was 404 — the asset had been accidentally swept out twice by unrelated commits (restored in `aa63601f`, deleted again by `c61264e9`). Recovered the 18KB original into `apps/lantern-garage/public/`.
  - **README demo media** (#2533): real dream-chat screenshots (light + dark, captured from the running stable server at 1280×800@2x via Playwright) now sit under the README tagline in a `<picture>` element that follows the reader's color scheme. Stored in `docs/media/` (small brand assets are in-repo; R2 remains for gallery media).
  - **og-image** (#2533): a branded 1200×630 raster (`/og-image.png` — mandala lockup + tagline + loop motto, dark theme tokens, sigma0-mandala ambient motif) rendered from brand tokens. Wired `og:image` + `twitter:card=summary_large_image` into index (replacing the SVG that social crawlers can't unfurl), dream-chat, pricing, proof, faq, and whats-new.
