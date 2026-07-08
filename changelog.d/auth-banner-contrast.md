fix(auth): readable error/notice banner text in light theme

The sign-in success/info banner (and the error banner + field errors) used pale
text colours (`#bbf7d0` green, `#fca5a5` red) that only read against the dark
theme's dark card — on the light theme the "Confirm your email" green notice was
almost invisible. Default the banner text to dark shades that read on the light
tint (`#065f46` emerald, `#b91c1c` / `#dc2626` red) and restore the pale shades
under `html[data-theme="dark"]`. CSS-only, both themes now legible.
