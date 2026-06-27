### Keystone Radio — 25 stations + performance pass

- `/fallout-radio.html` grew from 19 to **25 stations** — added 6 more Internet Archive Great 78 sides, served locally from `/radio/`: Glenn Miller's *Pennsylvania 6-5000* and *Don't Sit Under the Apple Tree*, *Sentimental Journey*, *Blue Moon*, *Heartaches*, and *I'll Be Seeing You*.
- **Performance**: all tracks re-encoded to **96 kbps mono** (transparent for these band-limited 78rpm sources) — the served audio footprint dropped from ~96 MB to ~62 MB *while adding 6 songs*, so tracks start faster. The visualizer's `requestAnimationFrame` loop now runs only while audio is playing **and** the tab is visible (Page Visibility API); paused or backgrounded it draws one idle frame and stops — no animation-frame churn or battery drain.
- Roadmap updated in [docs/fallout-radio-backlog.md](docs/fallout-radio-backlog.md).
