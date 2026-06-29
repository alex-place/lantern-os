### Added
- **Explore showcases** — a Kingdome of Hearts / Three Doors gallery (272 curated images, manifest-driven, lightbox preview) and a "Pencil Guy's Showcase by Gage" panel (BFDM video series + pixel-art sprites) on `explore.html`.
- **R2 media hosting** — showcase image/video bytes are served from Cloudflare R2 (`media.lantern-os.net`) via a tracked `manifest.json`; the bytes are gitignored so they never bloat the repo. Sync via `scripts/sync-media-r2.sh`; see `docs/MEDIA-HOSTING-R2.md`.
- **Canonical character lore** — `docs/lore/CAST.md` plus Lantern/Blinkbug/Keystone persona appearance updates and canonical reference art.
- **Tests** — `npm run test:showcase` (static-mime MIME contract, manifest invariants, jsdom gallery render + lightbox regressions).

### Fixed
- Static server now returns `image/webp` for `.webp` (was `application/octet-stream`, which blocked `<img>`/`<video>` decoding under nosniff).
