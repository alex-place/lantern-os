---
workflow: general-video
flow: automation
storyboard: no
aspect: "16:9"
resolution: 1920x1080
duration: ~66s
---

## Intent

A ~1-minute animated cut of the July 2026 Sigma Trader Report ("The July Leap") in its
comet-leap dark-cockpit style: the champion's 26-year arc drawn live, July's numbers,
where the next $20 goes, the road ahead, and the desk sign-off.

## Assets

- Narration: Gemini TTS via Vertex (user's explicit choice), voice Charon, one clip per
  scene for sync (assets/vo1..vo6.wav).
- BGM: synthesized ambient pad in the report's mood (assets/music.wav), ducked under VO.
- Chart data: pinned monthly series from scripts/reports/sigma_trader_report_2026_07.py
  (walk-forward run 2026-07-17).

## Notes (autonomous receipts)

- User unavailable mid-run: flow locked to automation, storyboard skipped.
- Every number on screen matches the published PDF (champion $91,537 / SPY drip $54,278 /
  paid-in $8,380 / -6.4% July / 24-for-24 / FOMC 7/28-29 / Alphabet+Tesla 7/22).
- Outro carries the practice-mode + not-advice disclaimer, as in the PDF footer.
