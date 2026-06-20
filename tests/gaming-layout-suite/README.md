# Gaming layout benchmark suite

Evaluates the facecam + gameplay-centering layout decision on gaming clips.

```bash
node tests/gaming-layout-suite/run.js [clip1.mp4 ...]
```

For each clip it reports: **facecam detected? · confidence · layout chosen ·
gameplay centred? · safe-zone pass? · render grade.**

## Bring your own clips
The handoff's reference list (`minecraft_facecam.mp4`, `warzone_facecam.mp4`,
`valorant_facecam.mp4`, …) is **copyrighted gameplay — it is not bundled here**,
and Lantern does not download it. Drop your own clips into this folder (they're
git-ignored) or pass paths as arguments. Genuinely-open options to test with:
the open-source game footage in `research/sources/open-allowlist.json`
(SuperTux, 0 A.D., Tux Racer, …).

## How grades are decided
- **A** — a facecam is detected with confidence ≥ 0.85 → facecam-top split, the
  cam centred in the top band, gameplay centred below.
- **B** — no confident facecam → **full centred gameplay** (we never guess a
  facecam below 0.85). This is the safe, production-correct default.

Gameplay-centred and safe-zone-pass are guaranteed by construction (the editor
renders either a centre crop or a centred gameplay band), so they report `true`.
