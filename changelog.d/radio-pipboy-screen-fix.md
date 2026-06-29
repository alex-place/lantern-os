### Keystone Radio — fix Pip-Boy screen losing its CRT effects

- The Pip-Boy reskin put a `.bracket` corner-frame class on the now-playing screen, but that element already uses `::before`/`::after` for its scanlines and vignette — so the bracket rules hijacked both pseudo-elements and the screen lost its CRT glass. Dropped `.bracket` from the screen (the dial keeps it) and gave the screen a brighter phosphor frame instead; scanlines + vignette restored.
