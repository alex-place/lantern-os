# The July Leap - video edition (2026-07)

A ~66s 16:9 (1920x1080) animated cut of the July Sigma Trader Report, built with
[HeyGen HyperFrames](https://github.com/heygen-com/hyperframes) (HTML + GSAP ->
headless-Chrome frames -> FFmpeg), narrated by **Gemini TTS** on Vertex, over a
synthesized ambient bed. Output ships at
`apps/lantern-garage/public/reports/sigma-trader-report-2026-07.mp4`.

Every on-screen number matches the published PDF (walk-forward run 2026-07-17:
champion $91,537 / plain S&P drip $54,278 / paid-in $8,380 / July -6.4% /
24-for-24 badge / board marks of Friday 7/17).

## Rebuild

```bash
# 1) narration (6 clips; needs Google ADC with Vertex access - project 843848914143)
python make_narration.py            # writes assets/vo1..vo6.wav (Gemini 2.5 Flash TTS, voice Charon)

# 2) music bed (offline, deterministic)
python make_music.py                # writes assets/music.wav (66.5s pad, Am9-F-C-Gadd9)

# 3) render (Node 22+; FFmpeg on PATH)
npm run check                       # hyperframes lint/runtime/motion/contrast gate
npm run render                      # writes the MP4
```

Scene timing is locked to the measured VO durations (7.29 / 13.69 / 14.81 /
11.17 / 11.25 / 5.61s): scenes start at 0 / 7.9 / 21.9 / 37.0 / 48.5 / 60.1.
If you regenerate narration, re-measure and update both `index.html` audio tags
and the timeline constants. BGM ducks under each VO via timeline volume tweens.
