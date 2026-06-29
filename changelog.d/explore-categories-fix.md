### Fixed — Explore feed categories

- **Films & music now have the right filters.** Public-domain films join **Watch** and jazz/classical/radio get a new **🎵 Listen** filter, instead of every embed hiding under **Play** (`embedCards()` derives the chip category from topics).
- **Docs filter shows the whole library** (45+ indexed docs), not a slice of 8.
- **Small categories no longer duplicate on scroll.** A filtered category that fits one page (e.g. Watch) stops with a "that's everything" message instead of re-stacking the same cards as the endless feed cycled.
- **2048 self-hosted.** The lone cross-origin `github.io` embed (which could be blocked by the prod frame policy) is now served same-origin from `/games/2048/` (MIT-licensed), like the bundled T-Rex.
- Fixed a mojibake (`Â·`) in the 2048 source label.
