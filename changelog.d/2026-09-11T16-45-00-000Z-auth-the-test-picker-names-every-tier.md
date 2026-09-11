### Fixed

- auth: **the test sign-in picker now names every tier it offers.** The server has offered `pilot` as an emulatable role since the roster grew, but the picker had no label for it, so the $200 tier rendered as a raw lowercase `pilot` button — and the legacy `founder` alias (#698) rendered as a second, identical "Pro" button next to the real one. `founder` is out of the picker roster (it's the same tier as Pro; header emulation of it was used nowhere), and the five buttons now read exactly as the ladder is sold: **Free, Pro, Pilot, Admin, Tech Support**.

- auth: **the test picker's buttons were near-invisible in light mode.** Each role button carried an inline `color: var(--fg, #e5e7eb)` — a token `auth.html` never defines — so light mode fell back to near-white text on the page's near-white `--surface`, and the whole panel read as disabled. The buttons now style through the page's real `site.css` tokens (`--surface`/`--text`), which flip with the theme.

### Added

- auth: **"Continue with Google (test)" in the test sign-in panel.** The server's `test-login` has always accepted `{ role, provider }` to emulate an SSO session, but no UI exposed it — and the REAL Google button is hidden on any server without `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (#1877), which is every local box. The test panel now carries a Google-branded button that mints exactly what a first-time real Google sign-in produces (Free tier, `provider: "google"`), so the SSO path is clickable locally with no OAuth round-trip and no client secret. Covered by a new `test:auth` E2E case.
