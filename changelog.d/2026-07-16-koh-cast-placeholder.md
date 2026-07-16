### Fixed

- images: the Three-Doors landing no longer shows four broken-image icons (#2494). The hand-drawn cast references are named in the KOH manifest but were never uploaded anywhere (404 locally AND on the CDN), so the cards now point at the canonical CDN location and hide themselves on error — they light up automatically once the scans are uploaded. The Creator grid's thumbnail fallback now exists as `/placeholder.svg` (SVG because `*.png` is LFS-declared against an unprovisioned endpoint), with a loop-guarded `onerror`.
