feat(three-doors): splash-art landing rework — single viewport, shared header, CRT skin

The Three Doors landing (`/three-doors.html`) is rebuilt around the
"THREE DOORS — UNISONA" key art: the splash is now a full-bleed hero
with the title, tagline, fact chips, and Begin-Adventure CTA overlaid
on a scrim, and the readiness + four subsystem health indicators fold
into one compact status strip — the whole page fits a single viewport
(no scroll; small/short screens fall back to normal scrolling). The
page now carries the global shared header from index (unisona.ai
brand, full nav, profile/logout/theme/screenshot actions) and honors
the opt-in Terminal (CRT) skin via the pre-paint `keystone-skin`
bootstrap + `dream-chat-terminal.css`, with a CTA ink override for
phosphor contrast. Both game pages gain `og:image`/`twitter:image`
meta so shared links thumbnail with the art; the asset ships as webp
(`public/assets/three-doors-splash.webp`) to stay off the LFS-tracked
extensions. Also fixes a pre-existing SyntaxError in the health
script (`dot?.className = …` is an invalid assignment target) that
had silently killed the readiness updates and theme toggle on this
page. Improves the Act stage (game surface presentation).
Verified live on the lantern-verify preview: no scroll at desktop and
375×812, health strip live-updates from `/api/health`, theme toggle
works, CRT tokens apply, zero console errors.
