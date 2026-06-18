# Facecam Detection + Top-Locking

**Date:** 2026-06-18
**Goal:** Detect the facecam reliably, then **lock it to the top** of the final vertical render.

## The teaching that drove this

A facecam is **a separate video overlaid on top of the gameplay** — a stable rectangle composited onto the frame. So its true signature is not "skin-coloured pixels"; it's a **seam**: a sharp, straight brightness discontinuity where the webcam box meets the game, bounding a region with its own independent content.

## What was wrong

`safe-zone-v2.js` scored four fixed quarter-frame corner blocks and weighted **skin highest (0.55)**. On a real (dark) gameplay clip the skin cue **misfired on an empty dark corner** and put the facecam box in the **wrong corner**, over nothing.

| | Detected corner | Box on the facecam? |
|---|---|---|
| **Before** | bottom-right | ❌ empty darkness |
| **After** | bottom-left | ✅ on the webcam, tight box |

## The fix — detection (`safe-zone-v2.js`)

Replaced corner-block scoring with `bestFacecamRect()`, which **searches for the overlay rectangle by its seam**:

- Anchored to a left/right edge (facecams hug a side), the vertical extent **floats** — every `[r0,r1)` band is tried and bounded by its **top and bottom seams**, so the box hugs the real cam instead of stretching to the frame corner.
- Score = `0.58·seam + 0.24·interiorMotion + 0.18·distinctness` (all normalized per-video). Skin is gone as a primary cue.
- Honest tiers preserved: ≥0.45 confident · 0.25–0.45 `needsDeclaration` · <0.25 nothing. Never fabricates a detection (returns `unavailable` if ffmpeg can't read the source).

Verified on a real clip: bottom-left, `confidence 0.64`, `seam 0.895`, box tightly hugging the webcam (checked with the built-in `renderSafeZoneOverlay` debug image).

## The fix — top-locking (`video-export.js`, `job-worker.js`)

New **`facecam-top`** layout: the detected facecam rect is lifted into a top band (~22%, even-height) and the gameplay is stacked beneath it (the standard gaming-short layout), via a shared `facecamTopChain()` filter used by **both** renderers:

- `reencodeToShortForm` (single clip) and `renderSegments` (highlight cut-list / concat).

Wired into the live job (`job-worker.js`): when a **confident** facecam is detected, an explicit `facecam-top` request **or any crop-mode export** upgrades to the split layout and locks the cam to the top. `facecam-top` with no confident facecam falls back to `crop`/`pad` — never a broken split.

`render-pipeline-v2.js` (unused/aspirational) previously **rejected** segments whose facecam wasn't already at the top; corrected to recognize that the render **relocates** it (placement is enforced, not required of the source).

## Verification (real video, ffmpeg 8.1)

- Detection overlay: box on the facecam (bottom-left), tight.
- `facecam-top` single render → `1080×1920`, face framed in the top band, gameplay below.
- `facecam-top` segment render (2 segments) → `1080×1920`.
- Regression: normal `pad` export still `1080×1920`.

## Known follow-ups

- The box can include a little dark margin beside the cam (horizontal tightening) — fine for the top band, could be refined.
- The top-band crop is centred; a face-biased crop offset would frame heads slightly better.
- Detection is a single-best-rectangle heuristic (no multi-cam, no true face model) — consistent with the module's "honest heuristic, not a face recognizer" boundary.
